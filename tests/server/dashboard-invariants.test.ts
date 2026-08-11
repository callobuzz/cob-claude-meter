import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Static invariants on the browser bundle.
 *
 * app.js is served verbatim to a browser and never imported by the node test
 * suite, so nothing else here can catch a regression in it. These are the two
 * rules that, when broken, produce wrong numbers rather than an error — the
 * failure mode that shipped in 0.5.1 and had to be found by hand.
 */
const APP_JS = readFileSync(join(process.cwd(), 'src/server/public/app.js'), 'utf-8');

/**
 * Every `addEventListener(...)` call in the file, as source text.
 *
 * Found by matching braces from the call rather than by slicing a fixed window,
 * so a handler is read in full and an unrelated earlier mention of the same
 * element id cannot be mistaken for one.
 */
function eventHandlers(): string[] {
  const out: string[] = [];
  const marker = 'addEventListener(';

  for (let i = APP_JS.indexOf(marker); i !== -1; i = APP_JS.indexOf(marker, i + 1)) {
    let depth = 0;
    let end = -1;
    for (let j = i + marker.length - 1; j < APP_JS.length; j++) {
      const ch = APP_JS[j];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) { end = j; break; }
      }
    }
    if (end !== -1) out.push(APP_JS.slice(i, end + 1));
  }
  return out;
}

/** The whole assignment statement for an element id, ternaries included. */
function assignmentFor(id: string): string {
  const lines = APP_JS.split('\n');
  const start = lines.findIndex((l) => l.includes(`$('${id}')`) && l.includes('='));
  if (start === -1) throw new Error(`no assignment found for ${id}`);

  const collected: string[] = [];
  for (let i = start; i < lines.length; i++) {
    collected.push(lines[i]);
    if (lines[i].trimEnd().endsWith(';')) break;
  }
  return collected.join('\n');
}

describe('dashboard wall-clock invariants', () => {
  /**
   * The wall-clock total is a union computed server-side for exactly the
   * projects on screen. renderStats paints it from a module-level cache that
   * only renderAll refreshes, so any other caller paints the *previous*
   * selection's number beside the current selection's summed total. That shows
   * up as a wall-clock larger than the summed total and a concurrency below 1x,
   * which is arithmetically impossible and badly misleading on a billing page.
   */
  it('renders stats only from renderAll, which refreshes the wall-clock first', () => {
    // Calls only — not the `function renderStats()` declaration itself.
    const callSites = [...APP_JS.matchAll(/(?<!function\s)renderStats\(\)/g)].length;
    expect(callSites).toBe(1);

    // ...and that one call must sit inside renderAll, after the refresh.
    const renderAllBody = APP_JS.slice(
      APP_JS.indexOf('async function renderAll()'),
      APP_JS.indexOf('function renderStats()'),
    );
    expect(renderAllBody).toContain('await refreshWallClock()');
    expect(renderAllBody).toContain('renderStats()');
    expect(renderAllBody.indexOf('await refreshWallClock()'))
      .toBeLessThan(renderAllBody.indexOf('renderStats()'));
  });

  /**
   * Every control that changes which projects are counted has to re-render
   * through renderAll. Repainting directly is what broke the filters.
   */
  it('routes every selection-changing control through renderAll', () => {
    // A handler that writes to `state` has changed what should be on screen.
    const mutating = eventHandlers().filter((h) => /state(\.\w+|\[\w+\])\s*=/.test(h));

    // Guard the guard: if the parse breaks, this must fail loudly rather than
    // quietly checking nothing.
    expect(mutating.length).toBeGreaterThanOrEqual(5);

    for (const handler of mutating) {
      // `state.tab` only swaps which panel is visible; the numbers do not move.
      const onlyTab = /state\.tab\s*=/.test(handler)
        && !/state(\.(?!tab)\w+|\[\w+\])\s*=/.test(handler);
      if (onlyTab) continue;

      // Either repaint through renderAll, or refetch through load — which
      // awaits renderAll itself. Both refresh the wall-clock; nothing else does.
      expect(handler).toMatch(/renderAll\(\)|load\(\)/);
      expect(handler).not.toMatch(/(?<!function\s)renderStats\(\)/);
    }
  });

  /**
   * The selection key decides when a refetch is skipped. If it stops covering
   * the grouping, switching day/week/month silently reuses the wrong buckets.
   */
  it('keys the wall-clock cache on both the project set and the grouping', () => {
    const fn = APP_JS.slice(
      APP_JS.indexOf('function selectionKey('),
      APP_JS.indexOf('function selectionKey(') + 200,
    );
    expect(fn).toContain('groupBy');
    expect(fn).toContain('ids');
  });
});

describe('dashboard tab wiring', () => {
  /** The tab names STATE_SHAPE will restore from localStorage. */
  function allowedTabs(): string[] {
    const line = APP_JS.split('\n').find((l) => /^\s*tab:\s*\(v\)/.test(l));
    if (!line) throw new Error('no tab validator found in STATE_SHAPE');
    return [...line.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  }

  function setTabBody(): string {
    const start = APP_JS.indexOf('function setTab(');
    return APP_JS.slice(start, APP_JS.indexOf('\nfunction ', start + 1));
  }

  /**
   * A tab STATE_SHAPE accepts but setTab cannot show is a blank page on reload:
   * the stored value restores, no panel is revealed, and nothing errors.
   */
  it('shows a panel for every tab it will restore', () => {
    const tabs = allowedTabs();
    expect(tabs.length).toBeGreaterThanOrEqual(4);

    const body = setTabBody();
    for (const tab of tabs) {
      expect(body).toContain(`panel-${tab}`);
    }
  });

  it('offers every restorable tab as a button', () => {
    const html = readFileSync(join(process.cwd(), 'src/server/public/index.html'), 'utf-8');
    for (const tab of allowedTabs()) {
      expect(html).toContain(`data-tab="${tab}"`);
    }
  });

  /**
   * "Untagged" is a sentinel, not a client name. A filter that compares it as
   * an ordinary string matches nothing and silently empties the view — which is
   * exactly what it did on the tokens tab before this test existed.
   */
  it('reads the untagged-client sentinel in every project filter', () => {
    const filters = ['function visibleProjects()', 'function visibleTokenProjects()'];

    for (const signature of filters) {
      const start = APP_JS.indexOf(signature);
      expect(start).toBeGreaterThan(-1);
      const body = APP_JS.slice(start, APP_JS.indexOf('\nfunction ', start + 1));
      expect(body).toContain('__none__');
    }
  });
});

describe('dashboard duration formatting', () => {
  /** Decimal hours on the headline tiles read as "4 hours 89 minutes". */
  it('shows the headline totals as hours and minutes, not decimal hours', () => {
    for (const id of ['stat-total', 'stat-wall']) {
      const assignment = assignmentFor(id);
      expect(assignment).toContain('hmMarkup');
      expect(assignment).not.toContain('fmtHours');
    }

    // hmMarkup must actually split hours from minutes rather than round away.
    expect(APP_JS).toMatch(/function hmMarkup[\s\S]{0,400}Math\.floor\(total \/ 60\)/);
  });

  it('has no interval maths left in the browser', () => {
    // The union is the server's job; a second implementation here would drift.
    for (const gone of ['function mergeIntervals', 'function unionOf', 'function durationWithin']) {
      expect(APP_JS).not.toContain(gone);
    }
  });
});
