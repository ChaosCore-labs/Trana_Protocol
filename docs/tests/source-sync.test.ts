import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { group } from './helpers'

/**
 * Guards against documentation drift: every fact this site states about a
 * program is re-derived from that program's Rust source and compared.
 *
 * The `PROTOCOLS` table below is the suite's only per-protocol input: each entry
 * names the docs section and the crate it is checked against, plus the account
 * structs the section is expected to document.
 */

const DOCS = resolve(import.meta.dirname, '..')

interface Protocol {
  name: string
  /** Docs section directory under `docs/`. */
  docs: string
  /** Program source directory, relative to `docs/`. */
  src: string
  /** Account struct names, in `state.rs` declaration order. */
  accounts: string[]
}

const PROTOCOLS: Protocol[] = [
  {
    name: 'freight_delay',
    docs: 'freight_delay',
    src: '../freight_delay/programs/freight_delay/src',
    accounts: ['PoolConfig', 'LpPosition', 'Policy'],
  },
]

interface Field {
  name: string
  type: string
}

interface Struct {
  name: string
  fields: Field[]
}

function parseStructs(source: string): Struct[] {
  const structs: Struct[] = []
  for (const match of source.matchAll(/pub struct (\w+)\s*\{([^}]*)\}/g)) {
    const fields = [...group(match, 2).matchAll(/pub\s+(\w+)\s*:\s*([^,]+),/g)].map((field) => ({
      name: group(field, 1),
      type: group(field, 2).trim(),
    }))
    structs.push({ name: group(match, 1), fields })
  }
  return structs
}

/** Fixed-size layouts only; an unknown type is a hard failure, not a skip. */
const PRIMITIVE_SIZES: Record<string, number> = {
  Pubkey: 32,
  u128: 16,
  i128: 16,
  u64: 8,
  i64: 8,
  f64: 8,
  u32: 4,
  i32: 4,
  f32: 4,
  u16: 2,
  i16: 2,
  u8: 1,
  i8: 1,
  bool: 1,
}

function initSpaceOf(struct: Struct): number {
  let total = 0
  for (const field of struct.fields) {
    const size = PRIMITIVE_SIZES[field.type]
    if (size === undefined) {
      throw new Error(
        `Unknown field type '${field.type}' on ${struct.name}.${field.name} — teach PRIMITIVE_SIZES its size.`,
      )
    }
    total += size
  }
  return total
}

/** The `## ...` section of a markdown doc whose heading names `heading`. */
function sectionFor(doc: string, heading: string): string {
  const section = doc.split(/^## /m).find((part) => {
    const [headingLine] = part.split('\n')
    return headingLine?.includes(heading) ?? false
  })
  if (section === undefined) {
    throw new Error(`no '## ' section naming ${heading}`)
  }
  return section
}

describe.each(PROTOCOLS)('$name', (protocol) => {
  const SRC = resolve(DOCS, protocol.src)
  const readSrc = (file: string): string => readFileSync(join(SRC, file), 'utf8')
  const readDoc = (file: string): string =>
    readFileSync(join(DOCS, protocol.docs, file), 'utf8')

  const state = readSrc('state.rs')
  const errors = readSrc('error.rs')
  const constants = readSrc('constants.rs')
  const lib = readSrc('lib.rs')
  const events = readSrc('events.rs')

  const accountStructs = parseStructs(state)
  const eventStructs = parseStructs(events)
  const instructionNames = [...lib.matchAll(/pub fn (\w+)\(\s*ctx:\s*Context<(\w+)>/g)].map(
    (match) => match[1],
  )
  const errorVariants = [
    ...(/pub enum \w*Error\s*\{([^}]*)\}/.exec(errors)?.[1] ?? '').matchAll(
      /^\s*(\w+),\s*$/gm,
    ),
  ].map((match) => match[1])
  const seedLiterals = [...constants.matchAll(/pub const (\w+): &\[u8\] = b"([^"]+)";/g)].map(
    (match) => ({ name: match[1], literal: match[2] }),
  )

  describe('source extraction', () => {
    it('found the three account structs', () => {
      expect(accountStructs.map((struct) => struct.name)).toEqual(protocol.accounts)
    })

    it('found the five instruction handlers', () => {
      expect(instructionNames).toEqual([
        'initialize_pool',
        'deposit_capital',
        'buy_policy',
        'settle_policy',
        'withdraw_capital',
      ])
    })

    it('found the error variants and seed literals', () => {
      expect(errorVariants.length).toBe(12)
      expect(seedLiterals).toHaveLength(4)
    })
  })

  describe('accounts doc matches state.rs', () => {
    const accountsDoc = readDoc('protocol/accounts.md')

    it.each(accountStructs)('$name documents the correct allocation', (struct) => {
      const initSpace = initSpaceOf(struct)
      const section = sectionFor(accountsDoc, struct.name)
      const match = /space = 8 \+ (\d+) = (\d+)/.exec(section)
      expect(match, `${struct.name}: no "space = 8 + N = M" claim in its section`).not.toBeNull()
      expect(Number(match![1]), `${struct.name}: INIT_SPACE`).toBe(initSpace)
      expect(Number(match![2]), `${struct.name}: allocated space`).toBe(initSpace + 8)
    })

    it.each(accountStructs)('$name documents every field', (struct) => {
      const section = sectionFor(accountsDoc, struct.name)
      const missing = struct.fields
        .map((field) => field.name)
        .filter((name) => !section.includes(`\`${name}\``))
      expect(missing, `${struct.name}: undocumented fields`).toEqual([])
    })
  })

  describe('errors doc matches error.rs', () => {
    const errorsDoc = readDoc('reference/errors.md')

    it('lists every variant with the right code', () => {
      const documented = new Map(
        [...errorsDoc.matchAll(/^\|\s*(\d+)\s*\|\s*`(\w+)`\s*\|/gm)].map((match) => [
          Number(match[1]),
          match[2],
        ]),
      )
      const expected = errorVariants.map((name, index) => [6000 + index, name] as const)
      expect([...documented.entries()]).toEqual(expected)
    })

    it('does not document variants that no longer exist', () => {
      const documentedNames = [...errorsDoc.matchAll(/^\|\s*\d+\s*\|\s*`(\w+)`\s*\|/gm)].map(
        (match) => match[1],
      )
      const stale = documentedNames.filter((name) => !errorVariants.includes(name))
      expect(stale, 'documented error variants absent from error.rs').toEqual([])
    })
  })

  describe('seeds doc matches constants.rs', () => {
    const seedsDoc = readDoc('reference/seeds.md')

    it.each(seedLiterals)('$name is documented as b"$literal"', ({ literal }) => {
      expect(seedsDoc).toContain(`b"${literal}"`)
    })

    it('documents FEE_DENOMINATOR', () => {
      const denominator = /pub const FEE_DENOMINATOR: u64 = ([\d_]+);/.exec(constants)?.[1]
      expect(denominator, 'FEE_DENOMINATOR not found in constants.rs').toBeDefined()
      const plain = denominator!.replaceAll('_', '')
      expect(seedsDoc.replaceAll('_', '')).toContain(plain)
    })
  })

  describe('instruction reference matches lib.rs', () => {
    const instructionsDoc = readDoc('reference/instructions.md')
    const instructionsPage = readDoc('protocol/instructions.md')

    it.each(instructionNames)('%s is in the reference', (name) => {
      expect(instructionsDoc).toContain(`## \`${name}`)
    })

    it.each(instructionNames)('%s is in the instruction guide', (name) => {
      expect(instructionsPage).toContain(`## \`${name}\``)
    })

    it('does not reference instructions that do not exist', () => {
      const stale = ['request_withdrawal'].filter((name) => instructionNames.includes(name))
      expect(stale, 'documented instructions absent from lib.rs').toEqual([])
      expect(instructionsDoc).not.toContain('request_withdrawal')
    })
  })

  describe('events doc matches events.rs', () => {
    const eventsDoc = readDoc('reference/events.md')

    it.each(eventStructs)('$name is documented with all its fields', (event) => {
      const section = sectionFor(eventsDoc, event.name)
      const missing = event.fields
        .map((field) => field.name)
        .filter((name) => !section.includes(`pub ${name}:`))
      expect(missing, `${event.name}: undocumented fields`).toEqual([])
    })

    it('documents exactly the events the program defines', () => {
      expect(eventStructs).toHaveLength(6)
    })
  })

  describe('stated counts match the program', () => {
    const scope = readDoc('introduction/scope.md')

    const countOf = (label: string): number => {
      const match = new RegExp(`\\|\\s*${label}\\s*\\|\\s*(\\d+)\\s*\\|`).exec(scope)
      expect(match, `no "${label}" row in scope.md`).not.toBeNull()
      return Number(match![1])
    }

    it('reports the right number of instructions', () => {
      expect(countOf('Instructions')).toBe(instructionNames.length)
    })

    it('reports the right number of account types', () => {
      expect(countOf('Account types')).toBe(accountStructs.length)
    })

    it('reports the right number of error variants', () => {
      expect(countOf('Error variants')).toBe(errorVariants.length)
    })

    it('reports the right number of events', () => {
      expect(countOf('Events')).toBe(eventStructs.length)
    })

    it('reports the right number of outbound CPIs', () => {
      const shared = readSrc('instructions/shared.rs')
      const cpis = [...shared.matchAll(/\btransfer\(/g)].length
      expect(countOf('Outbound CPIs')).toBe(cpis)
    })
  })
})
