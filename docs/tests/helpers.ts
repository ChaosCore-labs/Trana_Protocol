import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

/** Shared discovery for the docs tests, so the suites agree on what a page is. */

export const DOCS = resolve(import.meta.dirname, '..')
export const CONFIG_PATH = join(DOCS, '.vitepress/config.mts')
export const config = readFileSync(CONFIG_PATH, 'utf8')

/** Glob subset covering `srcExclude`; the globstar matches zero or more segments. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const pattern = escaped.replace(/\*\*\//g, '(?:.*/)?').replace(/\*/g, '[^/]*')
  return new RegExp(`^${pattern}$`)
}

/**
 * Patterns the site excludes from its source tree. Read from the config rather
 * than hard-coded, so a page excluded from the build is not reported as an
 * unreachable page.
 */
/**
 * The nth capture group of a match that is known to have one.
 *
 * `match[n]` is `string | undefined` under `noUncheckedIndexedAccess`, and the
 * compiler cannot know a group participated. Every caller matches a pattern whose
 * group is mandatory, so a group that is missing means the pattern and the
 * document have drifted apart — which should fail loudly, not default away.
 */
export function group(match: RegExpMatchArray, index: number): string {
  const value = match[index]
  if (value === undefined) {
    throw new Error(`capture group ${index} missing from ${JSON.stringify(match[0])}`)
  }
  return value
}

export const srcExclude: RegExp[] = (() => {
  const block = /srcExclude:\s*\[([^\]]*)\]/.exec(config)
  if (block === null) return []
  const listed = block[1]
  if (listed === undefined) return []
  return [...listed.matchAll(/'([^']+)'/g)].map((match) => globToRegExp(group(match, 1)))
})()

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'cache') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      walk(full, acc)
    } else if (entry.endsWith('.md')) {
      acc.push(full)
    }
  }
  return acc
}

/** Markdown files the site actually builds, as docs-relative POSIX paths. */
export function sitePages(): string[] {
  return walk(DOCS)
    .map((file) => relative(DOCS, file).replaceAll('\\', '/'))
    .filter((page) => !srcExclude.some((pattern) => pattern.test(page)))
    .sort()
}

/** Every nav + sidebar link target, as written in the config. */
export function linkedPages(): string[] {
  return [...config.matchAll(/link:\s*'([^']+)'/g)].map((match) => group(match, 1))
}

/**
 * Sidebar-only link targets, as written in the config.
 *
 * The sidebar is an object keyed by path prefix (`{ '/freight_delay/': [...] }`),
 * so this slices from the `sidebar:` line to the following `search:` line rather
 * than matching a specific bracket shape. The whole tree is inside that slice,
 * which is what the duplicate-link guard wants: a page listed twice is a bug.
 */
export function sidebarPages(): string[] {
  const start = config.indexOf('sidebar:')
  const block = config.slice(start, config.indexOf('search: {', start))
  return [...block.matchAll(/link:\s*'([^']+)'/g)].map((match) => group(match, 1))
}

/** `/protocol/architecture` -> `protocol/architecture.md` */
export function linkToPage(link: string): string {
  return `${link.replace(/^\//, '')}.md`
}
