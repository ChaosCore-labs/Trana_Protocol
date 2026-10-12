/**
 * Fullscreen viewer for diagrams that are too big to read in the content column.
 *
 * Mermaid lays a diagram out at its natural size and `pre.mermaid svg {
 * max-width: 100% }` scales it into the column. That is left alone: the whole
 * diagram stays visible on the page, which is what every docs site does and
 * what a reader expects to see before they decide to look closer. The end-to-end
 * sequence diagram is 1727 px wide and lands at 40%, so looking closer is the
 * part that needs help.
 *
 * Clicking such a diagram (or its expand affordance) opens it in a `<dialog>`
 * viewer: fitted to the whole diagram on open, then drag to pan, buttons or the
 * wheel to zoom, keyboard for both. This is the pattern the surrounding
 * ecosystem settled on — VitePress's own image zoom, and the mermaid viewer
 * plugins for VitePress, MkDocs and Obsidian all enlarge on click rather than
 * clipping the diagram on the page.
 *
 * A native `<dialog>` gives the modal behaviour for free: focus is trapped
 * inside it, Escape closes it, and focus returns to the diagram afterwards.
 */

/** Zoom bounds. 1 is the diagram's natural size. */
const MIN_SCALE = 0.1
const MAX_SCALE = 8
/** Multiplier per zoom step, for the buttons and the `+`/`-` keys. */
const ZOOM_STEP = 1.25
/** Sub-pixel slack before a diagram counts as wider than its column. */
const FIT_SLACK = 1
/**
 * Height at which a diagram earns the viewer on its own, even though it fits the
 * column. Above the usual diagram by a wide margin: a 542 px state diagram reads
 * fine on the page, and offering to enlarge it would be noise.
 */
const VIEWER_TRIGGER_HEIGHT = 900
/** Keyboard pan distance, in px. */
const KEY_PAN_STEP = 40

export interface NaturalSize {
  width: number
  height: number
}

/** The size mermaid laid the diagram out at, read from the svg's viewBox. */
export function naturalSize(svg: {
  getAttribute(name: string): string | null
}): NaturalSize | undefined {
  const viewBox = svg.getAttribute('viewBox')
  if (viewBox === null) return undefined
  const parts = viewBox.trim().split(/[\s,]+/).map(Number)
  const width = parts[2]
  const height = parts[3]
  if (
    width === undefined ||
    height === undefined ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return undefined
  }
  return { width, height }
}

/**
 * Whether a diagram is worth offering the viewer: the stylesheet shrinks it to
 * fit the column, or it is tall enough to be a chore to read in place.
 *
 * Decided from the drawn size, so it follows the page instead of an exceptions
 * list. Only diagrams that qualify become clickable — a small diagram must not
 * advertise a viewer that would show it no larger.
 */
export function needsViewer(natural: NaturalSize, boxWidth: number): boolean {
  return natural.width > boxWidth + FIT_SLACK || natural.height > VIEWER_TRIGGER_HEIGHT
}

/** The scale at which the whole diagram fits inside a viewport. Never upscales. */
export function fitScale(natural: NaturalSize, boxWidth: number, boxHeight: number): number {
  if (boxWidth <= 0 || boxHeight <= 0) return 1
  return Math.min(1, boxWidth / natural.width, boxHeight / natural.height)
}

interface Viewport {
  dialog: HTMLDialogElement
  stage: HTMLElement
  level: HTMLElement
  /** The svg on show, and how to put it back where it came from. */
  svg: SVGSVGElement | null
  natural: NaturalSize
  restore: () => void
}

let viewer: Viewport | undefined
const state = { scale: 1, x: 0, y: 0, fit: 1, moved: false }

function control(action: string, label: string, text: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'dz-button'
  button.dataset.action = action
  button.setAttribute('aria-label', label)
  button.title = label
  button.textContent = text
  return button
}

function stageWidth(): number {
  return viewer?.stage.clientWidth ?? 0
}

function stageHeight(): number {
  return viewer?.stage.clientHeight ?? 0
}

function apply(): void {
  if (viewer === undefined || viewer.svg === null) return
  viewer.svg.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.scale})`
  viewer.level.textContent = `${Math.round(state.scale * 100)}%`
}

/** Show the whole diagram, centred, at the largest scale that fits. */
function fit(): void {
  if (viewer === undefined || viewer.svg === null) return
  const width = stageWidth()
  const height = stageHeight()
  state.fit = fitScale(viewer.natural, width, height)
  state.scale = state.fit
  state.x = (width - viewer.natural.width * state.fit) / 2
  state.y = (height - viewer.natural.height * state.fit) / 2
  state.moved = false
  apply()
}

/** Zoom by a factor, keeping the anchor point (cursor, or centre) fixed. */
function zoom(factor: number, anchorX?: number, anchorY?: number): void {
  if (viewer === undefined || viewer.svg === null) return
  const floor = Math.max(state.fit, MIN_SCALE)
  const next = Math.min(MAX_SCALE, Math.max(floor, state.scale * factor))
  if (next === state.scale) return
  const x = anchorX ?? stageWidth() / 2
  const y = anchorY ?? stageHeight() / 2
  state.x = x - ((x - state.x) * next) / state.scale
  state.y = y - ((y - state.y) * next) / state.scale
  state.scale = next
  state.moved = true
  apply()
}

/** Build the viewer once, on first use, and keep it for the rest of the session. */
function ensureViewer(): Viewport {
  if (viewer !== undefined) return viewer

  const dialog = document.createElement('dialog')
  dialog.className = 'dz-viewer'
  dialog.setAttribute('aria-label', 'Diagram viewer')

  const bar = document.createElement('div')
  bar.className = 'dz-viewer-bar'

  // Lives in the bar rather than under the stage: in a fullscreen viewer the
  // drawing should get every pixel that is not a toolbar.
  const hint = document.createElement('span')
  hint.className = 'dz-viewer-hint'
  hint.textContent = 'Drag to pan · scroll to zoom · Esc to close'

  const level = document.createElement('span')
  level.className = 'dz-level'
  // Announce the zoom level to screen readers without stealing focus.
  level.setAttribute('aria-live', 'polite')

  const zoomOut = control('out', 'Zoom out', '−')
  const fitView = control('fit', 'Fit whole diagram', 'Fit')
  const zoomIn = control('in', 'Zoom in', '+')
  const close = control('close', 'Close viewer', '✕')
  close.classList.add('dz-viewer-close')

  bar.append(hint, zoomOut, fitView, zoomIn, level, close)

  const stage = document.createElement('div')
  stage.className = 'dz-viewer-stage'
  stage.tabIndex = 0
  stage.setAttribute('aria-label', 'Diagram. Drag to pan; plus or minus to zoom.')

  dialog.append(bar, stage)
  document.body.append(dialog)

  let drag: { id: number; x: number; y: number } | undefined

  stage.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY }
    stage.setPointerCapture(event.pointerId)
    stage.classList.add('dz-viewer-stage--dragging')
  })

  stage.addEventListener('pointermove', (event) => {
    if (drag === undefined || event.pointerId !== drag.id) return
    state.x += event.clientX - drag.x
    state.y += event.clientY - drag.y
    drag.x = event.clientX
    drag.y = event.clientY
    state.moved = true
    apply()
  })

  const release = (event: PointerEvent): void => {
    if (drag === undefined || event.pointerId !== drag.id) return
    drag = undefined
    stage.classList.remove('dz-viewer-stage--dragging')
    if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId)
  }
  stage.addEventListener('pointerup', release)
  stage.addEventListener('pointercancel', release)

  // Inside the modal there is no page scroll to protect, so the wheel can zoom
  // unconditionally. Ctrl is left to the browser, which is how a trackpad pinch
  // arrives and would otherwise be swallowed twice.
  stage.addEventListener(
    'wheel',
    (event) => {
      if (event.ctrlKey) return
      event.preventDefault()
      const rect = stage.getBoundingClientRect()
      zoom(
        Math.exp(-event.deltaY * 0.0015),
        event.clientX - rect.left,
        event.clientY - rect.top,
      )
    },
    { passive: false },
  )

  stage.addEventListener('keydown', (event) => {
    switch (event.key) {
      case '+':
      case '=':
        zoom(ZOOM_STEP)
        break
      case '-':
      case '_':
        zoom(1 / ZOOM_STEP)
        break
      case '0':
        fit()
        break
      case 'ArrowLeft':
        state.x += KEY_PAN_STEP
        state.moved = true
        apply()
        break
      case 'ArrowRight':
        state.x -= KEY_PAN_STEP
        state.moved = true
        apply()
        break
      case 'ArrowUp':
        state.y += KEY_PAN_STEP
        state.moved = true
        apply()
        break
      case 'ArrowDown':
        state.y -= KEY_PAN_STEP
        state.moved = true
        apply()
        break
      default:
        return
    }
    event.preventDefault()
  })

  zoomOut.addEventListener('click', () => zoom(1 / ZOOM_STEP))
  zoomIn.addEventListener('click', () => zoom(ZOOM_STEP))
  fitView.addEventListener('click', fit)
  close.addEventListener('click', () => dialog.close())

  // A click on the backdrop lands on the dialog element itself.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close()
  })

  dialog.addEventListener('close', () => {
    if (viewer === undefined) return
    viewer.restore()
    // The dialog is built once and kept for the session, so opening the next
    // diagram reuses it instead of stacking a second viewer in the DOM. A null
    // svg is what marks it as showing nothing.
    viewer.svg = null
  })

  // Keep the diagram fitted when the window changes size, until the reader has
  // positioned it themselves.
  const observer = new ResizeObserver(() => {
    if (viewer === undefined || viewer.svg === null || !viewer.dialog.open || state.moved) return
    fit()
  })
  observer.observe(stage)

  viewer = {
    dialog,
    stage,
    level,
    svg: null,
    natural: { width: 0, height: 0 },
    restore: () => {},
  }
  return viewer
}

/**
 * Open the viewer on a diagram that is already rendered on the page.
 *
 * The svg is *moved* rather than cloned: mermaid puts its stylesheet inside the
 * svg and scopes the rules to the svg's own `id`, so a clone would need every
 * selector rewritten and would duplicate that id in the document.
 */
function openViewer(svg: SVGSVGElement, natural: NaturalSize): void {
  const instance = ensureViewer()
  const parent = svg.parentElement
  const next = svg.nextSibling
  const inlineStyle = svg.getAttribute('style')

  // Natural size inside the viewer; the transform below does the scaling.
  svg.style.maxWidth = 'none'
  svg.style.width = `${natural.width}px`
  svg.style.height = `${natural.height}px`
  svg.style.transformOrigin = '0 0'

  instance.stage.append(svg)
  instance.svg = svg
  instance.natural = natural
  instance.restore = () => {
    svg.setAttribute('style', inlineStyle ?? '')
    // `next` is the block's expand button, which must stay after the svg. If a
    // re-render took that node out from under us, fall back to appending.
    if (parent !== null && parent.isConnected) {
      parent.insertBefore(svg, next !== null && parent.contains(next) ? next : null)
    }
    // Closing returns the reader to the diagram they were reading, whether the
    // viewer was opened by mouse or by keyboard. Mouse users see no ring: the
    // ring is on `:focus-visible`.
    if (parent instanceof HTMLElement) parent.focus()
  }

  instance.dialog.showModal()
  // The stage has no size until the dialog is on screen.
  fit()
  instance.stage.focus()
}

/**
 * Wire a rendered diagram up to the viewer, if it is big enough to need one.
 *
 * Call after mermaid has finished drawing: the decision reads the drawn size,
 * and anything measured mid-render would be a guess.
 */
export function enhanceDiagram(el: HTMLElement): void {
  const svg = el.querySelector('svg')
  if (svg === null) return
  if (el.dataset.viewer === 'true') return

  const natural = naturalSize(svg)
  if (natural === undefined) return
  if (!needsViewer(natural, el.getBoundingClientRect().width)) return

  el.dataset.viewer = 'true'
  // A diagram that opens a viewer is a button, and says so.
  el.tabIndex = 0
  el.setAttribute('role', 'button')
  el.setAttribute('aria-label', 'Open diagram in a fullscreen viewer')
  el.title = 'Click to open fullscreen'

  const open = (): void => openViewer(svg, natural)

  el.addEventListener('click', open)
  el.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    open()
  })

  // Mouse affordance, mirroring the copy button VitePress puts on code blocks.
  // Hidden rather than absent so it never enters the tab order or the
  // accessibility tree: assistive tech uses the block's own role and label.
  const expand = document.createElement('button')
  expand.type = 'button'
  expand.className = 'dz-expand'
  expand.tabIndex = -1
  expand.setAttribute('aria-hidden', 'true')
  expand.title = 'Open fullscreen'
  expand.textContent = '⤢'
  expand.addEventListener('click', (event) => {
    event.stopPropagation()
    open()
  })
  el.append(expand)
}
