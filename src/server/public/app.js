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

function restoreState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) Object.assign(state, JSON.parse(raw));
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
    renderAll();
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

function renderAll() {
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
  const wallMs = filtered ? null : report.totals.wallClockMs;
  const days = report.totals.activeDays;
  const sessions = shown.reduce((acc, p) => acc + p.sessionCount, 0);

  $('stat-total').innerHTML = `${fmtHours(totalMs)}<span class="unit">h</span>`;
  $('stat-range').textContent = filtered
    ? `${shown.length} of ${report.projects.length} projects`
    : labelFor(report.rangeLabel);

  $('stat-wall').innerHTML = wallMs === null
    ? '<span class="muted" style="font-size:0.5em">n/a filtered</span>'
    : `${fmtHours(wallMs)}<span class="unit">h</span>`;
  $('stat-concurrency').textContent = wallMs
    ? `${(report.totals.totalMs / wallMs).toFixed(2)}× avg concurrency`
    : 'clear filters to see';

  $('stat-days').textContent = String(days);
  $('stat-avg').textContent = days ? `${fmtHours(totalMs / days)} h/day avg` : '—';

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

  const allowed = visibleIds();
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
    // Wall-clock is only meaningful unfiltered — the union can't be re-derived from parts.
    if (allowed.size === report.projects.length) bucket.wallMs += day.wallClockMs;
  }

  const rows = [...buckets.values()].sort((a, b) => (a.key < b.key ? 1 : -1));
  if (rows.length === 0) {
    panel.innerHTML = `<div class="empty"><strong>No activity matches the filters</strong>Clear a filter to see the timeline.</div>`;
    return;
  }

  const max = Math.max(...rows.map((r) => r.totalMs), 1);
  const unfiltered = allowed.size === report.projects.length;

  const body = rows.map((r) => {
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
            <div class="bar-fill" style="width:${pct.toFixed(2)}%"></div>
          </div>
        </td>
        <td class="num hours">${fmtHours(r.totalMs)}</td>
        <td class="num hours-alt">${unfiltered ? fmtHours(r.wallMs) : '—'}</td>
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
        <span class="field-label">Projects in this ${state.groupBy}</span>
        <ul class="day-projects">${inner}</ul>
      </div>
    </div></td></tr>`;
  }).join('');

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
    const key = p.client ?? ' untagged';
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

  $('footer-meta').textContent =
    `Idle cutoff ${idleMin} min · gaps longer than this are excluded · ` +
    `${report.scan.filesScanned} session logs (${report.scan.filesFromCache} cached) · ` +
    `generated ${new Date(report.generatedAt).toLocaleTimeString()}`;

  // A skipped log means the totals are undercounted — never hide that.
  if (failed > 0) {
    toast(`${failed} session log${failed > 1 ? 's' : ''} could not be read — totals are incomplete`, true);
    console.warn('Claude Meter scan warnings:', report.warnings);
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

  $('search').addEventListener('input', (e) => {
    state.search = e.target.value;
    saveState();
    renderStats(); renderProjects(); renderTimeline(); renderClients();
  });

  for (const [id, key] of [['filter-client', 'client'], ['filter-tag', 'tag'], ['sort', 'sort']]) {
    $(id).addEventListener('change', (e) => {
      state[key] = e.target.value;
      saveState();
      renderStats(); renderProjects(); renderTimeline(); renderClients();
    });
  }

  $('show-hidden').addEventListener('change', (e) => {
    state.showHidden = e.target.checked;
    saveState();
    renderStats(); renderProjects(); renderTimeline(); renderClients();
  });

  $('group-by').addEventListener('change', (e) => {
    state.groupBy = e.target.value;
    openDay = null;
    saveState();
    renderTimeline();
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
    const row = e.target.closest('tr.row');
    if (!row) return;
    openDay = openDay === row.dataset.day ? null : row.dataset.day;
    renderTimeline();
  });

  // Hover layer for the timeline bars.
  const tip = $('tooltip');
  document.addEventListener('mousemove', (e) => {
    const track = e.target.closest('.bar-track[data-tip]');
    if (!track) { tip.hidden = true; return; }
    const [day, hrs, count] = track.dataset.tip.split('|');
    tip.innerHTML =
      `<div class="tt-title">${esc(day)}</div>` +
      `<div class="tt-row"><span>Hours</span><span>${esc(hrs)}</span></div>` +
      `<div class="tt-row"><span>Projects</span><span>${esc(count)}</span></div>`;
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
