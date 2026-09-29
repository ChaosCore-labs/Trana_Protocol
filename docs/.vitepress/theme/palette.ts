/**
 * Gruvbox Material palette — the single source of truth for the site theme.
 *
 * Values are taken verbatim from `gruvbox_material#get_palette()` in
 * sainnhe/gruvbox-material, using the default `material` foreground scheme and
 * the `hard` background variant: bg0 #1d2021 sits directly against the frame
 * colour bgDim #141617 with no step between them.
 *
 * The site is dark-only — no light counterpart, no appearance switch — so this
 * is the only palette in the codebase.
 *
 * `custom.css` repeats these literals (CSS cannot import TypeScript), and
 * `tests/theme.test.ts` asserts the two stay in sync.
 *
 * @see https://github.com/sainnhe/gruvbox-material
 */

export interface GruvboxPalette {
  // Background ramp
  bgDim: string
  bg0: string
  bg1: string
  bg2: string
  bg3: string
  bg4: string
  bg5: string
  /** Surfaces for highlights and diff lines */
  bgVisualRed: string
  bgVisualYellow: string
  bgVisualGreen: string
  bgVisualBlue: string
  bgVisualPurple: string
  bgDiffRed: string
  bgDiffGreen: string
  bgDiffBlue: string
  bgCurrentWord: string
  // Foreground
  fg0: string
  fg1: string
  // Accents
  red: string
  orange: string
  yellow: string
  green: string
  aqua: string
  blue: string
  purple: string
  // Neutrals (dim -> bright)
  grey0: string
  grey1: string
  grey2: string
}

/** Gruvbox Material **Dark Hard**. */
export const palette: GruvboxPalette = {
  bgDim: '#141617',
  bg0: '#1d2021',
  bg1: '#282828',
  bg2: '#282828',
  bg3: '#3c3836',
  bg4: '#3c3836',
  bg5: '#504945',
  bgVisualRed: '#442e2d',
  bgVisualYellow: '#473c29',
  bgVisualGreen: '#333e34',
  bgVisualBlue: '#2e3b3b',
  bgVisualPurple: '#3c333b',
  bgDiffRed: '#3c1f1e',
  bgDiffGreen: '#32361a',
  bgDiffBlue: '#0d3138',
  bgCurrentWord: '#32302f',
  fg0: '#d4be98',
  fg1: '#ddc7a1',
  red: '#ea6962',
  orange: '#e78a4e',
  yellow: '#d8a657',
  green: '#a9b665',
  aqua: '#89b482',
  blue: '#7daea3',
  purple: '#d3869b',
  grey0: '#7c6f64',
  grey1: '#928374',
  grey2: '#a89984',
}

/** Shiki theme name, and the value the `theme` export below is built under. */
export const themeName = 'gruvbox-material-dark-hard'
