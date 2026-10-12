import { statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DOCS, linkToPage, linkedPages, sidebarPages, sitePages } from './helpers'

const linked = linkedPages()
const sidebar = sidebarPages()
const pages = sitePages()
const linkedFiles = new Set(linked.map(linkToPage))

describe('sidebar integrity', () => {
  it('links at least one page', () => {
    expect(linked.length).toBeGreaterThan(0)
  })

  it('lists each page at most once in the sidebar', () => {
    const duplicates = sidebar.filter((link, index) => sidebar.indexOf(link) !== index)
    expect(duplicates, `duplicate sidebar entries: ${duplicates.join(', ')}`).toEqual([])
  })

  it('resolves every nav and sidebar link to a file', () => {
    const missing = linked.filter((link) => {
      try {
        statSync(join(DOCS, linkToPage(link)))
        return false
      } catch {
        return true
      }
    })
    expect(missing, `links with no corresponding .md file: ${missing.join(', ')}`).toEqual([])
  })

  it('links every built page from the nav or sidebar', () => {
    const orphans = pages
      // index.md is reachable from the site logo, not from the sidebar.
      .filter((page) => page !== 'index.md')
      .filter((page) => !linkedFiles.has(page))
    expect(orphans, `pages unreachable from nav/sidebar: ${orphans.join(', ')}`).toEqual([])
  })

  it('honours the site source exclusions', () => {
    expect(pages).not.toContain('README.md')
  })
})
