import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { group } from './helpers'

/**
 * Guards each protocol's Component map against its program.
 *
 * The map is the one piece of documentation whose claims are structural rather
 * than textual, so nothing else covers it: `diagrams.test.ts` only checks that a
 * diagram parses, and `source-sync.test.ts` compares prose facts. An edge
 * pointing at the wrong account, or a missing one, is invisible to both — which
 * is how the map came to omit `PoolConfig` from four of the five handlers that
 * write it.
 *
 * Edges are re-derived here from the `#[derive(Accounts)]` structs: for every
 * instruction, each program-owned account it mutates or creates must appear as a
 * solid edge in the diagram, and the diagram may not claim an edge the structs
 * do not support.
 *
 * The `PROTOCOLS` table below is the suite's only per-protocol input.
 */

const DOCS = resolve(import.meta.dirname, '..')

interface Protocol {
  name: string
  /** Docs section directory under `docs/`. */
  docs: string
  /** Program source directory, relative to `docs/`. */
  src: string
  /** Rust account type -> node id in the diagram. */
  nodes: Record<string, string>
  /** The six instruction names. */
  instructions: string[]
  /** The one handler that reads config without writing it. */
  readOnly: string
  /** Total program-owned state accounts written across every handler. */
  totalWrites: number
}

const PROTOCOLS: Protocol[] = [
  {
    name: 'freight_delay',
    docs: 'freight_delay',
    src: '../freight_delay/programs/freight_delay/src',
    nodes: {
      PoolConfig: 'Config',
      LpPosition: 'LpPos',
      Policy: 'Policy',
      DeliveryReport: 'Report',
    },
    instructions: [
      'buy_policy',
      'deposit_capital',
      'initialize_pool',
      'report_delivery_milestone',
      'settle_policy',
      'withdraw_capital',
    ],
    readOnly: 'report_delivery_milestone',
    totalWrites: 10,
  },
]

/** Constraints that make a handler write the account it is attached to. */
const WRITE_FLAGS = /(^|[^\w:])(mut|init|init_if_needed)\b/

interface Account {
  name: string
  type: string
  attribute: string
}

/** The last type argument of `Account<'info, PoolConfig>`, else the type itself. */
function accountType(type: string): string {
  return /,\s*([A-Za-z0-9_]+)\s*>$/.exec(type)?.[1] ?? type
}

/**
 * Fields of an `#[derive(Accounts)]` struct, each with the attribute that
 * precedes it. Line-driven because attribute bodies contain `]` and `)` (in
 * `seeds = [.. as_ref()]`, for instance), so no single regex can bracket them.
 */
function parseAccounts(source: string, structName: string): Account[] {
  const body = new RegExp(`pub struct ${structName}<'info>\\s*\\{([\\s\\S]*?)\\n\\}`).exec(
    source,
  )?.[1]
  if (body === undefined) throw new Error(`no account struct ${structName}`)

  const accounts: Account[] = []
  let attribute: string[] = []
  let inAttribute = false

  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (inAttribute) {
      attribute.push(trimmed)
      if (trimmed.endsWith(')]')) inAttribute = false
      continue
    }
    if (trimmed.startsWith('#[')) {
      attribute.push(trimmed)
      if (!trimmed.endsWith(')]')) inAttribute = true
      continue
    }
    const field = /^pub\s+(\w+)\s*:\s*(.+),$/.exec(trimmed)
    if (field) {
      accounts.push({ name: group(field, 1), type: group(field, 2), attribute: attribute.join(' ') })
      attribute = []
    }
  }
  return accounts
}

describe.each(PROTOCOLS)('$name component map matches the account structs', (protocol) => {
  const SRC = resolve(DOCS, protocol.src)
  const readSrc = (file: string): string => readFileSync(join(SRC, file), 'utf8')
  const readDoc = (file: string): string =>
    readFileSync(join(DOCS, protocol.docs, file), 'utf8')

  const STATE_NODES = protocol.nodes

  /** lib.rs is the only place the instruction -> account-struct mapping exists. */
  const lib = readSrc('lib.rs')
  const instructionStructs = new Map(
    [...lib.matchAll(/pub fn (\w+)\(\s*ctx:\s*Context<(\w+)>/g)].map((match) => [
      group(match, 1),
      group(match, 2),
    ]),
  )

  /** Instruction -> program-owned state accounts it writes or creates. */
  function writesByInstruction(): Map<string, Set<string>> {
    const writes = new Map<string, Set<string>>()

    for (const [instruction, structName] of instructionStructs) {
      const source = readSrc(`instructions/${instruction}.rs`)
      const targets = new Set<string>()
      for (const account of parseAccounts(source, structName)) {
        const node = STATE_NODES[accountType(account.type)]
        if (node !== undefined && WRITE_FLAGS.test(account.attribute)) targets.add(node)
      }
      writes.set(instruction, targets)
    }
    return writes
  }

  /** Solid `-->|instruction| Node` edges in the Component map. */
  function diagramEdges(): Array<{ label: string; target: string }> {
    const fence = /```mermaid\n([\s\S]*?)```/.exec(
      readDoc('protocol/architecture.md'),
    )?.[1]
    if (fence === undefined) throw new Error('no mermaid fence on the architecture page')

    return [...fence.matchAll(/^\s*(\w+)\s*-->\|([^|]+)\|\s*(\w+)\s*$/gm)].map((match) => ({
      label: group(match, 2).trim(),
      target: group(match, 3),
    }))
  }

  const writes = writesByInstruction()
  const edges = diagramEdges()
  const nodeIds = new Set(Object.values(STATE_NODES))

  it('found every instruction and its state accounts', () => {
    expect([...instructionStructs.keys()].sort()).toEqual([...protocol.instructions].sort())
    // A floor, so a parser that silently extracts nothing cannot pass trivially.
    const total = [...writes.values()].reduce((sum, set) => sum + set.size, 0)
    expect(total).toBe(protocol.totalWrites)
  })

  it('draws an edge for every handler that writes program state', () => {
    const missing: string[] = []
    for (const [instruction, targets] of writes) {
      for (const target of targets) {
        if (!edges.some((edge) => edge.label === instruction && edge.target === target)) {
          missing.push(`${instruction} -> ${target}`)
        }
      }
    }
    expect(missing).toEqual([])
  })

  it('claims no edge the account structs do not support', () => {
    const phantom: string[] = []
    for (const edge of edges) {
      if (!nodeIds.has(edge.target)) continue
      if (!writes.get(edge.label)?.has(edge.target)) {
        phantom.push(`${edge.label} -> ${edge.target}`)
      }
    }
    expect(phantom).toEqual([])
  })

  it('labels every state edge with a real instruction', () => {
    const unknown = edges
      .filter((edge) => nodeIds.has(edge.target))
      .map((edge) => edge.label)
      .filter((label) => !instructionStructs.has(label))
    expect(unknown).toEqual([])
  })

  it('keeps the report handler reading config rather than writing it', () => {
    // The map's one read-only handler, and the edge that used to be wrong in
    // the opposite direction: the report handler must not appear as a Config
    // writer.
    expect(writes.get(protocol.readOnly)).toEqual(new Set(['Report']))
    expect(edges.some((edge) => edge.label === protocol.readOnly && edge.target === 'Config')).toBe(
      false,
    )
  })

  it('gives the two capital handlers the same state accounts', () => {
    // deposit_capital and withdraw_capital take an identical account set, so any
    // asymmetry between them on the map is a documentation bug by construction.
    expect(writes.get('deposit_capital')).toEqual(writes.get('withdraw_capital'))
  })
})
