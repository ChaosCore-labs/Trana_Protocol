import { describe, expect, it } from 'vitest'
import { fitScale, naturalSize, needsViewer } from '../.vitepress/theme/diagram-zoom'

/**
 * Covers the sizing arithmetic behind the fullscreen viewer.
 *
 * Whether a *particular* page diagram gets the viewer depends on the size
 * mermaid draws it at, which only a browser knows — `scripts/check-render.mjs`
 * asserts that end. What is testable here is the decision itself, and the scale
 * the viewer opens at: a viewer that opened at anything but "the whole diagram
 * fits" would hide part of the diagram it was opened to show.
 */

/** Minimal stand-in for the svg element, so the tests need no DOM. */
function svgWith(viewBox: string | null) {
  return { getAttribute: (name: string) => (name === 'viewBox' ? viewBox : null) }
}

/** A laptop-ish viewer: the dialog is capped at 1180x880. */
const VIEWPORT = { width: 1180, height: 820 }

describe('naturalSize', () => {
  it('reads the drawn size out of the viewBox', () => {
    expect(naturalSize(svgWith('0 0 1726.5 2733'))).toEqual({ width: 1726.5, height: 2733 })
  })

  it('ignores a viewBox origin offset', () => {
    // Mermaid emits offsets (e.g. the end-to-end sequence starts at -50 -10);
    // they shift the drawing, not its size.
    expect(naturalSize(svgWith('-50 -10 1726.5 2733'))).toEqual({ width: 1726.5, height: 2733 })
    expect(naturalSize(svgWith('4 4 496.0078125 542'))).toEqual({
      width: 496.0078125,
      height: 542,
    })
  })

  it('accepts comma-separated viewBoxes', () => {
    expect(naturalSize(svgWith('0,0,688,268'))).toEqual({ width: 688, height: 268 })
  })

  it('reports nothing for a missing or degenerate viewBox', () => {
    expect(naturalSize(svgWith(null))).toBeUndefined()
    expect(naturalSize(svgWith(''))).toBeUndefined()
    expect(naturalSize(svgWith('0 0 0 0'))).toBeUndefined()
    expect(naturalSize(svgWith('0 0'))).toBeUndefined()
  })
})

describe('needsViewer', () => {
  const COLUMN = 688

  it('offers the viewer for a diagram the column would shrink', () => {
    // The end-to-end sequence, drawn at 1727px in a 688px column.
    expect(needsViewer({ width: 1726.5, height: 2733 }, COLUMN)).toBe(true)
    // A 1275px sequence diagram is shrunk too, and gets the same treatment.
    expect(needsViewer({ width: 1275, height: 863 }, COLUMN)).toBe(true)
  })

  it('leaves a diagram that already fits alone', () => {
    // The two state machines and the gantt render at or below column width and
    // are shorter than the page-dominating threshold. Opening a viewer on one
    // would show it no larger than the page already does.
    expect(needsViewer({ width: 496.0078125, height: 542 }, COLUMN)).toBe(false)
    expect(needsViewer({ width: 436, height: 464 }, COLUMN)).toBe(false)
    expect(needsViewer({ width: 686, height: 268 }, COLUMN)).toBe(false)
  })

  it('treats a hairline overhang as fitting', () => {
    // Sub-pixel layout rounding must not flip a diagram into being clickable.
    expect(needsViewer({ width: COLUMN + 0.5, height: 100 }, COLUMN)).toBe(false)
    expect(needsViewer({ width: COLUMN + 2, height: 100 }, COLUMN)).toBe(true)
  })

  it('offers it for a tall diagram even when it fits the width', () => {
    // Nothing on the site is shaped like this today; the clause exists for a
    // diagram that fits the column but is still a chore to read in place.
    expect(needsViewer({ width: 600, height: 2733 }, COLUMN)).toBe(true)
  })

  it('shrinks the criterion with the column, so phones offer more', () => {
    const mobile = 320
    expect(needsViewer({ width: 436, height: 464 }, mobile)).toBe(true)
  })
})

describe('fitScale', () => {
  it('fits the whole diagram, on the limiting axis', () => {
    const natural = { width: 1726.5, height: 2733 }
    const scale = fitScale(natural, VIEWPORT.width, VIEWPORT.height)
    const fitted = { width: natural.width * scale, height: natural.height * scale }

    // The property the viewer exists for: nothing hangs outside the viewport.
    // Sub-pixel tolerance, because the scale is a float and the exact limit
    // lands on 819.9999… or 820.0000…001 depending on the arithmetic.
    expect(fitted.width).toBeLessThanOrEqual(VIEWPORT.width + 0.01)
    expect(fitted.height).toBeLessThanOrEqual(VIEWPORT.height + 0.01)
    // ...and it is the largest scale that achieves it.
    expect(fitted.height).toBeCloseTo(VIEWPORT.height, 2)
  })

  it('is limited by the width for a wide, short diagram', () => {
    const natural = { width: 1488, height: 259 }
    const scale = fitScale(natural, VIEWPORT.width, VIEWPORT.height)
    expect(natural.width * scale).toBeCloseTo(VIEWPORT.width, 5)
    expect(natural.height * scale).toBeLessThan(VIEWPORT.height)
  })

  it('never upscales a diagram smaller than the viewport', () => {
    expect(fitScale({ width: 436, height: 464 }, VIEWPORT.width, VIEWPORT.height)).toBe(1)
  })

  it('survives a viewport with no size yet', () => {
    // The dialog is measured before layout on a cold open.
    expect(fitScale({ width: 1726.5, height: 2733 }, 0, 0)).toBe(1)
  })
})
