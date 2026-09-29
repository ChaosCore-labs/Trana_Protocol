import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DOCS, group } from './helpers'
import { palette, type GruvboxPalette } from '../.vitepress/theme/palette'

/**
 * Guards the gruvbox theme in two ways:
 *
 * 1. `custom.css` repeats palette literals (CSS cannot import TypeScript), so
 *    this asserts the two representations agree.
 * 2. Colour choices have to stay readable, so the key foreground/background
 *    pairs are checked against WCAG contrast minimums.
 */

const css = readFileSync(join(DOCS, '.vitepress/theme/custom.css'), 'utf8')

/** Collect `--var: value` declarations from the file's `:root` blocks. */
function parseVars(): Map<string, string> {
  const out = new Map<string, string>()
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const block of stripped.matchAll(/:root[^{]*\{([^}]*)\}/g)) {
    for (const declaration of group(block, 1).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      out.set(group(declaration, 1), group(declaration, 2).trim())
    }
  }
  return out
}

const vars = parseVars()

/** Follow `var(--x)` indirection down to the literal value it resolves to. */
function resolve(name: string): string {
  let value = vars.get(name) ?? ''
  for (let hop = 0; hop < 8 && value.startsWith('var('); hop++) {
    const [first = ''] = value.slice(4, -1).split(',')
    const reference = first.trim()
    value = vars.get(reference) ?? reference
  }
  return value
}

/** sRGB channel -> linear light, per WCAG 2.1. */
function channel(value: number): number {
  const c = value / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function luminance(hex: string): number {
  const normalized = hex.replace('#', '')
  const full =
    normalized.length === 3
      ? normalized
          .split('')
          .map((c) => c + c)
          .join('')
      : normalized
  const r = Number.parseInt(full.slice(0, 2), 16)
  const g = Number.parseInt(full.slice(2, 4), 16)
  const b = Number.parseInt(full.slice(4, 6), 16)
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrast(foreground: string, background: string): number {
  const a = luminance(foreground)
  const b = luminance(background)
  const [hi, lo] = a > b ? [a, b] : [b, a]
  return (hi + 0.05) / (lo + 0.05)
}

describe('palette matches custom.css', () => {
  /** var name -> palette field, for values that must stay literal-identical. */
  const literalMap: Record<string, keyof GruvboxPalette> = {
    '--vp-c-bg': 'bg0',
    '--vp-c-bg-alt': 'bgDim',
    '--vp-c-text-1': 'fg0',
    '--vp-c-divider': 'bg3',
    '--vp-c-gutter': 'bgDim',
    '--vp-c-neutral': 'fg0',
    '--vp-c-neutral-inverse': 'bg0',
  }

  it('agrees with the palette literals', () => {
    const mismatches: string[] = []
    for (const [name, field] of Object.entries(literalMap)) {
      const declared = vars.get(name)
      const expected = palette[field]
      if (declared !== expected) {
        mismatches.push(`${name}: css ${declared} != palette.${field} ${expected}`)
      }
    }
    expect(mismatches).toEqual([])
  })

  it('defines bg/alt/elv/soft backgrounds', () => {
    for (const name of ['--vp-c-bg', '--vp-c-bg-alt', '--vp-c-bg-elv', '--vp-c-bg-soft']) {
      expect(vars.get(name), name).toBeDefined()
    }
  })

  it('defines text-1/2/3', () => {
    for (const name of ['--vp-c-text-1', '--vp-c-text-2', '--vp-c-text-3']) {
      expect(vars.get(name), name).toBeDefined()
    }
  })

  it('gives every accent scale all four levels', () => {
    const accents = [
      'gray',
      'indigo',
      'purple',
      'green',
      'yellow',
      'red',
      'orange',
      'brand',
      'success',
      'tip',
      'note',
      'important',
      'warning',
      'caution',
      'danger',
    ]
    const missing: string[] = []
    for (const accent of accents) {
      for (const suffix of ['1', '2', '3', 'soft']) {
        const name = `--vp-c-${accent}-${suffix}`
        if (!vars.has(name)) missing.push(name)
      }
    }
    expect(missing).toEqual([])
  })

  it('keeps every accent -soft colour translucent', () => {
    // VitePress documents that -soft must carry alpha so accents can stack.
    // Accent scales only: `--vp-c-bg-soft` is a solid background by design.
    const opaque: string[] = []
    for (const [name, value] of vars) {
      if (!name.endsWith('-soft') || name.startsWith('--vp-c-bg-')) continue
      // Indirect definitions point at another translucent variable.
      if (value.startsWith('var(')) continue
      const translucent =
        /transparent/.test(value) || /rgba\([^)]*,\s*0?\.\d+\s*\)/.test(value)
      if (!translucent) opaque.push(`${name}: ${value}`)
    }
    expect(opaque).toEqual([])
  })

  it('is dark-only: no light palette and no `.dark` selectors', () => {
    // The site ships one appearance. A `.dark` block here would mean the palette
    // is split across two selectors and half of it would never apply.
    expect(css).not.toMatch(/^\s*\.dark\b/m)
    expect(css).not.toMatch(/--vp-c-bg:\s*#f9f5d7/)
  })
})

describe('contrast (WCAG 2.1)', () => {
  const bg = resolve('--vp-c-bg')

  it('keeps body text readable', () => {
    // AAA for primary text, AA for muted text.
    expect(contrast(palette.fg0, bg), 'text-1').toBeGreaterThanOrEqual(7)
    expect(contrast(resolve('--vp-c-text-2'), bg), 'text-2').toBeGreaterThanOrEqual(4.5)
    // text-3 is decorative (placeholders, caret); 3:1 is the graphic minimum.
    expect(contrast(resolve('--vp-c-text-3'), bg), 'text-3').toBeGreaterThanOrEqual(3)
  })

  it('keeps the link colour readable', () => {
    expect(contrast(resolve('--vp-c-brand-1'), bg), 'brand-1').toBeGreaterThanOrEqual(4.5)
  })

  it('keeps brand button text readable on the brand background', () => {
    // Regression guard: VitePress defaults this to `--vp-c-white`, which in this
    // palette is cream and drops to 3.3:1 on the brand green.
    const text = resolve('--vp-button-brand-text')
    expect(text).toBe(palette.bg0)
    expect(contrast(text, resolve('--vp-c-brand-3')), 'brand button text').toBeGreaterThanOrEqual(
      4.5,
    )
  })

  it('keeps each accent legible on the page', () => {
    const accents: Array<[string, string]> = [
      ['red', palette.red],
      ['orange', palette.orange],
      ['yellow', palette.yellow],
      ['green', palette.green],
      ['aqua', palette.aqua],
      ['blue', palette.blue],
      ['purple', palette.purple],
    ]
    const failures = accents
      .map(([name, hex]) => [name, contrast(hex, bg)] as const)
      .filter(([, ratio]) => ratio < 3)
      .map(([name, ratio]) => `${name}: ${ratio.toFixed(2)}`)
    expect(failures, 'accents need 3:1 to be usable for large text and borders').toEqual([])
  })
})
