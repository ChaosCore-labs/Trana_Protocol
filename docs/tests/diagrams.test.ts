// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import mermaid from 'mermaid'
import { describe, expect, it } from 'vitest'
import { DOCS, group, sitePages } from './helpers'

interface Diagram {
  file: string
  fence: number
  source: string
}

/** Extract every ```mermaid fence, tracking its 1-based index within the file. */
function diagramsIn(page: string): Diagram[] {
  const text = readFileSync(join(DOCS, page), 'utf8')
  const found: Diagram[] = []
  const pattern = /^```mermaid[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm
  for (const match of text.matchAll(pattern)) {
    found.push({ file: page, fence: found.length + 1, source: group(match, 1).trim() })
  }
  return found
}

const diagrams = sitePages().flatMap(diagramsIn)

describe('mermaid diagrams', () => {
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' })

  it('finds diagrams to validate', () => {
    expect(diagrams.length).toBeGreaterThan(0)
  })

  it.concurrent.each(diagrams)('$file diagram $fence parses', async (diagram) => {
    await expect(mermaid.parse(diagram.source)).resolves.toBeDefined()
  })

  it('opens every diagram with a supported declaration', () => {
    const supported =
      /^(flowchart|graph|sequenceDiagram|stateDiagram-v2|classDiagram|erDiagram|journey|gantt|pie|mindmap|timeline|quadrantChart|block-beta|architecture-beta)\b/
    const offenders = diagrams.filter((diagram) => !supported.test(diagram.source))
    expect(
      offenders.map((d) => `${d.file}#${d.fence}`),
      'diagrams whose first line is not a recognized mermaid declaration',
    ).toEqual([])
  })

  it('does not repeat a diagram definition verbatim', () => {
    const seen = new Map<string, string>()
    const duplicates: string[] = []
    for (const diagram of diagrams) {
      const first = seen.get(diagram.source)
      if (first) duplicates.push(`${diagram.file}#${diagram.fence} duplicates ${first}`)
      else seen.set(diagram.source, `${diagram.file}#${diagram.fence}`)
    }
    expect(duplicates, 'duplicated diagram bodies (likely a copy-paste slip)').toEqual([])
  })
})
