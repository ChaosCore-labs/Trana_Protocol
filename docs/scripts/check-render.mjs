#!/usr/bin/env bun
/**
 * Asserts, in a real browser, that every ```mermaid block on every page is
 * drawn whole — nothing clipped on the page — and that the blocks too big to
 * read in the column open a fullscreen viewer that fits, zooms and closes.
 *
 * This is an integration check, not a unit test: syntax validation and markup
 * assertions both pass while the page still shows raw diagram source, a blank
 * svg, or a diagram with a hidden half.
 *
 * Usage:
 *   bun run dev            # or: bun run preview
 *   bun run test:render    # checks DOCS_URL, default http://localhost:5173
 *
 * On Linux/Windows, point Bun at a Chrome/Chromium binary if it is not on PATH:
 *   BUN_CHROME_PATH=/path/to/chromium bun run test:render
 */
const BASE = Bun.argv[2] ?? Bun.env.DOCS_URL ?? 'http://localhost:5173'
// Bun has no path module; the file APIs normalise `..` for us.
const DOCS = `${import.meta.dir}/..`
const TIMEOUT_MS = 15_000
const POLL_MS = 150

/** Pages to check, taken from the site's own nav + sidebar. */
async function pagesFromConfig() {
  // Bun.file rather than node:fs: this script is a Bun script, and the read is
  // a one-shot at startup.
  const config = await Bun.file(`${DOCS}/.vitepress/config.mts`).text()
  const links = [...config.matchAll(/link:\s*'([^']+)'/g)].map((match) => match[1])
  return [...new Set(links)]
}

/**
 * Wait until the page has mounted and every diagram it contains has been drawn.
 *
 * Drawn, not merely present: mermaid appends the <svg> element first and fills
 * it in later, drawing one diagram at a time over roughly half a second each,
 * so an svg-presence check passes on a still-blank diagram. Mermaid writes the
 * viewBox only once the layout exists, which is the signal worth trusting.
 *
 * Pages without diagrams return as soon as their content is mounted, so the
 * check does not pay the full timeout on 17 of 22 pages.
 */
async function waitForDiagrams(view) {
  const deadline = Date.now() + TIMEOUT_MS
  let state = { mounted: false, blocks: 0, drawn: 0 }

  while (Date.now() < deadline) {
    state = await view.evaluate(`(function () {
      const blocks = [...document.querySelectorAll('pre.mermaid')];
      return {
        mounted: !!document.querySelector('.vp-doc'),
        blocks: blocks.length,
        drawn: blocks.filter((el) => {
          const svg = el.querySelector('svg');
          return !!svg && !!svg.getAttribute('viewBox') && svg.childElementCount > 0;
        }).length,
      };
    })()`)

    if (state.mounted && (state.blocks === 0 || state.drawn >= state.blocks)) {
      return state
    }
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
  return state
}

/**
 * Assert that each diagram is shown whole, and that the click affordance is
 * well formed.
 *
 * "Whole" is the property that matters to a reader and the one a container can
 * silently break: a diagram taller than its box is a diagram with a hidden half.
 * It is checked against the drawn svg's own height rather than against a CSS
 * rule, so any future clipping — overflow, a max-height, a fixed stage — fails
 * here.
 */
async function checkInline(view) {
  return view.evaluate(`(function () {
    const blocks = [...document.querySelectorAll('pre.mermaid')];
    const clipped = blocks.filter((el) => {
      const svg = el.querySelector('svg');
      if (!svg) return false;
      return svg.getBoundingClientRect().height > el.getBoundingClientRect().height + 2;
    }).length;
    const expandable = blocks.filter((el) => el.dataset.viewer === 'true');
    const malformed = expandable.filter(
      (el) => el.getAttribute('role') !== 'button' || el.getAttribute('tabindex') !== '0',
    ).length;
    // The rule is the same for every diagram on every page: clickable exactly
    // when mermaid drew it wider than the column or taller than the viewer's own
    // trigger height. Anything else means it was decided by accident.
    const misclassified = blocks.filter((el) => {
      const svg = el.querySelector('svg');
      if (!svg) return false;
      const parts = (svg.getAttribute('viewBox') || '').split(/[\\s,]+/).map(Number);
      const boxWidth = el.getBoundingClientRect().width;
      const shouldExpand = parts[2] > boxWidth + 1 || parts[3] > 900;
      return shouldExpand !== (el.dataset.viewer === 'true');
    }).length;
    return {
      clipped: clipped,
      expandable: expandable.length,
      malformed: malformed,
      misclassified: misclassified,
    };
  })()`)
}

/**
 * Open the viewer on one expandable diagram and drive it, including the close
 * that has to hand the page back.
 *
 * Every expandable diagram on a page is driven, not just the first: the viewer
 * is built per diagram, from the size that diagram was drawn at, so one working
 * click says nothing about the next.
 */
async function checkViewer(view, index) {
  return view.evaluate(`(async function () {
    const el = document.querySelectorAll('pre.mermaid[data-viewer="true"]')[${index}];
    if (!el) return null;
    const svg = el.querySelector('svg');
    const inlineStyle = svg.getAttribute('style');
    const box = (svg.getAttribute('viewBox') || '').split(/[\\s,]+/).map(Number);
    const natural = { width: box[2], height: box[3] };
    const scaleOf = function () {
      const match = /scale\\(([\\d.]+)\\)/.exec(svg.style.transform || '');
      return match ? Number(match[1]) : null;
    };

    el.focus();
    el.click();

    const dialog = document.querySelector('dialog.dz-viewer');
    if (!dialog || !dialog.open) return { opened: false };
    const stage = dialog.querySelector('.dz-viewer-stage');
    const stageBox = stage.getBoundingClientRect();
    const fitted = scaleOf();
    const wholeFits =
      fitted !== null &&
      natural.width * fitted <= stageBox.width + 1 &&
      natural.height * fitted <= stageBox.height + 1;
    const buttons = dialog.querySelectorAll('.dz-button').length;
    const level = dialog.querySelector('.dz-level').textContent;
    // The viewer is a fullscreen overlay, not a floating box: a modal dialog is
    // only centred by the user-agent's auto margin, which a reset can take
    // away, and a fixed box with a definite size then lands in the corner.
    // Measured against the layout viewport: window.innerWidth includes the
    // scrollbar, which the overlay does not cover.
    const dialogBox = dialog.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    const fillsViewport =
      Math.abs(dialogBox.width - viewportWidth) <= 2 &&
      Math.abs(dialogBox.height - viewportHeight) <= 2 &&
      Math.abs(dialogBox.left) <= 2 &&
      Math.abs(dialogBox.top) <= 2;

    dialog.querySelector('.dz-button[data-action="in"]').click();
    const zoomed = (scaleOf() ?? 0) > (fitted ?? 0);

    // Wait for the close event rather than for a duration: the viewer restores
    // the page in its own handler on that event, registered first, so once this
    // resolves the diagram is already back. The timeout only bounds a hang.
    const sawClose = await new Promise(function (resolve) {
      const timer = setTimeout(function () { resolve(false) }, 2000);
      dialog.addEventListener(
        'close',
        function () {
          clearTimeout(timer);
          resolve(true);
        },
        { once: true },
      );
      dialog.querySelector('.dz-button[data-action="close"]').click();
    });

    return {
      opened: true,
      buttons: buttons,
      wholeFits: wholeFits,
      fillsViewport: fillsViewport,
      level: level,
      zoomed: zoomed,
      closeEventSeen: sawClose,
      dialogOpenAfter: dialog.open,
      putBack: el.querySelector('svg') === svg,
      styleRestored: svg.getAttribute('style') === inlineStyle,
      focused: document.activeElement === el,
    };
  })()`)
}

/** Everything that has to hold for one viewer session, as messages. */
function viewerProblems(viewer, index) {
  const tag = `diagram #${index}`
  if (viewer === null || !viewer.opened) return [`${tag}: did not open a viewer`]
  const problems = []
  if (viewer.buttons !== 4) problems.push(`${tag}: ${viewer.buttons} viewer buttons, expected 4`)
  if (!viewer.fillsViewport) problems.push(`${tag}: viewer did not fill the viewport`)
  if (!viewer.wholeFits) problems.push(`${tag}: viewer did not open fitted to the whole diagram`)
  if (!viewer.zoomed) problems.push(`${tag}: zoom in did not enlarge the diagram`)
  if (!viewer.closeEventSeen) problems.push(`${tag}: close event never fired`)
  if (viewer.dialogOpenAfter) problems.push(`${tag}: viewer stayed open after closing`)
  if (!viewer.putBack) problems.push(`${tag}: closing did not return the diagram to the page`)
  if (!viewer.styleRestored) problems.push(`${tag}: closing did not restore the inline sizing`)
  if (!viewer.focused) problems.push(`${tag}: closing did not return focus to the diagram`)
  return problems
}

const pages = await pagesFromConfig()
const failures = []
const skipped = []
let totalDiagrams = 0
let totalExpandable = 0

// Preflight so a missing server is an actionable message, not a wall of
// navigation errors.
try {
  const response = await fetch(BASE, { signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
} catch (error) {
  console.error(
    `Cannot reach ${BASE} — start the site first:\n` +
      `  bun run dev        # dev server, http://localhost:5173\n` +
      `  bun run preview    # or serve the production build\n\n` +
      `(${String(error.message ?? error).split('\n')[0]})`,
  )
  process.exit(2)
}

for (const page of pages) {
  const url = `${BASE}${page}`
  let result
  let inline = null
  const problems = []
  try {
    // One browser per page, and every viewer on it driven in turn: the viewer is
    // a singleton reused across opens, so sequential use is part of what has to
    // work.
    await using view = new Bun.WebView({ width: 1440, height: 1000 })
    await view.navigate(url)
    result = await waitForDiagrams(view)
    if (result.blocks > 0) {
      inline = await checkInline(view)
      const expandable = inline.expandable ?? 0
      for (let index = 0; index < expandable; index++) {
        problems.push(...viewerProblems(await checkViewer(view, index), index))
      }
    }
  } catch (error) {
    failures.push({ page, error: String(error.message ?? error).split('\n')[0] })
    continue
  }

  if (result.blocks === 0) {
    skipped.push(page)
    continue
  }
  totalDiagrams += result.blocks
  if (result.drawn < result.blocks) {
    problems.push(`${result.drawn}/${result.blocks} diagrams drawn`)
  }
  if (inline !== null && inline.clipped > 0) {
    problems.push(`${inline.clipped} diagram(s) taller than their block`)
  }

  let note = ''
  if (inline !== null) {
    if (inline.misclassified > 0) {
      problems.push(`${inline.misclassified} diagram(s) not classified by the size rule`)
    }
    if (inline.expandable > 0) {
      totalExpandable += inline.expandable
      note = `  (+${inline.expandable} expandable, all driven)`
      if (inline.malformed > 0) {
        problems.push(`${inline.malformed} expandable diagram(s) without button semantics`)
      }
    }
  }

  if (problems.length > 0) {
    failures.push({ page, error: problems.join('; ') })
  } else {
    console.log(`ok  ${page.padEnd(36)} ${result.drawn}/${result.blocks}${note}`)
  }
}

console.log(
  `\n${pages.length} pages checked, ${totalDiagrams} diagrams drawn whole, ` +
    `${totalExpandable} with a fullscreen viewer, ${skipped.length} pages without diagrams, ` +
    `${failures.length} failing`,
)

if (failures.length > 0) {
  console.error('\nFAILURES')
  for (const failure of failures) console.error(`  ${failure.page}: ${failure.error}`)
  process.exit(1)
}
