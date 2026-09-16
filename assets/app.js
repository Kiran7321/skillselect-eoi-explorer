/* SkillSelect EOI Explorer — client-side SQL over a static SQLite file via sql.js-httpvfs. */
(function () {
  'use strict';

  // Small-cell suppression: the source dashboard hides any count below 20 to
  // avoid identifying individuals from rare combinations. We keep the same
  // rule for any single-combo figure, even though our raw pull has exact
  // numbers. Only clearly-safe aggregate totals bypass this.
  function fmt(n) {
    if (n === null || n === undefined) return '—';
    if (n < 20) return '<20';
    return n.toLocaleString('en-AU');
  }
  function fmtRaw(n) {
    if (n === null || n === undefined) return '—';
    return n.toLocaleString('en-AU');
  }

  const FIELD_META = {
    visa_type: { table: 'dim_visa_type', label: 'Visa Type' },
    eoi_status: { table: 'dim_eoi_status', label: 'EOI Status' },
    occupation: { table: 'dim_occupation', label: 'Occupation' },
    occupation_group: { table: 'dim_occupation_group', label: 'Occupation Group' },
    nominated_state: { table: 'dim_nominated_state', label: 'Nominated State' },
    nominated_state_type: { table: 'dim_nominated_state_type', label: 'State Type' },
    score: { table: 'dim_score', label: 'Points Score' },
    english_test_score: { table: 'dim_english_test_score', label: 'English Test Score' },
    australian_study_flag: { table: 'dim_australian_study_flag', label: 'Australian Study' },
    regional_study: { table: 'dim_regional_study', label: 'Regional Study' },
    comm_language_qual: { table: 'dim_comm_language_qual', label: 'Comm. Language Qual' },
    specialist_education: { table: 'dim_specialist_education', label: 'Specialist Education' },
    professional_year: { table: 'dim_professional_year', label: 'Professional Year' },
    partnerskills_score: { table: 'dim_partnerskills_score', label: 'Partner Skills Score' },
    month_submitted: { table: 'dim_month_submitted', label: 'Month Submitted' },
    as_at_month: { table: 'dim_as_at_month', label: 'As At Month' },
  };

  const TRENDS_FIELDS = ['visa_type', 'eoi_status', 'occupation', 'occupation_group', 'nominated_state', 'score'];
  const SNAPSHOT_FIELDS = [
    'visa_type', 'eoi_status', 'occupation', 'occupation_group', 'nominated_state',
    'nominated_state_type', 'score', 'english_test_score', 'australian_study_flag',
    'regional_study', 'comm_language_qual', 'specialist_education', 'professional_year',
    'partnerskills_score', 'month_submitted',
  ];
  const SEARCHABLE = new Set(['occupation', 'occupation_group', 'month_submitted']);

  const state = {
    tab: 'trends',
    filters: { trends: {}, snapshot: {} },
    monthRange: { fromIdx: null, toIdx: null },
    dims: {},
    db: null,
    latestMonth: null,
    months: [],
    renderToken: 0,
  };
  TRENDS_FIELDS.concat(SNAPSHOT_FIELDS).forEach((f) => {
    state.filters.trends[f] = new Set();
    state.filters.snapshot[f] = new Set();
  });

  const charts = {};

  function setStatus(text, ok) {
    document.getElementById('dbStatusText').textContent = text;
    document.querySelector('#dbStatus .dot').style.background = ok ? 'var(--good)' : 'var(--warn)';
  }

  async function initDb() {
    const workerUrl = new URL('vendor/sqlite.worker.js', document.baseURI).toString();
    const wasmUrl = new URL('vendor/sql-wasm.wasm', document.baseURI).toString();
    const configResp = await fetch(new URL('data/skillselect.config.json', document.baseURI));
    if (!configResp.ok) throw new Error('Could not load data/skillselect.config.json');
    const config = await configResp.json();
    // urlPrefix is relative to the page; resolve it against baseURI so the
    // dashboard also works when served from a sub-path (e.g. GitHub Pages
    // project sites at user.github.io/repo/).
    config.config.urlPrefix = new URL(config.config.urlPrefix, document.baseURI).toString();
    const workerObj = await createDbWorker([config], workerUrl, wasmUrl);
    state.db = workerObj.db;
  }

  async function q(sql, ...params) {
    return state.db.query(sql, params);
  }

  // sql.js-httpvfs runs everything through a single worker-side SQLite
  // connection. Firing several query() calls concurrently (Promise.all)
  // against it causes severe contention in the underlying lazy-fetch VFS and
  // can hang for 10s of seconds. Queries against `state.db` must run one at
  // a time — this helper also bails out early (without running the rest) if
  // a newer render has superseded this one, via the `token` render guard.
  async function qSequential(token, specs) {
    const results = [];
    for (const [sql, ...params] of specs) {
      if (token !== state.renderToken) return null;
      results.push(await q(sql, ...params));
    }
    return results;
  }

  const ORDER_SQL = {
    as_at_month: 'id',
    month_submitted: 'substr(label,4,4), substr(label,1,2)',
    score: 'CAST(label AS INTEGER)',
    partnerskills_score: 'CAST(label AS INTEGER)',
  };

  async function loadDims() {
    for (const [field, meta] of Object.entries(FIELD_META)) {
      const orderBy = ORDER_SQL[field] || 'label';
      const rows = await q(`SELECT id, label FROM ${meta.table} ORDER BY ${orderBy}`);
      state.dims[field] = rows;
    }
    state.months = state.dims.as_at_month.map((r) => r.label);
    const metaRows = await q(`SELECT value FROM meta WHERE key = 'latest_month'`);
    state.latestMonth = metaRows[0] ? metaRows[0].value : state.months[state.months.length - 1];
    state.monthRange.fromIdx = 0;
    state.monthRange.toIdx = state.dims.as_at_month.length - 1;
  }

  // ---------- Sidebar ----------

  function fieldsForTab(tab) {
    return tab === 'trends' ? TRENDS_FIELDS : SNAPSHOT_FIELDS;
  }

  function renderSidebar() {
    const sidebar = document.getElementById('sidebar');
    sidebar.innerHTML = '';

    const head = document.createElement('div');
    head.className = 'sidebar-head';
    head.innerHTML = `
      <h2>Filters</h2>
      <div class="sidebar-head-actions">
        <button class="clear-btn" id="clearFiltersBtn">Clear all</button>
        <button class="sidebar-close" id="sidebarCloseBtn" type="button" aria-label="Close filters">&times;</button>
      </div>`;
    sidebar.appendChild(head);

    if (state.tab === 'trends') {
      sidebar.appendChild(buildMonthRangeControl());
    } else {
      const snapNote = document.createElement('div');
      snapNote.className = 'filter-group';
      snapNote.style.cssText = 'padding:10px 12px; font-size:12px; color:var(--text-dim);';
      snapNote.innerHTML = `Snapshot as at <strong style="color:var(--text)">${state.latestMonth}</strong> &mdash; every field available, latest month only.`;
      sidebar.appendChild(snapNote);
    }

    for (const field of fieldsForTab(state.tab)) {
      sidebar.appendChild(buildFilterGroup(field));
    }

    document.getElementById('clearFiltersBtn').addEventListener('click', () => {
      fieldsForTab(state.tab).forEach((f) => state.filters[state.tab][f].clear());
      if (state.tab === 'trends') {
        state.monthRange.fromIdx = 0;
        state.monthRange.toIdx = state.dims.as_at_month.length - 1;
      }
      renderSidebar();
      triggerRender();
    });
    document.getElementById('sidebarCloseBtn').addEventListener('click', closeFilterDrawer);

    updateFiltersToggleBadge();
  }

  function updateFiltersToggleBadge() {
    const count = fieldsForTab(state.tab).reduce((n, f) => n + state.filters[state.tab][f].size, 0);
    const badge = document.getElementById('filtersToggleBadge');
    badge.hidden = count === 0;
    badge.textContent = count;
  }

  function openFilterDrawer() {
    document.getElementById('sidebar').classList.add('open');
    document.getElementById('sidebarBackdrop').hidden = false;
    document.body.classList.add('drawer-open');
  }
  function closeFilterDrawer() {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebarBackdrop').hidden = true;
    document.body.classList.remove('drawer-open');
  }
  document.getElementById('filtersToggle').addEventListener('click', openFilterDrawer);
  document.getElementById('sidebarBackdrop').addEventListener('click', closeFilterDrawer);

  function buildMonthRangeControl() {
    const wrap = document.createElement('details');
    wrap.className = 'filter-group';
    wrap.open = true;
    const opts = state.months.map((m, i) => `<option value="${i}">${m}</option>`).join('');
    wrap.innerHTML = `
      <summary>As At Month range <span class="chev">&rsaquo;</span></summary>
      <div class="filter-body">
        <label style="font-size:11px;color:var(--text-faint);">From</label>
        <select id="monthFrom" class="filter-search" style="margin-bottom:8px;">${opts}</select>
        <label style="font-size:11px;color:var(--text-faint);">To</label>
        <select id="monthTo" class="filter-search">${opts}</select>
      </div>`;
    queueMicrotask(() => {
      const fromSel = wrap.querySelector('#monthFrom');
      const toSel = wrap.querySelector('#monthTo');
      fromSel.value = state.monthRange.fromIdx;
      toSel.value = state.monthRange.toIdx;
      fromSel.addEventListener('change', () => {
        state.monthRange.fromIdx = Number(fromSel.value);
        if (state.monthRange.fromIdx > state.monthRange.toIdx) { state.monthRange.toIdx = state.monthRange.fromIdx; toSel.value = state.monthRange.toIdx; }
        triggerRender();
      });
      toSel.addEventListener('change', () => {
        state.monthRange.toIdx = Number(toSel.value);
        if (state.monthRange.toIdx < state.monthRange.fromIdx) { state.monthRange.fromIdx = state.monthRange.toIdx; fromSel.value = state.monthRange.fromIdx; }
        triggerRender();
      });
    });
    return wrap;
  }

  function buildFilterGroup(field) {
    const meta = FIELD_META[field];
    const items = state.dims[field] || [];
    const selected = state.filters[state.tab][field];

    const details = document.createElement('details');
    details.className = 'filter-group';
    details.open = false; // always start collapsed — keeps the sidebar short and scannable

    // Everything but <summary> is hidden by the browser natively while a
    // <details> is closed, no matter what CSS says — so the "which values
    // are selected" preview has to live INSIDE summary, as a second row
    // under the name/badge/chevron line, not as a sibling of it.
    const summary = document.createElement('summary');
    const summaryTop = document.createElement('div');
    summaryTop.className = 'summary-top';
    const nameWrap = document.createElement('span');
    nameWrap.className = 'summary-name';
    nameWrap.textContent = meta.label;
    const badge = document.createElement('span');
    badge.className = 'count-badge';
    badge.style.display = selected.size ? '' : 'none';
    badge.textContent = selected.size;
    const chev = document.createElement('span');
    chev.className = 'chev';
    chev.textContent = '›';
    summaryTop.appendChild(nameWrap);
    summaryTop.appendChild(badge);
    summaryTop.appendChild(chev);
    summary.appendChild(summaryTop);

    // When collapsed, show which values are picked right under the header
    // so you don't have to open every group to remember what's filtered.
    const dimMap = new Map(items.map((it) => [it.id, it.label]));
    const preview = document.createElement('div');
    preview.className = 'summary-preview';
    function updatePreview() {
      if (!selected.size) { preview.textContent = ''; preview.hidden = true; return; }
      preview.hidden = false;
      const names = [...selected].slice(0, 3).map((id) => dimMap.get(id)).join(', ');
      preview.textContent = names + (selected.size > 3 ? ` +${selected.size - 3} more` : '');
    }
    updatePreview();
    summary.appendChild(preview);
    details.appendChild(summary);

    const body = document.createElement('div');
    body.className = 'filter-body';

    if (field === 'score') {
      const note = document.createElement('div');
      note.className = 'panel-note';
      note.textContent = 'Skilled visas use a 0–130 scale. Values above 130 are Business Innovation & Investment visas (132/188), a separate unrelated scale.';
      body.appendChild(note);
    }

    const search = document.createElement('input');
    search.type = 'text';
    search.placeholder = `Search ${meta.label.toLowerCase()}…`;
    search.className = 'filter-search';
    body.appendChild(search);
    search.addEventListener('input', () => {
      const term = search.value.trim().toLowerCase();
      list.querySelectorAll('.filter-item').forEach((el) => {
        el.style.display = el.dataset.label.includes(term) ? '' : 'none';
      });
    });

    const actions = document.createElement('div');
    actions.className = 'filter-actions';
    actions.innerHTML = `<button class="mini-btn" data-act="all">Select visible</button><button class="mini-btn" data-act="none">Clear</button>`;
    body.appendChild(actions);

    const list = document.createElement('div');
    list.className = 'filter-list';
    for (const item of items) {
      const row = document.createElement('label');
      row.className = 'filter-item';
      row.dataset.label = item.label.toLowerCase();
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = selected.has(item.id);
      cb.addEventListener('change', () => {
        if (cb.checked) selected.add(item.id); else selected.delete(item.id);
        badge.style.display = selected.size ? '' : 'none';
        badge.textContent = selected.size;
        updatePreview();
        updateFiltersToggleBadge();
        triggerRender();
      });
      const lbl = document.createElement('span');
      lbl.className = 'lbl';
      lbl.textContent = item.label;
      lbl.title = item.label;
      row.appendChild(cb);
      row.appendChild(lbl);
      list.appendChild(row);
    }
    body.appendChild(list);
    details.appendChild(body);

    actions.addEventListener('click', (e) => {
      const act = e.target.dataset.act;
      if (!act) return;
      const visibleChecks = [...list.querySelectorAll('.filter-item')].filter((el) => el.style.display !== 'none');
      visibleChecks.forEach((el) => {
        el.querySelector('input').checked = act === 'all';
      });
      // Rebuild `selected` from the checkbox states directly (single pass,
      // no per-checkbox change events) so a bulk toggle triggers exactly one render.
      selected.clear();
      list.querySelectorAll('.filter-item').forEach((el) => {
        const cb = el.querySelector('input');
        if (cb.checked) {
          const label = el.dataset.label;
          const match = items.find((it) => it.label.toLowerCase() === label);
          if (match) selected.add(match.id);
        }
      });
      badge.style.display = selected.size ? '' : 'none';
      badge.textContent = selected.size;
      updatePreview();
      updateFiltersToggleBadge();
      triggerRender();
    });

    return details;
  }

  // ---------- WHERE builder ----------

  function buildWhere(tab, opts = {}) {
    const fields = fieldsForTab(tab);
    const clauses = [];
    const params = [];
    for (const field of fields) {
      const sel = state.filters[tab][field];
      if (sel.size && field !== opts.excludeField) {
        clauses.push(`${field}_id IN (${[...sel].map(() => '?').join(',')})`);
        params.push(...sel);
      }
    }
    // Only add the month-range predicate when it's actually narrower than
    // the full span. Adding a "BETWEEN <min> AND <max>" that matches every
    // row tempts SQLite into using the as_at_month index for a non-selective
    // scan, which means a non-covering index walk + a rowid lookup per row
    // instead of one plain sequential SCAN — much worse for range-request
    // storage. Confirmed via EXPLAIN QUERY PLAN during testing.
    const isFullRange = state.monthRange.fromIdx === 0 && state.monthRange.toIdx === state.dims.as_at_month.length - 1;
    if (tab === 'trends' && !opts.noMonthRange && !isFullRange) {
      const fromId = state.dims.as_at_month[state.monthRange.fromIdx].id;
      const toId = state.dims.as_at_month[state.monthRange.toIdx].id;
      clauses.push('as_at_month_id BETWEEN ? AND ?');
      params.push(Math.min(fromId, toId), Math.max(fromId, toId));
    }
    return { where: clauses.length ? 'WHERE ' + clauses.join(' AND ') : '', params };
  }

  function activeChipRow(tab) {
    const row = document.createElement('div');
    row.className = 'chip-row';
    let any = false;
    for (const field of fieldsForTab(tab)) {
      const sel = state.filters[tab][field];
      if (!sel.size) continue;
      any = true;
      const meta = FIELD_META[field];
      const dimMap = new Map(state.dims[field].map((d) => [d.id, d.label]));
      const names = [...sel].slice(0, 3).map((id) => dimMap.get(id)).join(', ');
      const extra = sel.size > 3 ? ` +${sel.size - 3}` : '';
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.innerHTML = `${meta.label}: ${names}${extra} <button title="Clear">&times;</button>`;
      chip.querySelector('button').addEventListener('click', () => {
        sel.clear();
        renderSidebar();
        triggerRender();
      });
      row.appendChild(chip);
    }
    if (tab === 'trends') {
      const fromM = state.months[state.monthRange.fromIdx];
      const toM = state.months[state.monthRange.toIdx];
      if (!(state.monthRange.fromIdx === 0 && state.monthRange.toIdx === state.months.length - 1)) {
        any = true;
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.innerHTML = `As At Month: ${fromM} → ${toM}`;
        row.appendChild(chip);
      }
    }
    return any ? row : null;
  }

  // ---------- Rendering: Trends tab ----------

  async function renderTrends(token) {
    const el = document.getElementById('view-trends');
    el.innerHTML = '<div class="loading-overlay"><span class="spinner"></span> Querying…</div>';

    const { where, params } = buildWhere('trends');
    const table = 'fact_history';

    const rows = await qSequential(token, [
      [`SELECT SUM(count) AS total, COUNT(*) AS combos FROM ${table} ${where}`, ...params],
      [
        `SELECT dam.id AS mid, dam.label AS month, SUM(fh.count) AS total
         FROM ${table} fh JOIN dim_as_at_month dam ON dam.id = fh.as_at_month_id
         ${where} GROUP BY fh.as_at_month_id ORDER BY dam.id`, ...params,
      ],
      [
        `SELECT dvt.label AS label, SUM(fh.count) AS total
         FROM ${table} fh JOIN dim_visa_type dvt ON dvt.id = fh.visa_type_id
         ${where} GROUP BY fh.visa_type_id ORDER BY total DESC`, ...params,
      ],
      [
        `SELECT des.label AS label, SUM(fh.count) AS total
         FROM ${table} fh JOIN dim_eoi_status des ON des.id = fh.eoi_status_id
         ${where} GROUP BY fh.eoi_status_id ORDER BY total DESC`, ...params,
      ],
      [
        `SELECT dns.label AS label, SUM(fh.count) AS total
         FROM ${table} fh JOIN dim_nominated_state dns ON dns.id = fh.nominated_state_id
         ${where} GROUP BY fh.nominated_state_id ORDER BY total DESC`, ...params,
      ],
      [
        `SELECT doc.label AS label, SUM(fh.count) AS total
         FROM ${table} fh JOIN dim_occupation doc ON doc.id = fh.occupation_id
         ${where} GROUP BY fh.occupation_id ORDER BY total DESC LIMIT 15`, ...params,
      ],
      [
        `SELECT dsc.label AS label, SUM(fh.count) AS total
         FROM ${table} fh JOIN dim_score dsc ON dsc.id = fh.score_id
         ${where} GROUP BY fh.score_id ORDER BY CAST(dsc.label AS INTEGER) DESC`, ...params,
      ],
    ]);
    if (!rows) return; // superseded by a newer render
    const [[totalRow], byMonth, byVisa, byStatus, byState, topOcc, byScore] = rows;

    el.innerHTML = '';
    const chips = activeChipRow('trends');

    const statRow = document.createElement('div');
    statRow.className = 'stat-row';
    statRow.appendChild(statCard('Total EOIs (matched)', fmtRaw(totalRow.total || 0), `summed across ${byMonth.length} monthly snapshots`));
    statRow.appendChild(statCard('Distinct combinations', fmtRaw(totalRow.combos || 0), 'visa × status × occupation × state × score'));
    statRow.appendChild(statCard('Top visa type', byVisa[0] ? byVisa[0].label.slice(0, 22) : '—', byVisa[0] ? `${fmtRaw(byVisa[0].total)} EOIs` : ''));
    statRow.appendChild(statCard('Top nominated state', byState[0] ? explainStateLabel(byState[0].label) : '—', byState[0] ? `${fmtRaw(byState[0].total)} EOIs` : ''));

    if (chips) el.appendChild(chips);
    el.appendChild(scopeBanner(
      'These totals are summed across every matching month in the selected range — the same EOI can be counted in multiple monthly snapshots. Switch to “Latest Snapshot” for a single-point-in-time count.'
    ));
    el.appendChild(statRow);

    const trendPanel = panel('EOIs over time', 'Sum of matching EOIs per snapshot month');
    const canvasWrap = document.createElement('div');
    canvasWrap.className = 'chart-wrap';
    const canvas = document.createElement('canvas');
    canvasWrap.appendChild(canvas);
    trendPanel.body.appendChild(canvasWrap);
    el.appendChild(trendPanel.el);

    drawLineChart(canvas, byMonth.map((r) => r.month), byMonth.map((r) => r.total), 'Total EOIs');

    const grid = document.createElement('div');
    grid.className = 'grid-3';
    grid.appendChild(breakdownPanel('By Visa Type', byVisa));
    grid.appendChild(breakdownPanel('By EOI Status', byStatus, true));
    grid.appendChild(breakdownPanel('By Nominated State', explainStateRows(byState)));
    el.appendChild(grid);

    const grid2 = document.createElement('div');
    grid2.className = 'grid-2';
    grid2.appendChild(breakdownPanel('Top Occupations', topOcc));
    grid2.appendChild(breakdownPanel(
      'By Points Score', byScore, false, true,
      'Skilled visas (189/190/491/etc) use the General Skilled Migration points test, max 130. Scores above that belong to Business Innovation & Investment visas (132/188 series), which use a separate, unrelated points scale.'
    ));
    el.appendChild(grid2);
  }

  // ---------- Rendering: Snapshot tab ----------

  async function renderSnapshot(token) {
    const el = document.getElementById('view-snapshot');
    el.innerHTML = '<div class="loading-overlay"><span class="spinner"></span> Querying…</div>';

    const { where, params } = buildWhere('snapshot');
    const table = 'fact_snapshot';

    const rows = await qSequential(token, [
      [`SELECT SUM(count) AS total, COUNT(*) AS combos FROM ${table} ${where}`, ...params],
      [`SELECT dvt.label AS label, SUM(fs.count) AS total FROM ${table} fs JOIN dim_visa_type dvt ON dvt.id=fs.visa_type_id ${where} GROUP BY fs.visa_type_id ORDER BY total DESC`, ...params],
      [`SELECT d.label AS label, SUM(fs.count) AS total FROM ${table} fs JOIN dim_eoi_status d ON d.id=fs.eoi_status_id ${where} GROUP BY fs.eoi_status_id ORDER BY total DESC`, ...params],
      [`SELECT d.label AS label, SUM(fs.count) AS total FROM ${table} fs JOIN dim_nominated_state d ON d.id=fs.nominated_state_id ${where} GROUP BY fs.nominated_state_id ORDER BY total DESC`, ...params],
      [`SELECT d.label AS label, SUM(fs.count) AS total FROM ${table} fs JOIN dim_english_test_score d ON d.id=fs.english_test_score_id ${where} GROUP BY fs.english_test_score_id ORDER BY total DESC`, ...params],
      [`SELECT d.label AS label, SUM(fs.count) AS total FROM ${table} fs JOIN dim_australian_study_flag d ON d.id=fs.australian_study_flag_id ${where} GROUP BY fs.australian_study_flag_id ORDER BY total DESC`, ...params],
      [`SELECT d.label AS label, SUM(fs.count) AS total FROM ${table} fs JOIN dim_occupation d ON d.id=fs.occupation_id ${where} GROUP BY fs.occupation_id ORDER BY total DESC LIMIT 20`, ...params],
      [`SELECT d.label AS label, SUM(fs.count) AS total FROM ${table} fs JOIN dim_month_submitted d ON d.id=fs.month_submitted_id ${where} GROUP BY fs.month_submitted_id ORDER BY substr(d.label,4,4), substr(d.label,1,2)`, ...params],
    ]);
    if (!rows) return; // superseded by a newer render
    const [[totalRow], byVisa, byStatus, byState, byEnglish, byAusStudy, topOcc, byMonthSub] = rows;

    el.innerHTML = '';
    const chips = activeChipRow('snapshot');

    const statRow = document.createElement('div');
    statRow.className = 'stat-row';
    statRow.appendChild(statCard('Total EOIs (matched)', fmtRaw(totalRow.total || 0), `as at ${state.latestMonth}`));
    statRow.appendChild(statCard('Distinct combinations', fmtRaw(totalRow.combos || 0), 'every field, full detail'));
    statRow.appendChild(statCard('Top visa type', byVisa[0] ? byVisa[0].label.slice(0, 22) : '—', byVisa[0] ? `${fmtRaw(byVisa[0].total)} EOIs` : ''));
    statRow.appendChild(statCard('Top occupation', topOcc[0] ? topOcc[0].label.slice(0, 26) : '—', topOcc[0] ? `${fmtRaw(topOcc[0].total)} EOIs` : ''));

    if (chips) el.appendChild(chips);
    el.appendChild(scopeBanner(`This is a single point-in-time count as at ${state.latestMonth} — nothing is summed across months.`));
    el.appendChild(statRow);

    const monthPanel = panel('EOIs by month submitted', 'How far back the matching EOIs were lodged');
    const canvasWrap = document.createElement('div');
    canvasWrap.className = 'chart-wrap';
    const canvas = document.createElement('canvas');
    canvasWrap.appendChild(canvas);
    monthPanel.body.appendChild(canvasWrap);
    el.appendChild(monthPanel.el);
    drawBarChart(canvas, byMonthSub.map((r) => r.label), byMonthSub.map((r) => r.total), 'EOIs');

    const grid = document.createElement('div');
    grid.className = 'grid-3';
    grid.appendChild(breakdownPanel('By Visa Type', byVisa));
    grid.appendChild(breakdownPanel('By EOI Status', byStatus, true));
    grid.appendChild(breakdownPanel('By Nominated State', explainStateRows(byState)));
    el.appendChild(grid);

    const grid2 = document.createElement('div');
    grid2.className = 'grid-3';
    grid2.appendChild(breakdownPanel('By English Test Score', byEnglish));
    grid2.appendChild(breakdownPanel('By Australian Study', byAusStudy));
    grid2.appendChild(breakdownPanel('Top Occupations', topOcc));
    el.appendChild(grid2);
  }

  // ---------- Small UI helpers ----------

  // A handful of Nominated State values aren't actual states — they mean
  // "no state nomination applies to this visa" in various source-system
  // spellings. Spelling them out avoids them reading as missing/broken data.
  const STATE_EXPLAIN = {
    'N/A': 'N/A — no state nomination',
    '-': 'None recorded',
    'ANY': 'Any state (no preference)',
    'AUSTRADE': 'Austrade-sponsored',
  };
  function explainStateLabel(label) {
    return STATE_EXPLAIN[label] || label;
  }
  function explainStateRows(rows) {
    return rows.map((r) => ({ ...r, label: explainStateLabel(r.label) }));
  }

  function scopeBanner(text) {
    const d = document.createElement('div');
    d.className = 'scope-banner';
    d.textContent = text;
    return d;
  }

  function statCard(label, value, sub) {
    const d = document.createElement('div');
    d.className = 'stat-card';
    d.innerHTML = `<div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub || ''}</div>`;
    return d;
  }

  function panel(title, hint) {
    const el = document.createElement('div');
    el.className = 'panel';
    const head = document.createElement('div');
    head.className = 'panel-head';
    head.innerHTML = `<h3>${title}</h3><span class="hint">${hint || ''}</span>`;
    const body = document.createElement('div');
    el.appendChild(head);
    el.appendChild(body);
    return { el, body };
  }

  const STATUS_CLASS = { LODGED: 'status-lodged', INVITED: 'status-invited', SUSPENDED: 'status-suspended', WITHDRAWN: 'status-withdrawn' };

  function breakdownPanel(title, rows, isStatus, isScore, note) {
    const p = panel(title, `${rows.length} shown`);
    if (note) {
      const noteEl = document.createElement('div');
      noteEl.className = 'panel-note';
      noteEl.textContent = note;
      p.body.appendChild(noteEl);
    }
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'No matching data';
      p.body.appendChild(empty);
      return p.el;
    }
    const max = Math.max(...rows.map((r) => r.total || 0), 1);
    const wrap = document.createElement('div');
    wrap.className = 'table-scroll';
    const table = document.createElement('table');
    table.className = 'data-table';
    table.innerHTML = `<thead><tr><th>${isScore ? 'Score' : 'Label'}</th><th>Count</th><th></th></tr></thead>`;
    const tbody = document.createElement('tbody');
    for (const r of rows) {
      const tr = document.createElement('tr');
      const pct = ((r.total || 0) / max) * 100;
      let labelHtml = escapeHtml(r.label);
      if (isStatus) {
        const cls = STATUS_CLASS[r.label] || 'status-default';
        labelHtml = `<span class="badge ${cls}">${escapeHtml(r.label)}</span>`;
      }
      tr.innerHTML = `<td>${labelHtml}</td><td class="num">${fmt(r.total)}</td><td><div class="bar-cell"><div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div></div></td>`;
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    p.body.appendChild(wrap);
    return p.el;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function chartTheme() {
    return {
      grid: '#262d38',
      text: '#8b93a1',
      accent: '#5b8cff',
    };
  }

  function drawLineChart(canvas, labels, data, label) {
    const t = chartTheme();
    if (charts.line) charts.line.destroy();
    charts.line = new Chart(canvas, {
      type: 'line',
      data: { labels, datasets: [{ label, data, borderColor: t.accent, backgroundColor: 'rgba(91,140,255,0.15)', fill: true, tension: 0.3, pointRadius: 2 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: t.text, maxRotation: 60, minRotation: 45 }, grid: { color: t.grid } },
          y: { ticks: { color: t.text }, grid: { color: t.grid }, beginAtZero: true },
        },
      },
    });
  }

  function drawBarChart(canvas, labels, data, label) {
    const t = chartTheme();
    if (charts.bar) charts.bar.destroy();
    charts.bar = new Chart(canvas, {
      type: 'bar',
      data: { labels, datasets: [{ label, data, backgroundColor: t.accent }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: t.text, maxRotation: 70, minRotation: 45, autoSkip: true }, grid: { display: false } },
          y: { ticks: { color: t.text }, grid: { color: t.grid }, beginAtZero: true },
        },
      },
    });
  }

  // ---------- About tab ----------

  function renderAbout() {
    const el = document.getElementById('view-about');
    el.innerHTML = `
      <div class="panel">
        <div class="panel-head"><h3>About this site</h3></div>
        <p style="color:var(--text-dim); max-width:760px;">
          This is an unofficial, independently-built explorer for the Department of Employment and Workplace Relations'
          public <a href="https://api.dynamic.reports.employment.gov.au/anonap/extensions/hSKLS02_SkillSelect_EOI_Data/hSKLS02_SkillSelect_EOI_Data.html" target="_blank" rel="noopener">SkillSelect EOI dashboard</a>.
          The original dashboard only lets you view two extra columns at a time and pick a single "as at" month.
          This site lets you filter and cross-reference every field at once, and see trends across all available months.
        </p>
        <p style="color:var(--text-dim); max-width:760px;">
          <strong>Two datasets:</strong>
        </p>
        <ul style="color:var(--text-dim); max-width:760px;">
          <li><strong>History &amp; Trends</strong> &mdash; Visa Type, EOI Status, Occupation, Occupation Group, Nominated State and Points Score, across every monthly snapshot published so far.</li>
          <li><strong>Latest Snapshot (Full Detail)</strong> &mdash; every field the source exposes (English test score, Australian study, regional study, community language, specialist education, professional year, partner skills, month submitted) for the most recent month only.</li>
        </ul>
        <p style="color:var(--text-dim); max-width:760px;">
          <strong>Privacy:</strong> the source suppresses any count under 20 to avoid identifying individuals from small groups.
          This site keeps that same rule for any figure tied to a specific filter combination &mdash; you'll see "&lt;20" instead of an exact small number.
        </p>
        <p style="color:var(--text-dim); max-width:760px;">
          <strong>How it works:</strong> all the data lives in a single SQLite file queried directly in your browser (via WebAssembly and HTTP range requests) &mdash;
          there's no backend server, and your filters never leave your device.
        </p>
      </div>`;
  }

  // ---------- Tab switching & boot ----------

  // Every filter change calls this. It hands out a fresh token so that if
  // several changes fire in quick succession, only the last one's query
  // results are ever written to the DOM — earlier, now-stale in-flight
  // queries are detected (via the token check at the top of each render
  // function's DOM-write) and their results are silently dropped instead of
  // racing to overwrite the UI.
  async function triggerRender() {
    const token = ++state.renderToken;
    try {
      if (state.tab === 'trends') await renderTrends(token);
      else if (state.tab === 'snapshot') await renderSnapshot(token);
      else renderAbout();
    } catch (err) {
      if (token !== state.renderToken) return; // superseded; ignore
      console.error(err);
      const el = document.getElementById(state.tab === 'snapshot' ? 'view-snapshot' : 'view-trends');
      el.innerHTML = `<div class="empty-state">Query error: ${escapeHtml(err.message || String(err))}</div>`;
    }
  }

  function switchTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    document.getElementById('view-trends').hidden = tab !== 'trends';
    document.getElementById('view-snapshot').hidden = tab !== 'snapshot';
    document.getElementById('view-about').hidden = tab !== 'about';
    if (tab === 'trends' || tab === 'snapshot') renderSidebar();
    else document.getElementById('sidebar').innerHTML = '<div class="filter-group" style="padding:12px; font-size:12.5px; color:var(--text-dim);">No filters on this tab.</div>';
    triggerRender();
  }

  document.getElementById('tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (btn) switchTab(btn.dataset.tab);
  });

  (async function boot() {
    try {
      await initDb();
      setStatus('Loading fields…', true);
      await loadDims();
      document.getElementById('lastUpdated').textContent = `Latest snapshot: ${state.latestMonth}`;
      setStatus('Ready — querying in your browser', true);
    } catch (err) {
      console.error(err);
      setStatus('Failed to load database', false);
      document.getElementById('view-trends').innerHTML = `<div class="empty-state">Couldn't load the database: ${escapeHtml(err.message || String(err))}</div>`;
      return;
    }
    renderSidebar();
    await triggerRender();
  })();
})();
