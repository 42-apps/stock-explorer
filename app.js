/* ============================================================================
   Stock Explorer — pick a lens, watch the global equity universe re-rank.
   Pure vanilla. Data: window.STOCKS (see data/stocks.js). Engine: hand-rolled
   SVG bars + growth curves, no external libraries.
   ========================================================================== */
'use strict';

const DATA = window.STOCKS || { meta:{}, perspectives:[], stocks:[] };
const PERSP = (() => {
  const base = (DATA.perspectives || []).slice();
  // custom views that aren't a single-field leaderboard (rendered specially)
  const extra = [
    { id: 'decade', group: 'Impact', emoji: '🏆', label: 'Champions by decade', blurb: 'The best-performing stock of each decade by total return — a fair fight within each era, where raw all-time growth always favours the oldest names.', custom: true },
    { id: 'globe', group: 'Impact', emoji: '🌐', label: 'Around the world', blurb: 'Every company on its home turf — bubble size = combined market cap of that country\'s giants. Spin the globe; click a country to see its companies.', custom: true },
    { id: 'graveyard', group: 'Impact', emoji: '🪦', label: 'The graveyard', blurb: 'Famous fortunes destroyed — giants that fell to near-zero and were delisted. The cautionary tales every "greatest stocks" list forgets.', custom: true },
    { id: 'picks-growth', group: "Claude's Picks", emoji: '✦', label: 'Growth picks (10yr)', blurb: "Claude's reasoned bets for the next decade's biggest growth — an AI's opinion for curiosity, NOT financial advice.", custom: true },
    { id: 'picks-dividend', group: "Claude's Picks", emoji: '✦', label: 'Dividend picks (10yr)', blurb: "Claude's picks for the best 10-year total return from dividends + growth — opinion, NOT financial advice.", custom: true },
  ];
  extra.forEach(e => { if (!base.find(p => p.id === e.id)) base.push(e); });
  return base;
})();
const STOCKS = DATA.stocks;
const byId = {}; STOCKS.forEach(s => byId[s.id] = s);
const NOW = 2026;

/* ----------------------------- helpers ----------------------------------- */
const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = s => (s == null ? '' : ('' + s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const commas = n => (Math.round(n)).toLocaleString('en-US');
const nf = (v, suf = '') => (v == null ? '—' : v + suf);
const pctStr = v => v == null ? '—' : (v < 0 ? '−' : '+') + (Math.abs(v) >= 10000 ? commas(Math.abs(v)) : Math.abs(v).toFixed(0)) + '%';

function metricVal(s, p) { return (s.m && s.m[p.field] != null) ? s.m[p.field] : null; }

/* compact value formatting per lens unit */
function fmtVal(v, p) {
  if (v == null || isNaN(v)) return '—';
  const u = p.unit, neg = v < 0, a = Math.abs(v);
  let core, small = '';
  if (u === '%') {
    if (a >= 1e6) core = (a / 1e6 >= 100 ? commas(a / 1e6) : (a / 1e6).toFixed(1).replace(/\.0$/, '')) + 'M';
    else if (a >= 10000) core = commas(a);
    else core = a.toFixed(a < 10 ? 1 : 0);
    small = '%';
  } else if (u === '%/yr') { core = a.toFixed(1); small = '%/yr'; }
  else if (u === '$') { core = '$' + a.toFixed(a < 10 ? 2 : 0); }
  else if (u === '$B') { core = a >= 1000 ? '$' + (a / 1000).toFixed(1).replace(/\.0$/, '') + 'T' : '$' + commas(a) + 'B'; }
  else if (u === 'yrs') { core = commas(a); small = 'yr'; }
  else if (u === 'mo') { core = commas(a); small = 'mo'; }
  else if (u === 'x') { core = a >= 100 ? commas(a) : a.toFixed(1).replace(/\.0$/, ''); small = '×'; }
  else if (u === 'int') { core = commas(a); }
  else if (u === 'score') { core = a.toFixed(0); }
  else { core = a.toFixed(2); } // sharpe/sortino/calmar/beta etc.
  return (neg ? '−' : '') + core + (small ? `<small>${small}</small>` : '');
}

/* bar fraction — the rank LEADER always gets the longest bar, regardless of
   whether the lens sorts ascending (cheap/worst first) or descending. Huge,
   skewed ranges (e.g. all-time growth) are log-compressed so Altria's 265M%
   doesn't flatten everyone else. */
function barFracs(list, p) {
  const asc = p.dir === 'asc';
  const fav = list.map(s => { const v = metricVal(s, p); return asc ? -v : v; }); // bigger = better rank
  const lo = Math.min(...fav);
  const shifted = fav.map(f => f - lo + 1);            // all ≥ 1, leader is largest
  const max = Math.max(...shifted, 1), min = Math.min(...shifted);
  const huge = max / Math.max(min, 1e-9) > 200;
  const lmax = Math.log10(max) || 1;
  return shifted.map(s => clamp(huge ? Math.log10(s) / lmax : s / max, 0.05, 1));
}

/* ----------------------------- state ------------------------------------- */
let state = { lens: PERSP[0] ? PERSP[0].id : null, region: 'All', sector: 'All' };

function activeP() { return PERSP.find(p => p.id === state.lens) || PERSP[0]; }

function filtered() {
  return STOCKS.filter(s =>
    (state.region === 'All' || s.country === state.region) &&
    (state.sector === 'All' || s.sector === state.sector));
}
function ranked() {
  const p = activeP();
  const list = filtered().filter(s => metricVal(s, p) != null && s.kind !== 'crypto'); // crypto is a reference, not a ranked stock
  list.sort((a, b) => p.dir === 'asc' ? metricVal(a, p) - metricVal(b, p) : metricVal(b, p) - metricVal(a, p));
  return list;
}

/* ----------------------------- lens rail --------------------------------- */
function buildRail() {
  const rail = $('#lensRail'); rail.innerHTML = '';
  const groups = [];
  PERSP.forEach(p => { let g = groups.find(x => x.name === p.group); if (!g) { g = { name: p.group, items: [] }; groups.push(g); } g.items.push(p); });
  groups.forEach(g => {
    const wrap = el('div', 'lens-group');
    wrap.appendChild(el('div', 'lens-group-h', esc(g.name)));
    g.items.forEach(p => {
      const b = el('button', 'lens' + (p.id === state.lens ? ' on' : ''),
        `<span class="le">${p.emoji}</span><span class="lt">${esc(p.label)}</span>`);
      b.dataset.id = p.id;
      b.onclick = () => setLens(p.id);
      wrap.appendChild(b);
    });
    rail.appendChild(wrap);
  });
}

function setLens(id) {
  state.lens = id;
  $$('.lens').forEach(b => b.classList.toggle('on', b.dataset.id === id));
  render();
  try { history.replaceState(null, '', `?lens=${id}`); } catch (e) {}
}

/* clicking the header logo fully returns to the default home view */
function goHome() {
  closeDetail();
  $$('.overlay').forEach(o => o.classList.add('hidden'));
  const gi = document.getElementById('globeInfo'); if (gi) gi.classList.add('hidden');
  const sr = document.getElementById('searchResults'); if (sr) { sr.classList.add('hidden'); sr.innerHTML = ''; }
  const sb = document.getElementById('search'); if (sb) sb.value = '';
  state = { lens: PERSP[0].id, region: 'All', sector: 'All' };
  const rs = document.getElementById('regionSel'); if (rs) rs.value = 'All';
  const ss = document.getElementById('sectorSel'); if (ss) ss.value = 'All';
  $$('.lens').forEach(b => b.classList.toggle('on', b.dataset.id === PERSP[0].id));
  try { history.replaceState(null, '', location.pathname); } catch (e) {}
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ----------------------------- filters ----------------------------------- */
function buildFilters() {
  const regions = ['All', ...Array.from(new Set(STOCKS.map(s => s.country))).sort()];
  const sectors = ['All', ...Array.from(new Set(STOCKS.map(s => s.sector))).sort()];
  const rs = $('#regionSel'), ss = $('#sectorSel');
  rs.innerHTML = regions.map(r => `<option>${esc(r)}</option>`).join('');
  ss.innerHTML = sectors.map(r => `<option>${esc(r)}</option>`).join('');
  rs.onchange = () => { state.region = rs.value; render(); };
  ss.onchange = () => { state.sector = ss.value; render(); };
}

/* ----------------------------- render ------------------------------------ */
function render() {
  const p = activeP();
  $('#bhEmoji').textContent = p.emoji;
  $('#bhLabel').textContent = p.label;
  $('#bhBlurb').textContent = p.blurb;
  $('#bhControls').style.display = p.custom ? 'none' : '';
  const isGlobe = p.id === 'globe';
  $('#globeWrap').classList.toggle('hidden', !isGlobe);
  $('#podium').style.display = p.custom ? 'none' : '';
  $('#leaderboard').style.display = isGlobe ? 'none' : '';
  if (p.id === 'decade') { $('#podium').innerHTML = ''; return renderDecade(); }
  if (p.id === 'graveyard') { $('#podium').innerHTML = ''; $('#bhCount').textContent = ''; return renderGraveyard(); }
  if (p.id === 'picks-growth' || p.id === 'picks-dividend') { $('#podium').innerHTML = ''; $('#bhCount').textContent = ''; return renderPicks(p.id === 'picks-growth' ? 'growth' : 'dividend'); }
  if (isGlobe) { $('#bhCount').textContent = ''; return renderGlobe(); }

  const list = ranked();
  $('#bhCount').textContent = `${list.length} of ${STOCKS.length} companies`;

  const fracs = barFracs(list, p);
  renderPodium(list, p);
  renderBoard(list, p, fracs);
}

/* ----------------------------- champions by decade ----------------------- */
function renderDecade() {
  $('#bhCount').textContent = '';
  const decades = ['1970s', '1980s', '1990s', '2000s', '2010s', '2020s'];
  const lb = $('#leaderboard'); lb.innerHTML = '';
  const grid = el('div', 'decade-grid');
  decades.forEach(dk => {
    const ranked = STOCKS.filter(s => s.dec && s.dec[dk] != null && s.kind !== 'crypto' && !s.delisted).sort((a, b) => b.dec[dk] - a.dec[dk]);
    if (!ranked.length) return;
    const win = ranked[0];
    const card = el('div', 'decade-card');
    card.innerHTML =
      `<div class="dc-head"><span class="dc-decade">${dk}</span><span class="dc-n">${ranked.length} stocks</span></div>
       <div class="dc-winner" data-id="${win.id}">
         <span class="dc-medal">🏆</span>
         <div class="dc-wnm"><span class="dc-f">${win.flag}</span>${esc(win.name)}</div>
         <div class="dc-wsub">${esc(win.ticker)} · ${esc(win.sector)}</div>
         <div class="dc-val">${pctStr(win.dec[dk])}</div>
       </div>
       <div class="dc-rest">` +
      ranked.slice(1, 5).map((s, i) =>
        `<div class="dc-row" data-id="${s.id}"><span class="dc-rank">${i + 2}</span><span>${s.flag} ${esc(s.name)}</span><span class="dc-rv">${pctStr(s.dec[dk])}</span></div>`).join('') +
      `</div>`;
    grid.appendChild(card);
  });
  lb.appendChild(grid);
  lb.querySelectorAll('[data-id]').forEach(e => e.onclick = () => openDetail(e.dataset.id));
}

/* ----------------------------- the graveyard ----------------------------- */
function renderGraveyard() {
  const lb = $('#leaderboard'); lb.innerHTML = '';
  const dead = STOCKS.filter(s => s.delisted).sort((a, b) => b.peakPrice - a.peakPrice);
  lb.appendChild(el('p', 'gy-intro', `${dead.length} famous fortunes destroyed — the cautionary tales every "greatest stocks" list forgets. <b>$10,000</b> invested at each peak → what was left when the music stopped.`));
  const grid = el('div', 'gy-grid');
  dead.forEach(s => {
    const left = Math.max(0, 10000 * (s.price / s.peakPrice));
    const card = el('div', 'gy-card'); card.dataset.id = s.id;
    card.innerHTML =
      `<div class="gy-top"><span class="gy-stone">🪦</span><span class="gy-yrs">${s.peakYear}–${s.delistYear}</span></div>
       <div class="gy-nm">${s.flag} ${esc(s.name)}</div>
       <div class="gy-sub">${esc(s.sector)}</div>
       <div class="gy-drop">${s.peakDrop}%</div>
       <div class="gy-cash">$10,000 → <b>${left >= 1 ? '$' + commas(left) : '$' + left.toFixed(2)}</b></div>
       <div class="gy-peak">peaked $${commas(s.peakPrice)} in ${s.peakYear}</div>`;
    grid.appendChild(card);
  });
  lb.appendChild(grid);
  lb.querySelectorAll('[data-id]').forEach(e => e.onclick = () => openDetail(e.dataset.id));
}

/* ----------------------------- Claude's Picks ---------------------------- */
function renderPicks(type) {
  const lb = $('#leaderboard'); lb.innerHTML = '';
  lb.appendChild(el('div', 'pk-disclaimer', `✦ <b>Claude's Picks</b> — an AI's reasoned opinion as of ${esc((DATA.meta || {}).picksAsOf || '')}, for curiosity &amp; education. <b>Not financial advice</b>; the 10-year projections are illustrative estimates that will be wrong in unknowable ways. Do your own research.`));
  const picks = STOCKS.filter(s => s.pick && s.pick[type]).sort((a, b) => a.pick[type].rank - b.pick[type].rank);
  const grid = el('div', 'pk-grid');
  picks.forEach(s => {
    const pk = s.pick[type];
    const actual = type === 'growth'
      ? `track record: ${nf(s.m.cagr, '%/yr')} since ${s.ipoYear}`
      : `today: ${nf(s.m.curYield, '%')} yield · ${nf(s.m.divCagr, '%/yr')} dividend growth`;
    const card = el('div', 'pk-card'); card.dataset.id = s.id;
    card.innerHTML =
      `<div class="pk-top"><span class="pk-rank">#${pk.rank}</span><span class="pk-conv pk-${pk.conviction}">${pk.conviction} conviction</span></div>
       <div class="pk-nm">${s.flag} ${esc(s.name)} <span class="pk-tk">${esc(s.ticker.replace('.US', ''))}</span></div>
       <div class="pk-proj">${esc(pk.projection)} <span class="pk-projlbl">projected · 10yr</span></div>
       <div class="pk-actual">${esc(actual)}</div>
       <div class="pk-rat">${esc(pk.rationale)}</div>
       <div class="pk-risk"><b>Biggest risk:</b> ${esc(pk.risks)}</div>`;
    grid.appendChild(card);
  });
  lb.appendChild(grid);
  lb.querySelectorAll('[data-id]').forEach(e => e.onclick = () => openDetail(e.dataset.id));
}

/* ----------------------------- around the world (globe) ------------------ */
let _globe = null, _globePosed = false;
const mcStr = m => '$' + (m >= 1000 ? (m / 1000).toFixed(1) + 'T' : Math.round(m) + 'B');
function renderGlobe() {
  const host = $('#globeViz'), GEO = window.COUNTRY_GEO || {};
  if (typeof Globe !== 'function') { host.innerHTML = '<p style="padding:40px;color:var(--ink-faint)">Globe engine unavailable.</p>'; return; }
  // aggregate companies by home country
  const byC = {};
  STOCKS.forEach(s => {
    const g = GEO[s.country]; if (!g || s.delisted) return; // graveyard names have no live market cap
    const e = (byC[s.country] ||= { country: s.country, flag: s.flag, lat: g.lat, lng: g.lon, region: g.region, count: 0, mcap: 0, list: [] });
    e.count++; e.mcap += s.mcap || 0; e.list.push(s);
  });
  const pts = Object.values(byC); pts.forEach(p => p.list.sort((a, b) => b.mcap - a.mcap));
  const lmax = Math.log10(Math.max(...pts.map(p => p.mcap), 1) + 1);
  const REGCOL = { 'North America': '#42e6a4', 'Europe & Central Asia': '#5aa9ff', 'East Asia & Pacific': '#ffcd56', 'Latin America & Caribbean': '#ff6b6b', 'South Asia': '#a98bff', 'Middle East & North Africa': '#f6c94a', 'Sub-Saharan Africa': '#7df3c4' };
  const norm = d => Math.log10(d.mcap + 1) / lmax;

  if (!_globe) {
    _globe = Globe()(host)
      .backgroundColor('rgba(0,0,0,0)')
      .showAtmosphere(true).atmosphereColor('#42e6a4').atmosphereAltitude(0.16)
      .showGraticules(true)
      .pointLat('lat').pointLng('lng')
      .pointAltitude(d => 0.05 + 0.6 * norm(d))
      .pointRadius(d => 0.3 + 0.9 * norm(d))
      .pointColor(d => REGCOL[d.region] || '#42e6a4')
      .pointLabel(d => `<div class="globe-tip"><b>${d.flag} ${esc(d.country)}</b><br>${d.count} ${d.count === 1 ? 'company' : 'companies'} · ${mcStr(d.mcap)}<br><span class="gt-top">${esc(d.list[0].name)} ↗</span></div>`)
      .onPointClick(d => showCountryPanel(d));
    try { _globe.globeMaterial().color.set('#102a24'); } catch (e) {}
    try { const c = _globe.controls(); c.autoRotate = true; c.autoRotateSpeed = 0.55; c.enableZoom = true; } catch (e) {}
  }
  _globe.pointsData(pts);
  _globe.width(host.clientWidth || 800).height(Math.max(window.innerHeight - 250, 420));
  if (!_globePosed) { _globe.pointOfView({ lat: 22, lng: -15, altitude: 2.3 }); _globePosed = true; }
}
function showCountryPanel(d) {
  const info = $('#globeInfo');
  info.innerHTML =
    `<button class="gi-close" id="giClose">×</button>
     <div class="gi-h">${d.flag} ${esc(d.country)}</div>
     <div class="gi-sub">${d.count} ${d.count === 1 ? 'company' : 'companies'} · combined ${mcStr(d.mcap)}</div>
     <div class="gi-list">` +
    d.list.slice(0, 14).map((s, i) => `<div class="gi-row" data-id="${s.id}"><span class="gi-rank">${i + 1}</span><span class="gi-nm">${esc(s.name)}</span><span class="gi-mc">${mcStr(s.mcap)}</span></div>`).join('') +
    `</div>`;
  info.classList.remove('hidden');
  $('#giClose').onclick = () => info.classList.add('hidden');
  info.querySelectorAll('[data-id]').forEach(e => e.onclick = () => openDetail(e.dataset.id));
}

function subStat(s, p) {
  // a contextual secondary figure under each row, depending on the lens
  switch (p.group) {
    case 'Dividends': return `current yield ${nf(s.m.curYield, '%')}`;
    case 'Valuation': return `P/E ${s.m.pe || '—'} · P/B ${s.m.pb || '—'}`;
    case 'Quality': return `ROIC ${nf(s.m.roic, '%')} · net margin ${nf(s.m.netMargin, '%')}`;
    case 'Growth': return `CAGR ${nf(s.m.cagr, '%/yr')} · since ${s.ipoYear}`;
    default: return `${s.mcap != null ? 'mcap $' + (s.mcap >= 1000 ? (s.mcap / 1000).toFixed(1) + 'T' : s.mcap + 'B') + ' · ' : ''}since ${s.ipoYear}`;
  }
}

function renderPodium(list, p) {
  const pod = $('#podium'); pod.innerHTML = '';
  list.slice(0, 3).forEach((s, i) => {
    const v = metricVal(s, p);
    const cr = s.kind === 'crypto' ? s.refColor : null;
    const card = el('div', `pod r${i + 1}${v < 0 ? ' neg' : ''}${cr ? ' pod-crypto' : ''}`);
    if (cr) card.style.borderColor = cr;
    card.innerHTML =
      `<div class="pod-medal">${['🥇','🥈','🥉'][i]}</div>
       <div class="pod-rank">#${i + 1} · ${esc(p.label)}</div>
       <div class="pod-name"><span class="pod-flag">${s.flag}</span>${esc(s.name)}${dividBadge(s)}${deadBadge(s)}${pickBadge(s)}${cr ? `<span class="badge ref" style="color:${cr};border-color:${cr}">reference</span>` : ''}</div>
       <div class="pod-tk">${esc(s.ticker)} · ${esc(s.sector)} · ${esc(s.country)}</div>
       <div class="pod-val"${cr ? ` style="color:${cr}"` : ''}>${fmtVal(v, p)}</div>
       <div class="pod-sub">${esc(subStat(s, p))}</div>`;
    card.onclick = () => openDetail(s.id);
    pod.appendChild(card);
  });
}

function dividBadge(s) {
  const d = s.m.divStreak || 0;
  if (d >= 50) return `<span class="badge king">👑 King</span>`;
  if (d >= 25) return `<span class="badge aris">Aristocrat</span>`;
  return '';
}
function deadBadge(s) { return s.delisted ? `<span class="badge dead">💀 ${s.delistYear}</span>` : ''; }
function pickBadge(s) { return s.pick ? `<span class="badge pick">✦ Pick</span>` : ''; }

function renderBoard(list, p, fracs) {
  const lb = $('#leaderboard'); lb.innerHTML = '';
  // crypto comparison rows for the growth lenses — shown ABOVE the ranked stocks, as a labeled reference (not a numbered rank)
  if (['absGrowth', 'absGrowthTR', 'cagr', 'tsr'].includes(p.field)) {
    STOCKS.filter(s => s.kind === 'crypto' && metricVal(s, p) != null).sort((a, b) => metricVal(b, p) - metricVal(a, p)).forEach(s => {
      const v = metricVal(s, p), cr = s.refColor;
      const row = el('div', 'lb-row lb-crypto'); row.style.borderColor = cr;
      row.innerHTML =
        `<div class="lb-rank" style="color:${cr};font-size:17px">${s.flag}</div>
         <div class="lb-id"><div class="lb-nm"><span class="nm">${esc(s.name)}</span><span class="badge ref" style="color:${cr};border-color:${cr}">reference · not a stock</span></div>
           <div class="lb-meta"><span class="tk">${esc(s.ticker)}</span> · shown for comparison</div></div>
         <div class="lb-bar"><div class="lb-bar-fill" style="width:100%;background:${cr}"></div></div>
         <div class="lb-val" style="color:${cr}">${fmtVal(v, p)}</div>`;
      row.onclick = () => openDetail(s.id);
      lb.appendChild(row);
    });
  }
  list.forEach((s, i) => {
    const v = metricVal(s, p);
    const neg = v < 0;
    const cr = s.kind === 'crypto' ? s.refColor : null;
    const row = el('div', 'lb-row' + (cr ? ' lb-crypto' : '') + (s.pick ? ' lb-pick' : ''));
    if (cr) row.style.borderColor = cr;
    const barStyle = `width:${(fracs[i] * 100).toFixed(1)}%` + (cr ? `;background:${cr}` : '');
    row.innerHTML =
      `<div class="lb-rank">${i + 1}</div>
       <div class="lb-id">
         <div class="lb-nm"><span class="f">${s.flag}</span><span class="nm">${esc(s.name)}</span>${dividBadge(s)}${deadBadge(s)}${pickBadge(s)}${cr ? `<span class="badge ref" style="color:${cr};border-color:${cr}">reference</span>` : ''}</div>
         <div class="lb-meta"><span class="tk">${esc(s.ticker)}</span> · ${esc(s.sector)} · ${esc(subStat(s, p))}</div>
       </div>
       <div class="lb-bar"><div class="lb-bar-fill ${neg ? 'neg' : ''}" style="${barStyle}"></div></div>
       <div class="lb-val ${neg ? 'neg' : 'pos'}"${cr ? ` style="color:${cr}"` : ''}>${fmtVal(v, p)}</div>`;
    row.onclick = () => openDetail(s.id);
    lb.appendChild(row);
  });
}

/* ----------------------------- detail drawer ----------------------------- */
function openDetail(id) {
  const s = byId[id]; if (!s) return;
  const m = s.m;
  const cell = (k, val, cls) => `<div class="d-cell"><div class="k">${k}</div><div class="v ${cls || ''}">${val}</div></div>`;
  const pct = (x, suff = '%') => x == null ? '—' : (x < 0 ? '−' : '') + Math.abs(x) + suff;
  const grow = pctBig(m.absGrowth);

  $('#detailBody').innerHTML =
    `<div class="d-flag">${s.flag}</div>
     <div class="d-name">${esc(s.name)} ${dividBadge(s)}${deadBadge(s)}${pickBadge(s)}</div>
     <div class="d-sub">${esc(s.ticker)} · ${esc(s.exchange)} · listed ${s.ipoYear} · ${esc(s.country)}</div>
     ${s.delisted ? `<div class="d-dead">🪦 Delisted ${s.delistYear} · peaked $${s.peakPrice} in ${s.peakYear} · <b>${s.peakDrop}%</b> from peak</div>` : ''}
     ${s.kind === 'crypto' ? `<div class="d-ref" style="border-color:${s.refColor};color:${s.refColor}">${s.flag} Reference asset — a cryptocurrency shown for comparison, not a stock.</div>` : ''}
     <div class="d-chips">
       <span class="d-chip">${esc(s.sector)}</span>
       <span class="d-chip">Price ${s.currency} ${s.price}</span>
       ${s.mcap != null ? `<span class="d-chip">Mcap $${s.mcap >= 1000 ? (s.mcap / 1000).toFixed(2) + 'T' : s.mcap + 'B'}</span>` : ''}
     </div>
     <div class="d-curve">${growthCurveSVG(s)}
       <div class="cap"><span>$100 in ${s.ipoYear} · dividends reinvested</span><span>→ <b>${tmValueStr(s, s.ipoYear)}</b> ${s.delisted ? 'by ' + s.delistYear : 'today'}</span></div>
     </div>
     <div class="d-sec-h">Growth</div>
     <div class="d-grid">
       ${cell('Price return', grow, m.absGrowth >= 0 ? 'pos' : 'neg')}
       ${cell('With dividends', pctBig(m.absGrowthTR), (m.absGrowthTR || 0) >= 0 ? 'pos' : 'neg')}
       ${cell('Annual (CAGR)', pct(m.cagr), m.cagr >= 0 ? 'pos' : 'neg')}
       ${cell('Total return /yr', pct(m.tsr), m.tsr >= 0 ? 'pos' : 'neg')}
     </div>
     <div class="d-sec-h">Dividends</div>
     <div class="d-grid">
       ${cell('Current yield', pct(m.curYield))}
       ${cell('Avg yield (life)', pct(m.avgYield))}
       ${cell('Cumulative', '$' + m.cumDiv + '/sh')}
       ${cell('Increase streak', (m.divStreak || 0) + ' yrs')}
     </div>
     <div class="d-sec-h">Valuation</div>
     <div class="d-grid">
       ${cell('P/E', m.pe || '—')}
       ${cell('P/B', m.pb || '—')}
       ${cell('EV/EBITDA', m.evEbitda || '—')}
       ${cell('Value score', m.valueScore != null ? m.valueScore + '/100' : '—')}
     </div>
     <div class="d-sec-h">Quality &amp; risk</div>
     <div class="d-grid">
       ${cell('ROIC', pct(m.roic))}
       ${cell('Net margin', pct(m.netMargin))}
       ${cell('Sharpe', (m.sharpe != null ? m.sharpe.toFixed(2) : '—'), m.sharpe >= 0 ? 'pos' : 'neg')}
       ${cell('Max drawdown', pct(m.maxDD), 'neg')}
     </div>
     <div class="d-sec-h">Impact</div>
     <div class="d-grid">
       ${cell('Wealth created', fmtVal(m.wealthUSD, { unit: '$B' }), m.wealthUSD >= 0 ? 'pos' : 'neg')}
       ${cell('Quality score', m.qualityScore != null ? m.qualityScore + '/100' : '—')}
     </div>
     ${s.pick ? `<div class="d-sec-h">✦ Claude's Pick</div>` +
       (s.pick.growth ? `<div class="d-pick"><div class="d-pick-h">Growth · <b>${esc(s.pick.growth.projection)}</b> · ${esc(s.pick.growth.conviction)} conviction</div><div class="d-pick-r">${esc(s.pick.growth.rationale)}</div></div>` : '') +
       (s.pick.dividend ? `<div class="d-pick"><div class="d-pick-h">Dividend / total return · <b>${esc(s.pick.dividend.projection)}</b> · ${esc(s.pick.dividend.conviction)} conviction</div><div class="d-pick-r">${esc(s.pick.dividend.rationale)}</div></div>` : '') +
       `<div class="d-pick-dis">AI opinion, not financial advice.</div>` : ''}
     <div class="d-tm"><button onclick="window.__openTM('${s.id}', ${s.ipoYear})">⏳ Run the $100 time machine →</button></div>`;
  $('#detailCard').classList.remove('hidden');
  $('#scrim').classList.remove('hidden');
}
function pctBig(x) { const p = { unit:'%' }; return fmtVal(x, p); }
function closeDetail() { $('#detailCard').classList.add('hidden'); $('#scrim').classList.add('hidden'); }

/* ----------------------------- growth maths ------------------------------ */
/* synthesise a $100 path from CAGR when no real series is loaded */
function pathFor(s, startYear) {
  const start = Math.max(startYear, s.ipoYear);
  const g = (s.m.cagr || 0) / 100;
  const pts = [];
  for (let y = start; y <= NOW; y++) pts.push([y, 100 * Math.pow(1 + g, y - start)]);
  if (s.series && s.series.length) {
    const seg = s.series.filter(p => p[0] >= start);
    if (seg.length > 1) { const base = seg[0][1]; return seg.map(p => [p[0], 100 * p[1] / base]); }
  }
  return pts;
}
function tmValue(s, startYear) { const p = pathFor(s, startYear); return p[p.length - 1][1]; }
function tmValueStr(s, startYear) {
  const v = tmValue(s, startYear);
  return v >= 1e6 ? '$' + (v / 1e6).toFixed(1) + 'M' : v >= 1000 ? '$' + commas(v) : '$' + v.toFixed(0);
}

function curveSVG(path, w, h, neg) {
  if (path.length < 2) return '';
  const ys = path.map(p => p[1]);
  const lo = Math.min(...ys), hi = Math.max(...ys);
  const logScale = hi / Math.max(lo, 0.01) > 50;
  const ny = v => logScale ? (Math.log10(Math.max(v, .01)) - Math.log10(Math.max(lo, .01))) / (Math.log10(hi) - Math.log10(Math.max(lo, .01)) || 1) : (v - lo) / (hi - lo || 1);
  const n = path.length;
  const X = i => (i / (n - 1)) * w;
  const Y = v => h - 8 - ny(v) * (h - 16);
  let d = '', area = `M0 ${h} `;
  path.forEach((p, i) => { const x = X(i), y = Y(p[1]); d += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1) + ' '; area += `L${x.toFixed(1)} ${y.toFixed(1)} `; });
  area += `L${w} ${h} Z`;
  const col = neg ? 'var(--red)' : 'var(--green)';
  const fill = neg ? 'rgba(255,107,107,.14)' : 'rgba(66,230,164,.14)';
  return `<path d="${area}" fill="${fill}"/><path d="${d}" fill="none" stroke="${col}" stroke-width="2.5" stroke-linejoin="round"/>`;
}
function growthCurveSVG(s) {
  const path = pathFor(s, s.ipoYear);
  return `<svg viewBox="0 0 380 120" preserveAspectRatio="none">${curveSVG(path, 380, 120, (s.m.cagr || 0) < 0)}</svg>`;
}

/* ----------------------------- time machine ------------------------------ */
function buildTM() {
  const sel = $('#tmStock');
  sel.innerHTML = STOCKS.slice().sort((a, b) => a.name.localeCompare(b.name))
    .map(s => `<option value="${s.id}">${esc(s.flag + ' ' + s.name)} (${esc(s.ticker)})</option>`).join('');
  sel.onchange = renderTM;
  $('#tmYear').oninput = renderTM;
}
function renderTM() {
  const s = byId[$('#tmStock').value]; if (!s) return;
  let y = parseInt($('#tmYear').value || s.ipoYear, 10);
  const start = Math.max(y, s.ipoYear);
  const path = pathFor(s, y);
  const end = path[path.length - 1][1];
  const endYr = path[path.length - 1][0]; // delisted stocks' series stop at delisting, not NOW
  const mult = end / 100;
  const neg = end < 100;
  const note = (y < s.ipoYear ? ` <span class="mult">(${s.name} only listed in ${s.ipoYear})</span>` : '')
    + (s.delisted ? ` <span class="mult">— delisted ${s.delistYear}</span>` : '');
  $('#tmResult').innerHTML =
    `<span>$100 in ${start} →</span> <span class="big ${neg ? 'neg' : ''}">${tmValueStr(s, y)}</span>
     <span class="mult">that's ${mult >= 1 ? mult.toFixed(mult < 10 ? 1 : 0) + '×' : '−' + ((1 - mult) * 100).toFixed(0) + '%'} over ${endYr - start} years · ${s.m.cagr}%/yr</span>${note}`;
  $('#tmChart').innerHTML = curveSVG(path, 720, 230, neg) + tmAxis(path, 720, 230);
}
function tmAxis(path, w, h) {
  const first = path[0][0], last = path[path.length - 1][0];
  return `<text x="6" y="${h - 6}" fill="var(--ink-faint)" font-size="12">${first}</text>
          <text x="${w - 6}" y="${h - 6}" fill="var(--ink-faint)" font-size="12" text-anchor="end">${last}</text>`;
}
function openTM(id, year) {
  $('#tmOverlay').classList.remove('hidden');
  if (id) { $('#tmStock').value = id; if (year) $('#tmYear').value = year; } // pathFor clamps to ipoYear internally
  renderTM();
}
window.__openTM = (id, year) => { closeDetail(); openTM(id, year); };

/* ----------------------------- search ------------------------------------ */
function setupSearch() {
  const inp = $('#search'), box = $('#searchResults');
  const close = () => { box.classList.add('hidden'); box.innerHTML = ''; };
  inp.oninput = () => {
    const q = inp.value.trim().toLowerCase();
    if (!q) return close();
    const hits = STOCKS.filter(s => s.name.toLowerCase().includes(q) || s.ticker.toLowerCase().includes(q)).slice(0, 8);
    if (!hits.length) return close();
    box.innerHTML = hits.map(s => `<div class="sr-row" data-id="${s.id}"><span>${s.flag}</span><span class="sr-tk">${esc(s.ticker)}</span><span class="sr-nm">${esc(s.name)}</span></div>`).join('');
    box.classList.remove('hidden');
    $$('#searchResults .sr-row').forEach(r => r.onclick = () => { openDetail(r.dataset.id); inp.value = ''; close(); });
  };
  document.addEventListener('click', e => { if (!e.target.closest('#searchWrap')) close(); });
}

/* ----------------------------- overlays ---------------------------------- */
function show(id) { $(id).classList.remove('hidden'); }
function hide(id) { $(id).classList.add('hidden'); }
function setupOverlays() {
  $('#menuBtn').onclick = e => { e.stopPropagation(); $('#menu').classList.toggle('hidden'); };
  document.addEventListener('click', e => { if (!e.target.closest('.tools')) $('#menu').classList.add('hidden'); });
  const menu = (btn, ov) => { $(btn).onclick = () => { hide('#menu'); show(ov); }; };
  menu('#miAbout', '#aboutOverlay'); menu('#miData', '#dataOverlay'); menu('#miWelcome', '#welcomeOverlay');
  $('#aboutClose').onclick = () => hide('#aboutOverlay');
  $('#dataClose').onclick = () => hide('#dataOverlay');
  $('#tmClose').onclick = () => hide('#tmOverlay');
  $('#detailClose').onclick = closeDetail;
  $('#scrim').onclick = closeDetail;
  $('#timeMachineBtn').onclick = () => openTM();
  $('#welStart').onclick = () => hide('#welcomeOverlay');
  $('#brandHome').onclick = goHome;
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeDetail(); $$('.overlay').forEach(o => o.classList.add('hidden')); } });

  // about lenses list + data overlay body
  $('#aboutLenses').innerHTML = PERSP.map(p => `<li><span class="e">${p.emoji}</span><span><b>${esc(p.label)}</b> — ${esc(p.blurb)}</span></li>`).join('');
  $('#dataBody').innerHTML = dataOverlayHTML();
}
function dataOverlayHTML() {
  const m = DATA.meta;
  return `<p>${esc(m.universe || '')}. Snapshot: <b>${esc(m.asOf || '')}</b>.</p>
    <table>
      <tr><td>Source</td><td>${esc(m.source || '')}</td></tr>
      <tr><td>Universe</td><td>${esc(m.universe || '')} · ${STOCKS.length} companies</td></tr>
      <tr><td>Prices</td><td>Split- and dividend-adjusted closes; total return reinvests dividends.</td></tr>
      <tr><td>Valuation</td><td>Composite of P/E, P/B, P/S, EV/EBITDA and PEG vs. the universe (0 = cheap, 100 = rich).</td></tr>
      <tr><td>Quality</td><td>Blend of return on capital, margins and earnings consistency.</td></tr>
      <tr><td>Caveats</td><td>Survivorship &amp; era bias affect all-time tables; screens are not advice.</td></tr>
    </table>`;
}

/* ----------------------------- boot -------------------------------------- */
function boot() {
  // sample banner
  if (DATA.meta && DATA.meta.sample) {
    document.body.classList.add('banner-on');
    $('#sampleBanner').classList.remove('hidden');
    $('#sampleTxt').textContent = `${STOCKS.length} illustrative names with approximate figures — the live EODHD pipeline will replace this with the full global universe.`;
    document.documentElement.style.setProperty('--banner-h', ($('#sampleBanner').offsetHeight || 36) + 'px');
  }
  // deep link
  const params = new URLSearchParams(location.search);
  const lp = params.get('lens'); if (lp && PERSP.find(p => p.id === lp)) state.lens = lp;

  buildRail(); buildFilters(); buildTM(); setupSearch(); setupOverlays();
  render();

  if (!localStorage.getItem('se_seen')) { show('#welcomeOverlay'); try { localStorage.setItem('se_seen', '1'); } catch (e) {} }
}
boot();
