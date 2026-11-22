// radar-score v3 dashboard — one plain script, no framework, no network.
//
// The page binds to window.RADAR, the JSON document main.ts writes as data.js
// next to this file. Everything shown is recomputable from that document:
// the board, the filters, the live-token table and the per-protocol drawer
// with its score breakdown and farm plan.

(function () {
  'use strict';
  const doc = window.RADAR;
  if (!doc) return;
  const stage = document.getElementById('board');
  const view = { query: '', category: 'all', pane: 'pre', sortKey: 'implied_value_usd', sortDir: -1, openSlug: null };

  function money(v) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
    if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
    if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
    if (v >= 1e3) return `$${Math.round(v / 1e3)}K`;
    return `$${Math.round(v)}`;
  }

  function pct(v) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    return `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
  }

  function age(v) {
    if (v === null || v === undefined) return 'unknown';
    if (v >= 365) return `${(v / 365).toFixed(1)} yr`;
    return `${Math.round(v)} d`;
  }

  function make(tag, attrs, kids) {
    const node = document.createElement(tag);
    const set = attrs || {};
    for (const key of Object.keys(set)) {
      const val = set[key];
      if (val === null || val === undefined) continue;
      if (key === 'class') node.className = val;
      else if (key === 'text') node.textContent = val;
      else if (key.startsWith('on') && typeof val === 'function') node.addEventListener(key.slice(2), val);
      else node.setAttribute(key, String(val));
    }
    for (const child of kids || []) {
      if (child === null || child === undefined) continue;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  function chainLabel(proto) {
    if (proto.chains && proto.chains.length > 0) return proto.chains.slice(0, 3).join(', ');
    return 'chain not recorded';
  }

  function recompute(row) {
    const p = doc.params;
    const base = row.breakdown.base_weight;
    const tvlTerm = Math.pow(row.tvl_usd / p.tvl_scale, p.tvl_exponent);
    const momentum = Math.max(0.2, 1 + (row.breakdown.growth_used_pct / 100) * p.growth_sensitivity);
    const maturity = p.maturity_floor + (Math.min(Math.max(row.breakdown.age_days_used ?? p.assumed_age_days, 0), p.maturity_span_days) / p.maturity_span_days) * p.maturity_gain;
    const diversity = 1 + Math.min(row.chains.length * p.chain_step, p.chain_cap);
    return Math.max(p.min_implied, Math.round(base * tvlTerm * momentum * maturity * diversity * 1e6));
  }

  function hashSync() {
    const parts = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    view.query = parts.get('q') || '';
    view.category = parts.get('cat') || 'all';
    view.openSlug = parts.get('p') || null;
  }

  function hashPush() {
    const parts = new URLSearchParams();
    if (view.query) parts.set('q', view.query);
    if (view.category !== 'all') parts.set('cat', view.category);
    if (view.openSlug) parts.set('p', view.openSlug);
    const next = parts.toString();
    window.history.replaceState(null, '', next ? `#${next}` : window.location.pathname + window.location.search);
  }

  function filteredRows() {
    const needle = view.query.trim().toLowerCase();
    return doc.rows.filter((row) => {
      if (view.category !== 'all' && (row.category || 'Other') !== view.category) return false;
      if (!needle) return true;
      const hay = [row.name, row.slug, row.category || '', row.chains.join(' ')].join(' ').toLowerCase();
      return hay.includes(needle);
    });
  }

  function orderedRows(list) {
    const k = view.sortKey;
    const d = view.sortDir;
    return list.slice().sort((a, b) => {
      let av;
      let bv;
      if (k === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (k === 'tvl_usd') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (k === 'change_7d') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (k === 'age_days') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -d;
      if (av > bv) return d;
      return a.slug < b.slug ? -1 : 1;
    });
  }

  function masthead() {
    return make('header', { class: 'masthead' }, [
      make('div', { class: 'masthead-left' }, [
        make('span', { class: 'glyph', 'aria-hidden': 'true' }),
        make('div', null, [
          make('strong', { class: 'wordmark', text: 'Token Radar' }),
          make('small', { text: doc.score_tag })
        ])
      ]),
      make('div', { class: 'masthead-meta' }, [
        make('span', { text: `snapshot ${doc.as_of}` }),
        make('span', { text: doc.source }),
        make('span', { text: `floor ${money(doc.floor_usd)}` })
      ])
    ]);
  }

  function summary() {
    return make('section', { class: 'summary' }, [
      make('div', { class: 'summary-text' }, [
        make('h1', { text: `${doc.watch_count} watched protocols, ${doc.board_count} ranked` }),
        make('p', { text: `The watchlist is the floor, not the ceiling: it names the ${doc.watch_count} protocols at or above ${money(doc.floor_usd)} of TVL with no token on record. Below it, the radar pulls in ${doc.early_count} more pre-token protocols by TVL. Implied value is a model of what a future token could claim — not a price.` })
      ]),
      make('dl', { class: 'summary-facts' }, [
        make('div', null, [make('dt', { text: 'watchlist covered' }), make('dd', { text: `${doc.watch_count} / ${doc.watch_count}` })]),
        make('div', null, [make('dt', { text: 'pre-token rows' }), make('dd', { text: String(doc.board_count) })]),
        make('div', null, [make('dt', { text: 'below the floor' }), make('dd', { text: String(doc.early_count) })]),
        make('div', null, [make('dt', { text: 'live set aside' }), make('dd', { text: String(doc.live_count) })])
      ])
    ]);
  }

  function controls() {
    const cats = Array.from(new Set(doc.rows.map((r) => r.category || 'Other'))).sort();
    const search = make('input', { type: 'search', id: 'q', value: view.query, placeholder: 'protocol, category or chain', 'aria-label': 'Search protocols' });
    search.addEventListener('input', () => { view.query = search.value; hashPush(); paint(); });
    const pick = make('select', { id: 'cat', 'aria-label': 'Category filter' }, [
      make('option', { value: 'all', text: 'All categories', selected: view.category === 'all' ? 'selected' : null }),
      ...cats.map((c) => make('option', { value: c, text: c, selected: c === view.category ? 'selected' : null }))
    ]);
    pick.addEventListener('change', () => { view.category = pick.value; hashPush(); paint(); });
    const preBtn = make('button', { type: 'button', 'aria-pressed': String(view.pane === 'pre'), text: 'Pre-token', class: view.pane === 'pre' ? 'tab on' : 'tab', onclick: () => { view.pane = 'pre'; paint(); } });
    const liveBtn = make('button', { type: 'button', 'aria-pressed': String(view.pane === 'live'), text: 'Live token', class: view.pane === 'live' ? 'tab on' : 'tab', onclick: () => { view.pane = 'live'; paint(); } });
    const shown = view.pane === 'pre' ? filteredRows().length : doc.live.length;
    return make('div', { class: 'controls' }, [
      make('label', { class: 'field' }, [make('span', { text: 'search' }), search]),
      make('label', { class: 'field' }, [make('span', { text: 'category' }), pick]),
      make('div', { class: 'field tabs' }, [make('span', { text: 'status' }), make('div', { class: 'tab-row' }, [preBtn, liveBtn])]),
      make('span', { class: 'shown', text: `${shown} ${view.pane === 'pre' ? 'rows' : 'protocols'}` })
    ]);
  }

  function sortable(key, label) {
    const marker = view.sortKey === key ? (view.sortDir < 0 ? ' ▾' : ' ▴') : '';
    return make('th', { scope: 'col' }, [
      make('button', { type: 'button', class: 'colhead', onclick: () => { if (view.sortKey === key) view.sortDir = -view.sortDir; else { view.sortKey = key; view.sortDir = -1; } paint(); } }, [label + marker])
    ]);
  }

  function preTable() {
    const list = orderedRows(filteredRows());
    if (list.length === 0) {
      return make('section', { class: 'panel' }, [
        make('div', { class: 'void' }, [
          make('h2', { text: 'nothing matches' }),
          make('p', { text: 'Loosen the search or switch the category back to all.' }),
          make('button', { type: 'button', class: 'btn', onclick: () => { view.query = ''; view.category = 'all'; hashPush(); paint(); } }, ['reset filters'])
        ])
      ]);
    }
    const peak = list[0].implied_value_usd || 1;
    const body = make('tbody');
    for (const row of list) {
      const growth = row.change_7d === null ? '' : row.change_7d >= 0 ? 'up' : 'down';
      const tr = make('tr', { tabindex: '0', class: view.openSlug === row.slug ? 'row open' : 'row', 'data-slug': row.slug }, [
        make('td', { class: 'num', text: String(row.rank) }),
        make('td', { class: 'who' }, [
          make('b', { text: row.name }),
          make('small', { text: `${row.category || 'Other'} · ${chainLabel(row)}` })
        ]),
        make('td', { class: 'num', text: money(row.tvl_usd) }),
        make('td', { class: `num ${growth}`, text: pct(row.change_7d) }),
        make('td', { class: 'num', text: age(row.age_days) }),
        make('td', { class: 'val' }, [
          make('div', { class: 'meter', 'aria-hidden': 'true' }, [make('i', { style: `width:${Math.max(2, Math.round((row.implied_value_usd / peak) * 100))}%` })]),
          make('span', { class: 'num', text: money(row.implied_value_usd) })
        ]),
        make('td', { class: 'tag', text: 'pre-token' })
      ]);
      tr.addEventListener('click', () => openDrawer(row.slug));
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDrawer(row.slug); } });
      body.appendChild(tr);
    }
    return make('section', { class: 'panel' }, [
      make('div', { class: 'scroll' }, [
        make('table', null, [
          make('caption', { class: 'caption', text: 'Pre-token protocols ordered by implied value. Click a row for the score breakdown and the farm plan.' }),
          make('thead', null, [make('tr', null, [
            sortable('rank', '#'),
            sortable('name', 'Protocol'),
            sortable('tvl_usd', 'TVL'),
            sortable('change_7d', '7d'),
            sortable('age_days', 'Age'),
            sortable('implied_value_usd', 'Implied value'),
            make('th', { scope: 'col', text: 'Token' })
          ])]),
          body
        ])
      ])
    ]);
  }

  function liveTable() {
    const body = make('tbody');
    for (const row of doc.live) {
      body.appendChild(make('tr', null, [
        make('td', { class: 'num', text: 'live' }),
        make('td', { class: 'who' }, [make('b', { text: row.name }), make('small', { text: `${row.category || 'Other'} · ${chainLabel(row)}` })]),
        make('td', { class: 'num', text: money(row.tvl_usd) }),
        make('td', { class: `num ${row.change_7d !== null && row.change_7d >= 0 ? 'up' : 'down'}`, text: pct(row.change_7d) }),
        make('td', { class: 'num', text: money(row.mcap_usd) }),
        make('td', { class: 'tag', text: 'trading' })
      ]));
    }
    return make('section', { class: 'panel' }, [
      make('div', { class: 'scroll' }, [
        make('table', null, [
          make('caption', { class: 'caption', text: 'These protocols already have tokens, so their market cap is a fact rather than a model. They sit outside the pre-token ranking.' }),
          make('thead', null, [make('tr', null, [
            make('th', { scope: 'col', text: 'Status' }),
            make('th', { scope: 'col', text: 'Protocol' }),
            make('th', { scope: 'col', text: 'TVL' }),
            make('th', { scope: 'col', text: '7d' }),
            make('th', { scope: 'col', text: 'Market cap' }),
            make('th', { scope: 'col', text: 'Token' })
          ])]),
          body
        ])
      ])
    ]);
  }

  function modelCard() {
    const p = doc.params;
    return make('section', { class: 'panel model-card' }, [
      make('h2', { text: 'how the score is built' }),
      make('p', { class: 'caption', text: 'One pure function scores every protocol from the snapshot alone. The category sets a base weight on TVL, a power term keeps giants from dwarfing everything, momentum scales with seven-day TVL change, maturity rewards time survived without a token, and multi-chain presence adds a small diversity bonus.' }),
      make('code', { class: 'equation', text: `implied = base_weight(category) · (tvl / ${p.tvl_scale})^${p.tvl_exponent} · (1 + clamp(growth, ${p.growth_clamp_lo}, ${p.growth_clamp_hi})/100 · ${p.growth_sensitivity}) · (${p.maturity_floor} + min(age, ${p.maturity_span_days})/${p.maturity_span_days} · ${p.maturity_gain}) · (1 + min(chains · ${p.chain_step}, ${p.chain_cap})) · 10^6` }),
      make('p', { class: 'caption', text: `Base weights run from ${0.5} for chains down to ${0.03} for canonical bridges; the neutral fallback is ${0.15}. Growth is clamped so a single outlier week cannot dominate, and unknown ages assume ${p.assumed_age_days} days. Nothing here reads a protocol name.` })
    ]);
  }

  const drawer = make('aside', { class: 'drawer', id: 'drawer', 'aria-hidden': 'true' });

  function openDrawer(slug) {
    const row = doc.rows.find((r) => r.slug === slug);
    if (!row) return;
    view.openSlug = slug;
    hashPush();
    drawer.innerHTML = '';
    drawer.setAttribute('aria-hidden', 'false');
    const local = recompute(row);
    const agrees = local === row.implied_value_usd;
    drawer.appendChild(make('div', { class: 'drawer-head' }, [
      make('div', null, [
        make('small', { class: 'kicker', text: `rank ${row.rank} of ${doc.board_count}` }),
        make('h2', { text: row.name }),
        make('p', { class: 'caption', text: `${row.category || 'Other'} · ${chainLabel(row)} · listed ${row.listed_at ?? 'unknown'} · age ${age(row.age_days)}` })
      ]),
      make('button', { type: 'button', class: 'shut', 'aria-label': 'Close details', onclick: () => closeDrawer() }, ['close'])
    ]));
    drawer.appendChild(make('section', { class: 'drawer-body' }, [
      make('h3', { text: 'score breakdown' }),
      make('dl', { class: 'equations' }, [
        make('div', null, [make('dt', { text: 'TVL' }), make('dd', { text: money(row.tvl_usd) })]),
        make('div', null, [make('dt', { text: 'base weight' }), make('dd', { text: `${row.breakdown.base_weight} — ${row.breakdown.base_reason}` })]),
        make('div', null, [make('dt', { text: 'TVL term' }), make('dd', { text: String(row.breakdown.tvl_term) })]),
        make('div', null, [make('dt', { text: 'momentum (7d)' }), make('dd', { text: `${pct(row.change_7d)} → ${row.breakdown.momentum_term}` })]),
        make('div', null, [make('dt', { text: 'maturity' }), make('dd', { text: `${age(row.breakdown.age_days_used)} → ${row.breakdown.maturity_term}` })]),
        make('div', null, [make('dt', { text: 'diversity' }), make('dd', { text: `${row.chains.length} chain(s) → ${row.breakdown.diversity_term}` })]),
        make('div', { class: 'total' }, [make('dt', { text: 'implied value' }), make('dd', { text: money(row.implied_value_usd) })])
      ]),
      make('p', { class: 'caption', text: agrees ? `The page recomputes this row as ${money(local)} — the same number board.json carries. An estimate, not a price.` : `The page recomputes this row as ${money(local)}, which disagrees with board.json: the data file would be stale.` })
    ]));
    drawer.appendChild(make('section', { class: 'drawer-body' }, [
      make('h3', { text: 'farm plan' }),
      make('ol', { class: 'plan' }, row.farm_plan.map((step) => make('li', { text: step })))
    ]));
    drawer.classList.add('show');
  }

  function closeDrawer() {
    view.openSlug = null;
    drawer.classList.remove('show');
    drawer.setAttribute('aria-hidden', 'true');
    hashPush();
  }

  function paint() {
    stage.innerHTML = '';
    stage.appendChild(masthead());
    stage.appendChild(summary());
    stage.appendChild(controls());
    stage.appendChild(view.pane === 'pre' ? preTable() : liveTable());
    if (view.pane === 'pre') stage.appendChild(modelCard());
    stage.appendChild(drawer);
    if (view.openSlug) openDrawer(view.openSlug);
  }

  hashSync();
  paint();
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawer.classList.contains('show')) closeDrawer(); });
})();
