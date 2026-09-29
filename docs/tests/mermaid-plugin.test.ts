import MarkdownIt from 'markdown-it'
import { describe, expect, it } from 'vitest'
import { mermaid } from '../.vitepress/plugins/mermaid'

/**
 * Regression cover for the markdown pipeline. Braces are the loaded gun here:
 * VitePress compiles markdown into a Vue template, so a literal `{ ... }`
 * reaching the compiler is parsed as an interpolation and fails the build.
 */

function render(source: string): string {
  return new MarkdownIt().use(mermaid).render(source)
}

describe('mermaid fence plugin', () => {
  it('turns a mermaid fence into a pre.mermaid block', () => {
    const html = render('```mermaid\nflowchart TD\n  A --> B\n```')
    expect(html).toContain('<pre class="mermaid"')
    expect(html).toContain('flowchart TD')
    expect(html).not.toContain('<code')
  })

  it('entity-encodes braces so Vue cannot interpolate them', () => {
    const html = render('```mermaid\nflowchart TD\n  A --> B{triggered?}\n```')
    expect(html).toContain('&#123;triggered?&#125;')
    expect(html).not.toContain('{')
    expect(html).not.toContain('}')
  })

  it('encodes braces in double-brace form', () => {
    const html = render('```mermaid\nflowchart TD\n  A --> B{"x"}\n```')
    expect(html).toContain('&#123;')
    expect(html).not.toMatch(/\{\{/)
  })

  it('escapes HTML in diagram source', () => {
    const html = render('```mermaid\nflowchart TD\n  A["<script>alert(1)</script>"]\n```')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('accepts the fence language case-insensitively', () => {
    const html = render('```Mermaid\nflowchart TD\n  A --> B\n```')
    expect(html).toContain('<pre class="mermaid"')
  })

  it('accepts trailing fence metadata', () => {
    const html = render('```mermaid title="t"\nflowchart TD\n  A --> B\n```')
    expect(html).toContain('<pre class="mermaid"')
  })

  it('leaves other languages alone', () => {
    const html = render('```rust\nlet x = 1;\n```')
    expect(html).toContain('<code class="language-rust">')
    expect(html).not.toContain('class="mermaid"')
  })

  it('leaves unfenced prose and inline code alone', () => {
    const html = render('Use `mermaid` inline, not as a block.')
    expect(html).toContain('<code>mermaid</code>')
    expect(html).not.toContain('class="mermaid"')
  })
})
