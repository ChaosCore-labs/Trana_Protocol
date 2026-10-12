// markdown-it's default export is a value (a callable wrapper around the class),
// so the instance type and the render-rule signature come from its named type
// exports instead.
import type { MarkdownIt, RendererRule } from 'markdown-it'

export interface MermaidPluginOptions {
  /** Fence language that selects the mermaid renderer. */
  language?: string
}

/**
 * Turns ```mermaid fences into literal `<pre class="mermaid">` blocks.
 *
 * The theme enhancement in `.vitepress/theme/index.ts` finds these blocks on the
 * client and renders them with mermaid, so nothing mermaid-related is evaluated
 * during SSR and the raw definition stays readable when JavaScript is disabled.
 */
export function mermaid(md: MarkdownIt, options: MermaidPluginOptions = {}): void {
  const language = (options.language ?? 'mermaid').toLowerCase()
  const fallback: RendererRule =
    md.renderer.rules.fence ??
    ((tokens, idx, opts, _env, self) => self.renderToken(tokens, idx, opts))

  md.renderer.rules.fence = (tokens, idx, opts, env, self) => {
    // markdown-it only calls a render rule for an index inside `tokens`.
    const token = tokens[idx]
    if (token === undefined) return ''
    // Only the first info word selects the language; trailing metadata (as in
    // ```mermaid title="x") must not disable diagram rendering.
    const info = token.info.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
    if (info !== language) {
      return fallback(tokens, idx, opts, env, self)
    }

    // Entity-encode the braces as well: VitePress compiles markdown into a Vue
    // template, and a bare `{{ ... }}` inside a diagram would otherwise be
    // swallowed by mustache interpolation before mermaid ever sees it.
    const source = md.utils
      .escapeHtml(token.content.trim())
      .replace(/[{}]/g, (brace) => (brace === '{' ? '&#123;' : '&#125;'))

    return `<pre class="mermaid" aria-label="Mermaid diagram">${source}</pre>\n`
  }
}
