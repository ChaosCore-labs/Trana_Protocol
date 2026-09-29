// Explicit extensions: Vite's config loader follows the graph that starts at
// config.mts and warns on extensionless imports (it resolves like Node ESM).
import type { GruvboxPalette } from './palette.ts'
import { palette, themeName } from './palette.ts'

/**
 * Shiki theme for code blocks, authored from the gruvbox material palette.
 *
 * Shiki ships `gruvbox-dark-hard`, which is the *original* gruvbox: its accent
 * hues differ from material (#fb4934 vs #ea6962 red, #b8bb26 vs #a9b665 green).
 * No `gruvbox-material-*` theme is published, so the scope map below is our own,
 * written against the languages this site actually shows (rust, ts, bash, json,
 * toml, yaml, markdown).
 */

interface TextMateRule {
  scope?: string | string[]
  settings: { foreground?: string; fontStyle?: string }
}

export interface TextMateTheme {
  name: string
  type: 'dark' | 'light'
  colors: Record<string, string>
  tokenColors: TextMateRule[]
}

function buildTheme(p: GruvboxPalette): TextMateTheme {
  const { fg0, grey0, grey1, grey2, red, orange, yellow, green, aqua, blue, purple } = p

  return {
    name: themeName,
    type: 'dark',
    colors: {
      'editor.background': p.bgDim,
      'editor.foreground': fg0,
      'editorLineNumber.foreground': grey0,
      'editorLineNumber.activeForeground': grey2,
      'editor.selectionBackground': p.bgVisualBlue,
      'editor.lineHighlightBackground': p.bgCurrentWord,
      'editorIndentGuide.background': p.bg3,
    },
    tokenColors: [
      { settings: { foreground: fg0 } },
      { scope: 'emphasis', settings: { fontStyle: 'italic' } },
      { scope: 'strong', settings: { fontStyle: 'bold' } },

      // Comments
      {
        scope: ['comment', 'punctuation.definition.comment', 'string.comment'],
        settings: { foreground: grey1, fontStyle: 'italic' },
      },

      // Strings — green, the gruvbox material string hue
      {
        scope: [
          'string',
          'string.quoted',
          'string.template',
          'meta.preprocessor.string',
          'markup.inline.raw',
        ],
        settings: { foreground: green },
      },
      { scope: ['string.regexp', 'constant.character.escape'], settings: { foreground: orange } },

      // Constants and numbers — purple
      {
        scope: [
          'constant',
          'constant.numeric',
          'constant.language',
          'support.constant',
          'variable.arguments',
        ],
        settings: { foreground: purple },
      },

      // Keywords and storage — red
      {
        scope: [
          'keyword',
          'keyword.control',
          'keyword.operator.new',
          'storage',
          'storage.type',
          'storage.modifier',
          'variable.language',
        ],
        settings: { foreground: red },
      },

      // Operators — orange
      {
        scope: ['keyword.operator', 'punctuation.definition.keyword'],
        settings: { foreground: orange },
      },

      // Functions — aqua
      {
        scope: [
          'entity.name.function',
          'support.function',
          'meta.function-call',
          'meta.require',
          'entity.name.tag',
          'punctuation.tag',
          'entity.name.selector',
          'meta.selector',
        ],
        settings: { foreground: aqua },
      },

      // Types, classes, attributes — yellow
      {
        scope: [
          'entity.name.type',
          'entity.name.class',
          'entity.name.struct',
          'entity.name.enum',
          'entity.name.trait',
          'support.type',
          'support.class',
          'storage.type.primitive',
          'entity.other.attribute-name',
        ],
        settings: { foreground: yellow },
      },

      // Variables
      {
        scope: ['variable', 'variable.other', 'meta.definition.variable'],
        settings: { foreground: fg0 },
      },
      { scope: ['variable.parameter', 'variable.other.member'], settings: { foreground: blue } },
      { scope: ['support.type.property-name', 'meta.object-literal.key'], settings: { foreground: green } },

      // Punctuation kept legible, brackets dimmed
      {
        scope: ['punctuation', 'punctuation.separator', 'punctuation.terminator'],
        settings: { foreground: grey2 },
      },
      {
        scope: ['punctuation.definition.block', 'punctuation.section', 'punctuation.definition.parameters'],
        settings: { foreground: grey1 },
      },

      // Preprocessor — orange
      {
        scope: ['meta.preprocessor', 'keyword.control.import', 'keyword.control.directive'],
        settings: { foreground: orange },
      },

      // Markdown
      { scope: ['markup.heading', 'entity.name.section'], settings: { foreground: orange, fontStyle: 'bold' } },
      { scope: ['markup.bold'], settings: { foreground: yellow, fontStyle: 'bold' } },
      { scope: ['markup.italic'], settings: { foreground: yellow, fontStyle: 'italic' } },
      { scope: ['markup.underline.link', 'string.other.link'], settings: { foreground: blue } },
      { scope: ['markup.quote'], settings: { foreground: grey1, fontStyle: 'italic' } },
      { scope: ['markup.inserted', 'markup.inserted.diff'], settings: { foreground: green } },
      { scope: ['markup.deleted', 'markup.deleted.diff'], settings: { foreground: red } },
      { scope: ['markup.changed'], settings: { foreground: purple } },

      // Diagnostics
      { scope: ['invalid', 'invalid.illegal'], settings: { foreground: red, fontStyle: 'bold' } },
      { scope: ['invalid.deprecated'], settings: { foreground: purple } },
    ],
  }
}

export const gruvboxShiki = buildTheme(palette)
