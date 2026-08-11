/* Claude Meter dashboard — vanilla ES module, no build step, no dependencies. */

const $ = (id) => document.getElementById(id);
const STORE_KEY = 'claude-meter-view';

const state = {
  range: 'this-month',
  customStart: '',
  customEnd: '',
  idle: 300,
  tab: 'projects',
  search: '',
  client: '',
  tag: '',
  sort: 'hours',
  showHidden: false,
  groupBy: 'day',
};

let report = null;
let openProject = null;
let openDay = null;

/* ---------- utilities ---------- */

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** One labelled tooltip line. Returns the row plus the span to write into. */
function tooltipRow(label) {
  const row = document.createElement('div');
  row.className = 'tt-row';
  const name = document.createElement('span');
  name.textContent = label;
  const value = document.createElement('span');
  row.append(name, value);
  return { row, value };
}

const hours = (ms) => ms / 3600000;

function fmtHours(ms) {
  const h = hours(ms);
  if (h === 0) return '0';
  if (h < 0.1) return h.toFixed(2);
  return h < 10 ? h.toFixed(2) : h.toFixed(1);
}

function fmtHM(ms) {
  const total = Math.round(ms / 60000);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

/**
 * The same hours and minutes as fmtHM, marked up for the big stat tiles.
 *
 * Decimal hours read badly at a glance — "4.89" invites the guess that it means
 * four hours and eighty-nine minutes, and nobody converts .89 into 53 in their
 * head. Built from numbers only, so there is nothing here to escape.
 */
function hmMarkup(ms) {
  const total = Math.round(ms / 60000);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}<span class="unit">m</span>`;
  return `${h}<span class="unit">h</span> ${String(m).padStart(2, '0')}<span class="unit">m</span>`;
}

function fmtDate(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
}

function fmtDateTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString(undefined, {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

function weekdayOf(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short' });
}

/** ISO week bucket, so a "week" always starts Monday regardless of locale. */
function weekKey(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const shift = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - shift);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${mm}-${dd}`;
}

function monthKey(dayKey) {
  return dayKey.slice(0, 7);
}

/* Local-time day helpers. Local, never UTC: a boundary drawn in UTC would move
   evening work onto the wrong date for anyone not sitting on the meridian. */

function dayKeyToMs(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

function startOfLocalDay(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Adds days via the date parts so DST transitions don't drift the boundary. */
function addLocalDays(ms, n) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime();
}

function localDayKey(ms) {
  const d = new Date(ms);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/* ---------- wall-clock ----------
   Wall-clock is a union, so it cannot be summed from per-project scalars: it
   needs the underlying intervals, and a filtered view needs them re-folded.

   That fold lives on the server (src/core/wall-clock.ts). The report used to
   ship every project's raw intervals so this file could do it, which meant the
   response grew with the entire history and the interval maths existed twice —
   once here, once in TypeScript — with no way to import one from the other.
   Now the browser asks for the numbers it needs and holds no timestamps. */

/* ---------- timeline month accordion ---------- */

/** Month keys currently folded shut. */
const collapsedMonths = new Set();
/** The month set these defaults were chosen for, so a range change re-picks. */
let collapsedSignature = null;

/**
 * Applies the default open/closed state when the visible months change.
 *
 * Everything but the newest month starts closed. Opening a year of history to
 * 365 day rows buries the recent work the dashboard is usually opened to check,
 * and the months below it are one click away. Choices already made are kept as
 * long as the same months stay in view.
 */
function syncCollapsedMonths(monthKeys) {
  const signature = monthKeys.join(',');
  if (signature === collapsedSignature) return;

  collapsedSignature = signature;
  collapsedMonths.clear();
  const newest = monthKeys.slice().sort().pop();
  for (const key of monthKeys) {
    if (key !== newest) collapsedMonths.add(key);
  }
}

function monthHeadingRow(monthKeyValue, totals) {
  const [y, m] = monthKeyValue.split('-');
  const name = new Date(Number(y), Number(m) - 1, 1)
    .toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const collapsed = collapsedMonths.has(monthKeyValue);
  const dayWord = totals.activeDays === 1 ? 'day' : 'days';

  return `
    <tr class="month-head${collapsed ? ' is-collapsed' : ''}" data-month="${esc(monthKeyValue)}">
      <td>
        <div class="proj-name">
          <span class="caret">&#9656;</span>
          <strong>${esc(name)}</strong>
          <span class="muted">${totals.activeDays} active ${dayWord}</span>
        </div>
      </td>
      <td></td>
      <td class="num hours">${fmtHours(totals.totalMs)}</td>
      <td class="num hours-alt">${fmtHours(totals.wallMs)}</td>
      <td class="num dim"></td>
    </tr>`;
}

/** Wall-clock for the current selection, keyed so repeat renders don't refetch. */
let wallClock = { key: null, totalMs: 0, buckets: {} };

// Newline-joined, not space-joined: project ids are filesystem paths and may
// contain spaces, which would let two different selections share a key.
function selectionKey(ids, groupBy) {
  return `${groupBy}|${[...ids].sort().join('\n')}`;
}

/**
 * Fetches wall-clock for the visible projects if the selection changed.
 *
 * Returns true when the numbers moved, so the caller knows to re-render. The
 * server memoises the report these are folded from, so this stays cheap.
 */
async function refreshWallClock() {
  const ids = visibleProjects().map((p) => p.id);
  const key = selectionKey(ids, state.groupBy);
  if (wallClock.key === key) return false;

  try {
    const res = await fetch(`/api/wallclock?${buildQuery(false)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projects: ids, groupBy: state.groupBy }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    wallClock = { key, totalMs: data.totalMs ?? 0, buckets: data.buckets ?? {} };
    return true;
  } catch (err) {
    // Wall-clock is one figure among many; a failure here must not blank the
    // dashboard. Show it as unavailable rather than as a confident zero.
    wallClock = { key, totalMs: null, buckets: {} };
    console.warn('wall-clock request failed:', err);
    return true;
  }
}

function toast(message, isError = false) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('is-error', isError);
  el.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { el.hidden = true; }, 2600);
}

function saveState() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch { /* private mode — filters just won't persist */ }
}

/**
 * What each stored key is allowed to be.
 *
 * Anything with a fixed set of options is checked against that set, because
 * several of them end up inside markup. localStorage is editable by anything
 * that can run script on this origin, so restoring it with a blind
 * Object.assign let a stored value become HTML on the next render. Free-text
 * fields stay free text — they are escaped where they are used.
 */
const STATE_SHAPE = {
  range: (v) => typeof v === 'string' && /^[a-z0-9-]{1,20}$/.test(v),
  customStart: (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v),
  customEnd: (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v),
  idle: (v) => Number.isFinite(v) && v >= 30 && v <= 3600,
  tab: (v) => ['projects', 'timeline', 'clients'].includes(v),
  search: (v) => typeof v === 'string',
  client: (v) => typeof v === 'string',
  tag: (v) => typeof v === 'string',
  sort: (v) => typeof v === 'string' && /^[a-z-]{1,20}$/.test(v),
  showHidden: (v) => typeof v === 'boolean',
  groupBy: (v) => ['day', 'week', 'month'].includes(v),
};

function restoreState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const stored = JSON.parse(raw);
    if (!stored || typeof stored !== 'object') return;

    for (const [key, isValid] of Object.entries(STATE_SHAPE)) {
      if (Object.prototype.hasOwnProperty.call(stored, key) && isValid(stored[key])) {
        state[key] = stored[key];
      }
    }
  } catch { /* ignore */ }
}

/* ---------- data ---------- */

function buildQuery(forceRefresh) {
  const params = new URLSearchParams();
  if (state.range === 'custom' && state.customStart && state.customEnd) {
    params.set('start', state.customStart);
    params.set('end', state.customEnd);
  } else {
    params.set('range', state.range);
  }
  params.set('idle', String(state.idle));
  if (forceRefresh) params.set('refresh', '1');
  return params.toString();
}

async function load(forceRefresh = false) {
  $('loading').hidden = false;
  $('refresh-btn').classList.add('is-busy');
  try {
    const res = await fetch(`/api/report?${buildQuery(forceRefresh)}`);
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    report = await res.json();
    // The range or threshold may have moved under an identical project set, so
    // the previous wall-clock is stale even though its key would still match.
    wallClock = { key: null, totalMs: 0, buckets: {} };
    await renderAll();
  } catch (err) {
    report = null;
    $('panel-projects').innerHTML =
      `<div class="empty"><strong>Could not load report</strong>${esc(err.message)}</div>`;
    toast(err.message, true);
  } finally {
    $('loading').hidden = true;
    $('refresh-btn').classList.remove('is-busy');
  }
}

async function saveMeta(path, patch) {
  const res = await fetch('/api/project-meta', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, patch }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Save failed (${res.status})`);
  }
  return (await res.json()).meta;
}

/* ---------- filtering ---------- */

function visibleProjects() {
  if (!report) return [];
  const needle = state.search.trim().toLowerCase();

  let list = report.projects.filter((p) => {
    if (!state.showHidden && p.hidden) return false;
    if (state.client === '__none__' ? p.client : state.client && p.client !== state.client) return false;
    if (state.tag && !p.tags.includes(state.tag)) return false;
    if (needle) {
      const haystack = `${p.displayName} ${p.path} ${p.client ?? ''} ${p.tags.join(' ')}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });

  const by = {
    hours: (a, b) => b.totalMs - a.totalMs,
    name: (a, b) => a.displayName.localeCompare(b.displayName),
    sessions: (a, b) => b.sessionCount - a.sessionCount,
    days: (a, b) => b.activeDays - a.activeDays,
    recent: (a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0),
  };
  list = [...list].sort(by[state.sort] ?? by.hours);
  return list;
}

/** Ids of projects passing the current filter — used to scope the timeline too. */
function visibleIds() {
  return new Set(visibleProjects().map((p) => p.id));
}

/* ---------- rendering ---------- */

async function renderAll() {
  // Wall-clock is fetched before painting so the stat and the timeline agree.
  // It no-ops when the selection has not changed, so filter-only re-renders
  // that leave the project set alone cost nothing.
  await refreshWallClock();
  renderStats();
  renderFilterOptions();
  renderProjects();
  renderTimeline();
  renderClients();
  renderFooter();
}

function renderStats() {
  if (!report) return;
  const shown = visibleProjects();
  const filtered = shown.length !== report.projects.length;

  const totalMs = shown.reduce((acc, p) => acc + p.totalMs, 0);
  // Union of exactly the projects on screen — computed server-side, correct
  // filtered or not. null means the request failed; say so rather than show 0.
  const wallMs = wallClock.totalMs;
  // Days the visible projects were actually active, not the report-wide count.
  const days = new Set(shown.flatMap((p) => Object.keys(p.byDay))).size;
  const sessions = shown.reduce((acc, p) => acc + p.sessionCount, 0);

  $('stat-total').innerHTML = hmMarkup(totalMs);
  $('stat-range').textContent = filtered
    ? `${shown.length} of ${report.projects.length} projects`
    : labelFor(report.rangeLabel);

  $('stat-wall').innerHTML = wallMs === null
    ? `<span class="unit">unavailable</span>`
    : hmMarkup(wallMs);
  $('stat-concurrency').textContent = wallMs === null
    ? 'could not be calculated'
    : wallMs
      ? `${(totalMs / wallMs).toFixed(2)}× avg concurrency`
      : 'no overlapping sessions';

  $('stat-days').textContent = String(days);
  $('stat-avg').textContent = days ? `${fmtHM(totalMs / days)}/day avg` : '—';

  $('stat-projects').textContent = String(shown.length);
  const clientCount = new Set(shown.map((p) => p.client).filter(Boolean)).size;
  $('stat-clients').textContent = clientCount ? `${clientCount} clients` : 'no clients tagged';

  $('stat-sessions').textContent = String(sessions);
  $('stat-scan').textContent =
    `${report.scan.filesScanned} logs · ${(report.scan.durationMs / 1000).toFixed(1)}s`;
}

function labelFor(rangeLabel) {
  const names = {
    'today': 'Today', 'yesterday': 'Yesterday', 'this-week': 'This week',
    'last-week': 'Last week', 'this-month': 'This month', 'last-month': 'Last month',
    'this-year': 'This year', 'last30': 'Last 30 days', 'all': 'All time',
  };
  return names[rangeLabel] ?? rangeLabel;
}

function renderFilterOptions() {
  if (!report) return;

  const clientSel = $('filter-client');
  const tagSel = $('filter-tag');

  const clientOpts = ['<option value="">All clients</option>',
    '<option value="__none__">— Untagged —</option>']
    .concat(report.clients.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`));
  clientSel.innerHTML = clientOpts.join('');
  clientSel.value = state.client;

  tagSel.innerHTML = ['<option value="">All tags</option>']
    .concat(report.allTags.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`)).join('');
  tagSel.value = state.tag;
}

function renderProjects() {
  const list = visibleProjects();
  const panel = $('panel-projects');

  if (list.length === 0) {
    panel.innerHTML = `<div class="empty"><strong>No projects match</strong>Try clearing the search or filters.</div>`;
    return;
  }

  const max = Math.max(...list.map((p) => p.totalMs), 1);

  const rows = list.map((p) => {
    const pct = (p.totalMs / max) * 100;
    const isOpen = openProject === p.id;

    const clientCell = p.client
      ? `<span class="clientchip">${esc(p.client)}</span>`
      : `<span class="nochip">untagged</span>`;

    const tagCell = p.tags.length
      ? p.tags.map((t) => `<span class="tagchip">${esc(t)}</span>`).join('')
      : `<span class="nochip">—</span>`;

    const main = `
      <tr class="row${isOpen ? ' is-open' : ''}" data-project="${esc(p.id)}">
        <td>
          <div class="proj-name"><span class="caret">&#9656;</span>${esc(p.displayName)}${p.hidden ? ' <span class="nochip">hidden</span>' : ''}</div>
          <div class="proj-path">${esc(p.path)}</div>
        </td>
        <td>${clientCell}</td>
        <td>${tagCell}</td>
        <td class="bar-cell">
          <div class="bar-track" title="${fmtHours(p.totalMs)} h">
            <div class="bar-fill" style="width:${pct.toFixed(2)}%"></div>
          </div>
        </td>
        <td class="num hours">${fmtHours(p.totalMs)}</td>
        <td class="num hours-alt">${fmtHours(p.wallClockMs)}</td>
        <td class="num dim">${p.sessionCount}</td>
        <td class="num dim">${p.activeDays}</td>
        <td class="num muted">${fmtDate(p.lastSeen)}</td>
      </tr>`;

    if (!isOpen) return main;

    const sessions = p.sessions.slice(0, 12).map((s) => `
      <li><code>${esc(s.id.slice(0, 8))}</code>
        <span>${fmtDateTime(s.firstSeen)} → ${fmtDateTime(s.lastSeen)}</span>
        <strong>${fmtHM(s.activeMs)}</strong></li>`).join('');

    const overlap = p.totalMs - p.wallClockMs;

    return main + `
      <tr class="detail"><td colspan="9"><div class="detail-inner">
        <div>
          <label class="field-label" for="edit-client">Client</label>
          <input type="text" id="edit-client" value="${esc(p.client ?? '')}" placeholder="e.g. Acme Corp" list="client-list" />
          <datalist id="client-list">${report.clients.map((c) => `<option value="${esc(c)}"></option>`).join('')}</datalist>
        </div>
        <div>
          <label class="field-label" for="edit-tags">Tags <span class="muted">(comma separated)</span></label>
          <input type="text" id="edit-tags" value="${esc(p.tags.join(', '))}" placeholder="billable, retainer" />
        </div>
        <div>
          <label class="field-label" for="edit-alias">Display name</label>
          <input type="text" id="edit-alias" value="${esc(p.displayName === p.name ? '' : p.displayName)}" placeholder="${esc(p.name)}" />
        </div>
        <div class="detail-actions">
          <button class="btn" id="save-meta" type="button" data-path="${esc(p.id)}">Save</button>
          <label class="field-check"><input type="checkbox" id="edit-hidden" ${p.hidden ? 'checked' : ''} /><span>Hide</span></label>
        </div>
        <div class="detail-full">
          <span class="field-label">Sessions in range (${p.sessionCount})</span>
          <ul class="session-list">${sessions}</ul>
          ${overlap > 60000
            ? `<p class="hint">${fmtHM(overlap)} of this project's time ran in two or more terminals at once — counted once per session in the summed total.</p>`
            : ''}
        </div>
      </div></td></tr>`;
  }).join('');

  panel.innerHTML = `
    <div class="table-wrap"><div class="scroll-x"><table>
      <thead><tr>
        <th>Project</th><th>Client</th><th>Tags</th><th></th>
        <th class="num">Hours</th><th class="num">Wall</th>
        <th class="num">Sess</th><th class="num">Days</th><th class="num">Last</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div></div>`;
}

function renderTimeline() {
  const panel = $('panel-timeline');
  if (!report || report.days.length === 0) {
    panel.innerHTML = `<div class="empty"><strong>No activity in this range</strong>Pick a wider date range.</div>`;
    return;
  }

  const shown = visibleProjects();
  const allowed = new Set(shown.map((p) => p.id));
  const bucketOf = { day: (d) => d, week: weekKey, month: monthKey }[state.groupBy];

  // Re-derive buckets from per-day project splits so filters apply here too.
  const buckets = new Map();
  for (const day of report.days) {
    const key = bucketOf(day.day);
    if (!buckets.has(key)) buckets.set(key, { key, totalMs: 0, wallMs: 0, days: new Set(), projects: new Map() });
    const bucket = buckets.get(key);

    let kept = 0;
    for (const proj of day.projects) {
      if (!allowed.has(proj.id)) continue;
      kept += proj.ms;
      bucket.projects.set(proj.id, (bucket.projects.get(proj.id) ?? 0) + proj.ms);
    }
    if (kept === 0) continue;

    bucket.totalMs += kept;
    bucket.days.add(day.day);
  }

  // Fill in the dates nothing happened on.
  //
  // Buckets above come from report.days, which only lists dates with activity.
  // A day off therefore vanished from the timeline entirely and the sequence
  // jumped — 09 straight to 11 — which reads as a rendering fault rather than
  // as a day not worked. A filtered-out day already showed as zero, so the two
  // cases looked inconsistent as well.
  //
  // The span runs from the first date with data to today, clipped to the
  // selected range: starting at the range's own start would emit four years of
  // empty rows for "all time", and running to its end would invent dates in
  // the future.
  const spanStart = Math.max(report.range.start, dayKeyToMs(report.days[0].day));
  const spanEnd = Math.min(report.range.end, Date.now());
  for (let cursor = startOfLocalDay(spanStart); cursor <= spanEnd; cursor = addLocalDays(cursor, 1)) {
    const key = bucketOf(localDayKey(cursor));
    if (!buckets.has(key)) {
      buckets.set(key, { key, totalMs: 0, wallMs: 0, days: new Set(), projects: new Map() });
    }
  }

  // Wall-clock per bucket comes back already folded for this exact selection.
  // Summing per-day wall-clock here would be wrong for week/month, where a
  // session spanning the boundary belongs to one union, not two.
  for (const bucket of buckets.values()) {
    bucket.wallMs = wallClock.buckets[bucket.key] ?? 0;
  }

  const rows = [...buckets.values()].sort((a, b) => (a.key < b.key ? 1 : -1));
  // Gap-filling means there are always rows, so emptiness is now about hours,
  // not row count — otherwise a filter matching nothing would render a wall of
  // zeros instead of saying so.
  if (!rows.some((r) => r.totalMs > 0)) {
    panel.innerHTML = `<div class="empty"><strong>No activity matches the filters</strong>Clear a filter to see the timeline.</div>`;
    return;
  }

  const max = Math.max(...rows.map((r) => r.totalMs), 1);

  // Month accordion, for day rows only.
  //
  // A wide range is a long undifferentiated list — a year is 365 rows — so day
  // rows are collected under a collapsible month heading. Weeks and months are
  // already coarse enough to read straight through, and a single-month range
  // gains nothing from a heading that would contain everything, so both skip it.
  const monthsInView = state.groupBy === 'day'
    ? [...new Set(rows.map((r) => monthKey(r.key)))]
    : [];
  const useAccordion = monthsInView.length > 1;
  if (useAccordion) syncCollapsedMonths(monthsInView);

  const monthTotals = new Map();
  if (useAccordion) {
    for (const r of rows) {
      const key = monthKey(r.key);
      const acc = monthTotals.get(key) ?? { totalMs: 0, wallMs: 0, activeDays: 0 };
      acc.totalMs += r.totalMs;
      acc.wallMs += r.wallMs;
      if (r.totalMs > 0) acc.activeDays++;
      monthTotals.set(key, acc);
    }
  }

  let lastMonth = null;

  const body = rows.map((r) => {
    let heading = '';
    if (useAccordion) {
      const mk = monthKey(r.key);
      if (mk !== lastMonth) {
        lastMonth = mk;
        heading = monthHeadingRow(mk, monthTotals.get(mk));
      }
      // A collapsed month renders its heading and nothing else.
      if (collapsedMonths.has(mk)) return heading;
    }

    return heading + dayRow(r);
  }).join('');

  function dayRow(r) {
    const pct = (r.totalMs / max) * 100;
    const isOpen = openDay === r.key;

    let label;
    if (state.groupBy === 'day') {
      label = `${r.key} <span class="muted">${weekdayOf(r.key)}</span>`;
    } else if (state.groupBy === 'week') {
      label = `Week of ${r.key} <span class="muted">${r.days.size}d</span>`;
    } else {
      const [y, m] = r.key.split('-');
      const name = new Date(Number(y), Number(m) - 1, 1)
        .toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
      label = `${name} <span class="muted">${r.days.size}d</span>`;
    }

    const projects = [...r.projects.entries()]
      .map(([id, ms]) => ({ id, ms, name: report.projects.find((p) => p.id === id)?.displayName ?? id }))
      .sort((a, b) => b.ms - a.ms);

    const main = `
      <tr class="row${isOpen ? ' is-open' : ''}" data-day="${esc(r.key)}">
        <td><div class="proj-name"><span class="caret">&#9656;</span>${label}</div></td>
        <td class="bar-cell">
          <div class="bar-track" data-tip="${esc(r.key)}|${fmtHours(r.totalMs)}|${projects.length}">
            <div class="bar-fill${r.totalMs === 0 ? ' is-zero' : ''}" style="width:${pct.toFixed(2)}%"></div>
          </div>
        </td>
        <td class="num hours">${fmtHours(r.totalMs)}</td>
        <td class="num hours-alt">${fmtHours(r.wallMs)}</td>
        <td class="num dim">${projects.length}</td>
      </tr>`;

    if (!isOpen) return main;

    const inner = projects.map((p) => `
      <li>
        <span class="name">${esc(p.name)}</span>
        <span class="bar-track"><span class="bar-fill" style="display:block;width:${((p.ms / r.totalMs) * 100).toFixed(2)}%"></span></span>
        <span class="num hours">${fmtHours(p.ms)}</span>
      </li>`).join('');

    return main + `<tr class="detail"><td colspan="5"><div class="detail-inner">
      <div class="detail-full">
        <span class="field-label">Projects in this ${esc(state.groupBy)}</span>
        <ul class="day-projects">${inner}</ul>
      </div>
    </div></td></tr>`;
  }

  panel.innerHTML = `
    <div class="table-wrap"><div class="scroll-x"><table>
      <thead><tr>
        <th>${state.groupBy === 'day' ? 'Date' : state.groupBy === 'week' ? 'Week' : 'Month'}</th>
        <th></th><th class="num">Hours</th><th class="num">Wall</th><th class="num">Projects</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table></div></div>`;
}

function renderClients() {
  const panel = $('panel-clients');
  const list = visibleProjects();

  if (list.length === 0) {
    panel.innerHTML = `<div class="empty"><strong>Nothing to summarise</strong>Adjust the filters.</div>`;
    return;
  }

  const groups = new Map();
  for (const p of list) {
    // Escape, not a literal NUL: a raw control byte makes the file read as
    // binary to grep and diff tools. Sorts before any real client name.
    const key = p.client ?? '\u0000untagged';
    if (!groups.has(key)) groups.set(key, { name: p.client ?? 'Untagged', totalMs: 0, projects: [], days: new Set() });
    const g = groups.get(key);
    g.totalMs += p.totalMs;
    g.projects.push(p);
    for (const day of Object.keys(p.byDay)) g.days.add(day);
  }

  const rows = [...groups.values()].sort((a, b) => b.totalMs - a.totalMs);
  const max = Math.max(...rows.map((r) => r.totalMs), 1);
  const grand = rows.reduce((acc, r) => acc + r.totalMs, 0);

  const body = rows.map((g) => {
    const pct = (g.totalMs / max) * 100;
    const share = grand ? (g.totalMs / grand) * 100 : 0;
    return `
      <tr>
        <td><div class="proj-name">${esc(g.name)}</div>
            <div class="proj-path">${g.projects.slice(0, 4).map((p) => esc(p.displayName)).join(' · ')}${g.projects.length > 4 ? ` +${g.projects.length - 4}` : ''}</div></td>
        <td class="bar-cell"><div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(2)}%"></div></div></td>
        <td class="num hours">${fmtHours(g.totalMs)}</td>
        <td class="num dim">${share.toFixed(1)}%</td>
        <td class="num dim">${g.projects.length}</td>
        <td class="num dim">${g.days.size}</td>
      </tr>`;
  }).join('');

  panel.innerHTML = `
    <div class="table-wrap"><div class="scroll-x"><table>
      <thead><tr>
        <th>Client</th><th></th><th class="num">Hours</th>
        <th class="num">Share</th><th class="num">Projects</th><th class="num">Days</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table></div></div>`;
}

function renderFooter() {
  if (!report) return;
  const idleMin = report.idleSeconds / 60;
  const failed = report.scan.filesFailed;
  const measured = report.scan.sessionsMeasured ?? 0;
  const inferred = report.scan.sessionsInferred ?? 0;

  // Say which sessions were measured and which were guessed at. A total that
  // mixes the two should not look uniformly precise.
  const basis = inferred === 0
    ? `${measured} sessions measured from recorded turn times`
    : `${measured} measured from recorded turn times · ` +
      `${inferred} estimated from activity gaps (idle cutoff ${idleMin} min)`;

  $('footer-meta').textContent =
    `${basis} · ` +
    `${report.scan.filesScanned} session logs (${report.scan.filesFromCache} cached) · ` +
    `generated ${new Date(report.generatedAt).toLocaleTimeString()}`;

  // A skipped log means the totals are undercounted — never hide that.
  if (failed > 0) {
    toast(`${failed} session log${failed > 1 ? 's' : ''} could not be read — totals are incomplete`, true);
  }

  if (report.warnings?.length) {
    console.warn('Claude Meter scan warnings:', report.warnings);
    // A cache write that failed leaves the totals correct but the next load slow.
    // It used to surface as a 500, so it must not now vanish into the console.
    const cacheWarning = report.warnings.find(w => w.startsWith('Timeline cache'));
    if (cacheWarning && failed === 0) toast(cacheWarning);
  }
}

/* ---------- events ---------- */

function setTab(tab) {
  state.tab = tab;
  for (const btn of document.querySelectorAll('.tab')) {
    btn.classList.toggle('is-active', btn.dataset.tab === tab);
  }
  $('panel-projects').hidden = tab !== 'projects';
  $('panel-timeline').hidden = tab !== 'timeline';
  $('panel-clients').hidden = tab !== 'clients';
  $('group-field').hidden = tab !== 'timeline';
  saveState();
}

function wire() {
  $('range-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.range = chip.dataset.range;
    for (const c of document.querySelectorAll('.chip')) c.classList.toggle('is-active', c === chip);
    saveState();
    load();
  });

  $('custom-apply').addEventListener('click', () => {
    const start = $('custom-start').value;
    const end = $('custom-end').value;
    if (!start || !end) return toast('Pick both a start and an end date', true);
    if (start > end) return toast('Start date is after the end date', true);
    state.range = 'custom';
    state.customStart = start;
    state.customEnd = end;
    for (const c of document.querySelectorAll('.chip')) c.classList.remove('is-active');
    saveState();
    load();
  });

  $('idle-select').addEventListener('change', (e) => {
    state.idle = Number(e.target.value);
    saveState();
    load();
  });

  $('refresh-btn').addEventListener('click', () => load(true));

  $('tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (tab) setTab(tab.dataset.tab);
  });

  // Anything that changes which projects are on screen has to go through
  // renderAll, because the wall-clock union is computed server-side for exactly
  // the visible selection. Repainting without re-fetching it leaves the summed
  // total describing the filtered set and the wall-clock still describing the
  // previous one — which shows up as a wall-clock larger than the summed total,
  // and a concurrency below 1x. renderAll no-ops the fetch when the selection
  // is genuinely unchanged, so routing through it costs nothing.
  $('search').addEventListener('input', (e) => {
    state.search = e.target.value;
    saveState();
    renderAll();
  });

  for (const [id, key] of [['filter-client', 'client'], ['filter-tag', 'tag'], ['sort', 'sort']]) {
    $(id).addEventListener('change', (e) => {
      state[key] = e.target.value;
      saveState();
      renderAll();
    });
  }

  $('show-hidden').addEventListener('change', (e) => {
    state.showHidden = e.target.checked;
    saveState();
    renderAll();
  });

  $('group-by').addEventListener('change', (e) => {
    state.groupBy = e.target.value;
    openDay = null;
    saveState();
    // Bucket keys are part of the wall-clock request, so a grouping change
    // needs a refetch too — day buckets cannot answer a month view.
    renderAll();
  });

  $('panel-projects').addEventListener('click', async (e) => {
    const saveBtn = e.target.closest('#save-meta');
    if (saveBtn) {
      e.stopPropagation();
      const path = saveBtn.dataset.path;
      const patch = {
        client: $('edit-client').value,
        tags: $('edit-tags').value.split(',').map((t) => t.trim()).filter(Boolean),
        alias: $('edit-alias').value,
        hidden: $('edit-hidden').checked,
      };
      try {
        saveBtn.classList.add('is-busy');
        await saveMeta(path, patch);
        toast('Saved');
        await load();
      } catch (err) {
        toast(err.message, true);
      } finally {
        saveBtn.classList.remove('is-busy');
      }
      return;
    }

    if (e.target.closest('.detail')) return; // don't collapse while editing

    const row = e.target.closest('tr.row');
    if (!row) return;
    openProject = openProject === row.dataset.project ? null : row.dataset.project;
    renderProjects();
  });

  $('panel-timeline').addEventListener('click', (e) => {
    if (e.target.closest('.detail')) return;

    const monthHead = e.target.closest('tr.month-head');
    if (monthHead) {
      const key = monthHead.dataset.month;
      if (collapsedMonths.has(key)) collapsedMonths.delete(key);
      else collapsedMonths.add(key);
      renderTimeline();
      return;
    }

    const row = e.target.closest('tr.row');
    if (!row) return;
    openDay = openDay === row.dataset.day ? null : row.dataset.day;
    renderTimeline();
  });

  // Hover layer for the timeline bars.
  //
  // The tooltip is built once as real elements and only its text nodes change
  // after that. It reads its content back out of a data attribute, and text
  // taken from the DOM and handed to innerHTML is parsed as markup — so the
  // whole category of mistake is removed by never producing markup here,
  // rather than by remembering to escape correctly every time.
  const tip = $('tooltip');
  const tipTitle = document.createElement('div');
  tipTitle.className = 'tt-title';
  const tipHours = tooltipRow('Hours');
  const tipProjects = tooltipRow('Projects');
  tip.replaceChildren(tipTitle, tipHours.row, tipProjects.row);

  document.addEventListener('mousemove', (e) => {
    const track = e.target.closest('.bar-track[data-tip]');
    if (!track) { tip.hidden = true; return; }
    const [day, hrs, count] = track.dataset.tip.split('|');
    tipTitle.textContent = day;
    tipHours.value.textContent = hrs;
    tipProjects.value.textContent = count;
    tip.hidden = false;
    const pad = 14;
    const x = Math.min(e.clientX + pad, window.innerWidth - tip.offsetWidth - pad);
    const y = Math.min(e.clientY + pad, window.innerHeight - tip.offsetHeight - pad);
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  });
}

function applyStateToControls() {
  $('idle-select').value = String(state.idle);
  $('search').value = state.search;
  $('sort').value = state.sort;
  $('show-hidden').checked = state.showHidden;
  $('group-by').value = state.groupBy;
  $('custom-start').value = state.customStart;
  $('custom-end').value = state.customEnd;

  for (const c of document.querySelectorAll('.chip')) {
    c.classList.toggle('is-active', state.range === c.dataset.range);
  }
  setTab(state.tab);
}

restoreState();
applyStateToControls();
wire();
load();
