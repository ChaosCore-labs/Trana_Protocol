import type { Theme } from 'vitepress'
import DefaultTheme from 'vitepress/theme'
import { onMounted, onUnmounted, watch } from 'vue'
import { useRoute } from 'vitepress'
import { mermaidThemeVariables } from './mermaid'
import { enhanceDiagram } from './diagram-zoom'
import { palette } from './palette'
import './custom.css'

const SOURCE_ATTR = 'data-mermaid-source'
const SELECTOR = 'pre.mermaid'

let observer: MutationObserver | undefined
let scheduled: ReturnType<typeof setTimeout> | undefined

/** Diagrams that failed to render, so a broken definition cannot spin the observer. */
const failed = new WeakSet<Element>()

async function loadMermaid() {
  const { default: mermaid } = await import('mermaid')
  // Read the theme's own font stack so diagrams inherit site typography.
  const fontFamily =
    getComputedStyle(document.documentElement)
      .getPropertyValue('--vp-font-family-base')
      .trim() || 'sans-serif'

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'loose',
    // 'base' throws away mermaid's palette so every colour resolves from our
    // gruvbox themeVariables instead.
    theme: 'base',
    themeVariables: mermaidThemeVariables(palette, fontFamily),
    fontFamily,
    // Mermaid 12 defaults flowcharts to the ELK layout engine, which is a
    // separate ~1.4 MB lazily-fetched chunk. `dagre` ships inside the core
    // chunk already loaded, so flowchart pages stay near the base payload.
    flowchart: { layout: 'dagre' },
  })
  return mermaid
}

const theme: Theme = {
  extends: DefaultTheme,
  setup() {
    const route = useRoute()

    /**
     * Blocks that still need rendering.
     *
     * A rendered diagram contains an `<svg>`, so its presence is the only
     * reliable signal. Mermaid's own `data-processed` attribute is set *before*
     * it renders, so an early failure leaves that flag behind with no diagram —
     * trusting it would strand the block as raw text forever.
     */
    const pending = (): HTMLElement[] =>
      Array.from(document.querySelectorAll<HTMLElement>(SELECTOR)).filter(
        (el) =>
          !failed.has(el) && !el.querySelector('svg') && (el.textContent ?? '').trim().length > 0,
      )

    const render = async (): Promise<void> => {
      const nodes = pending()
      if (nodes.length === 0) return

      for (const el of nodes) {
        // Read through attributes, not `dataset`: a hyphenated `data-*` name is
        // not a legal `dataset` property key and throws on assignment.
        if (!el.hasAttribute(SOURCE_ATTR)) {
          el.setAttribute(SOURCE_ATTR, el.textContent ?? '')
        }
      }

      try {
        const mermaid = await loadMermaid()
        await mermaid.run({ nodes })
      } catch (error) {
        console.error('[docs] mermaid render failed', error)
        for (const el of nodes) failed.add(el)
        return
      }

      // The zoom stage is an enhancement, not part of rendering: a failure here
      // must not mark the diagram as broken, or the next pass would leave a
      // perfectly good diagram showing as raw text.
      for (const el of nodes) {
        try {
          enhanceDiagram(el)
        } catch (error) {
          console.error('[docs] diagram zoom unavailable', error)
        }
      }
    }

    /** Coalesce bursts of DOM changes into one render pass. */
    let inFlight: Promise<unknown> = Promise.resolve()
    const schedule = (): void => {
      if (scheduled !== undefined) return
      scheduled = setTimeout(() => {
        scheduled = undefined
        // Mermaid draws diagrams one at a time, so an overlapping pass would
        // collect the blocks the running pass has not reached yet and render
        // them twice. Chaining passes means each starts from a settled DOM.
        inFlight = inFlight.then(render, render)
      }, 0)
    }

    /** Restore the source of already-rendered diagrams, then re-render. */
    const rerender = (): void => {
      for (const el of document.querySelectorAll<HTMLElement>(`[${SOURCE_ATTR}]`)) {
        el.textContent = el.getAttribute(SOURCE_ATTR) ?? ''
        // The expand affordance lives inside the element, so wiping the content
        // takes it with it; clear everything that says it was built.
        delete el.dataset.viewer
        el.removeAttribute('role')
        el.removeAttribute('tabindex')
        el.removeAttribute('aria-label')
        el.removeAttribute('title')
        failed.delete(el)
      }
      schedule()
    }

    onMounted(() => {
      // VitePress mounts page content after the theme setup runs, and swaps it
      // again on every client-side navigation, so the work is driven by DOM
      // mutations rather than by mount timing.
      observer = new MutationObserver(schedule)
      observer.observe(document.body, { childList: true, subtree: true })
      schedule()
    })

    onUnmounted(() => {
      observer?.disconnect()
      observer = undefined
      if (scheduled !== undefined) clearTimeout(scheduled)
      scheduled = undefined
    })

    watch(
      () => route.path,
      () => {
        rerender()
      },
    )
  },
}

export default theme
