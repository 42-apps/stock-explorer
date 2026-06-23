/* ============================================================================
   build_stocks.mjs — fetches the global equity universe from EODHD and emits
   data/stocks.js (the real dataset that replaces the hand-authored sample).

   USAGE
   -----
     export EODHD_API_TOKEN=xxxxx        # or put the token in ./.eodhd_key
     node build_stocks.mjs               # default universe
     node build_stocks.mjs --limit 800 --exchanges US,LSE,XETRA,PA,TO,HK,TSE

   It is heavily cached: every HTTP response is written under data/.cache/, so
   re-runs are cheap and only fetch what's missing. Delete the cache to refresh.

   ⚠️  FIELD MAPPINGS BELOW are written to EODHD's documented schema and will be
   validated/tuned against the first live response. The token is read from env
   or .eodhd_key (both gitignored) and is NEVER written into the output.

   Pipeline:
     1. pick a universe (top names by market cap across the chosen exchanges)
     2. for each ticker: fundamentals + split-adjusted EOD (monthly) + dividends
     3. compute per-stock metrics (growth, dividends, risk, quality)
     4. compute cross-sectional composites (valueScore, qualityScore percentiles)
     5. emit data/stocks.js with meta.sample = false
   ========================================================================== */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

const __dir = dirname(fileURLToPath(import.meta.url));
const CACHE = join(__dir, 'data', '.cache');
mkdirSync(CACHE, { recursive: true });

/* ---- config / args ------------------------------------------------------ */
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const LIMIT = parseInt(arg('--limit', '1200'), 10);          // total companies to keep
const EXCHANGES = arg('--exchanges', 'US,LSE,XETRA,PA,AS,SW,TO,HK,TSE,KO,NSE,BSE,ST,MC,MI').split(',');
const PER_EXCH = parseInt(arg('--per-exchange', '400'), 10); // candidates per exchange before global cut
const HIST_FROM = arg('--from', '1960-01-01');
const TICKERS = arg('--tickers', '');                        // explicit list, skips universe discovery
const REGION = arg('--region', 'us');                        // screener exchange filter (us, lse, …)
const CONCURRENCY = 8;

/* EODHD plan note (probed 2026-06-23): the FREE tier returns NO fundamentals,
   limits /eod to 1 year, and blocks bulk endpoints — so it cannot build this
   dataset. /div and /splits ARE full history on free. All-In-One unlocks full
   fundamentals + 30+yr global history, which every lens here needs. */

const TOKEN = process.env.EODHD_API_TOKEN
  || (existsSync(join(__dir, '.eodhd_key')) ? readFileSync(join(__dir, '.eodhd_key'), 'utf8').trim() : '');
if (!TOKEN) { console.error('\n✗ No EODHD token. Set EODHD_API_TOKEN or create ./.eodhd_key\n'); process.exit(1); }

const BASE = 'https://eodhd.com/api';

/* ---- cached fetch ------------------------------------------------------- */
// hash the FULL url so long screener URLs (which differ only in a trailing
// offset) get distinct cache files; also masks the token out of the filename.
const cacheName = url => url.replace(TOKEN, 'TKN').replace(/[^a-z0-9]/gi, '_').slice(0, 110)
  + '_' + createHash('md5').update(url).digest('hex').slice(0, 12) + '.json';
async function getJSON(url, { ttlDays = 7 } = {}) {
  const f = join(CACHE, cacheName(url));
  if (existsSync(f)) { try { return JSON.parse(readFileSync(f, 'utf8')); } catch (e) {} }
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url);
      if (r.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
      if (!r.ok) { if (r.status === 404) return null; throw new Error(r.status); }
      const j = await r.json();
      writeFileSync(f, JSON.stringify(j));
      return j;
    } catch (e) { await sleep(800 * (attempt + 1)); }
  }
  return null;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tok = `api_token=${TOKEN}&fmt=json`;

/* ---- endpoints ---------------------------------------------------------- */
const epSymbols = ex => `${BASE}/exchange-symbol-list/${ex}?${tok}`;
const epFund = t => `${BASE}/fundamentals/${t}?${tok}`;
const epEOD = t => `${BASE}/eod/${t}?${tok}&period=m&from=${HIST_FROM}`;
const epDiv = t => `${BASE}/div/${t}?${tok}&from=${HIST_FROM}`;
const epSplits = t => `${BASE}/splits/${t}?${tok}&from=${HIST_FROM}`;
const epScreener = (off, region) => `${BASE}/screener?${tok}&sort=market_capitalization.desc&filters=${encodeURIComponent(`[["exchange","=","${region}"]]`)}&limit=100&offset=${off}`;
/* normalise a company name so share classes / suffixes collapse to one entity */
const normName = n => ('' + n).toLowerCase()
  .replace(/\b(inc|corp|corporation|co|company|plc|ltd|limited|holdings?|group|the|sa|nv|ag|class\s*[abc]|cl\s*[abc]|cdr|adr)\b/g, '')
  .replace(/[^a-z0-9]/g, '');

/* ---- helpers ------------------------------------------------------------ */
const num = x => (x == null || x === '' || isNaN(+x)) ? null : +x;
const pctRank = (arr, v) => { if (v == null) return null; const s = arr.filter(x => x != null).sort((a, b) => a - b); if (!s.length) return null; let i = 0; while (i < s.length && s[i] < v) i++; return Math.round(100 * i / (s.length - 1 || 1)); };
const yearsBetween = (a, b) => (new Date(b) - new Date(a)) / (365.25 * 864e5);

/* small country→flag map (extend as needed) */
const FLAG = { 'USA':'🇺🇸','United States':'🇺🇸','United Kingdom':'🇬🇧','Germany':'🇩🇪','France':'🇫🇷','Netherlands':'🇳🇱','Switzerland':'🇨🇭','Canada':'🇨🇦','Japan':'🇯🇵','China':'🇨🇳','Hong Kong':'🇭🇰','India':'🇮🇳','Taiwan':'🇹🇼','South Korea':'🇰🇷','Denmark':'🇩🇰','Sweden':'🇸🇪','Spain':'🇪🇸','Italy':'🇮🇹','Australia':'🇦🇺','Brazil':'🇧🇷','Saudi Arabia':'🇸🇦','Ireland':'🇮🇪','Israel':'🇮🇱','Bermuda':'🇧🇲','Singapore':'🇸🇬','Mexico':'🇲🇽','Argentina':'🇦🇷','South Africa':'🇿🇦','Norway':'🇳🇴','Finland':'🇫🇮','Belgium':'🇧🇪','Luxembourg':'🇱🇺','Cayman Islands':'🇰🇾','Russia':'🇷🇺','Indonesia':'🇮🇩','Greece':'🇬🇷','Portugal':'🇵🇹','Austria':'🇦🇹','Chile':'🇨🇱','New Zealand':'🇳🇿','Thailand':'🇹🇭','Turkey':'🇹🇷','Philippines':'🇵🇭','Malaysia':'🇲🇾','Poland':'🇵🇱','Colombia':'🇨🇴','Vietnam':'🇻🇳','United Arab Emirates':'🇦🇪','Qatar':'🇶🇦','Puerto Rico':'🇵🇷','Jersey':'🇯🇪','Uruguay':'🇺🇾','Peru':'🇵🇪','Kazakhstan':'🇰🇿','Cyprus':'🇨🇾','Greece':'🇬🇷','Indonesia':'🇮🇩','Philippines':'🇵🇭','Thailand':'🇹🇭','Vietnam':'🇻🇳','South Africa':'🇿🇦','Monaco':'🇲🇨','Gibraltar':'🇬🇮' };
const flagFor = c => FLAG[c] || '🏳️';
/* keep only genuine common stocks on a real US exchange (no OTC/PINK/grey) */
const MAJOR_EXCH = new Set(['NYSE', 'NASDAQ', 'NYSE ARCA', 'NYSE MKT', 'NYSE American', 'AMEX', 'BATS']);
const MIN_GROWTH_YRS = 10;  // "all-time" growth needs a real, decade-plus track record
const BASE_FLOOR = 0.02;    // reject sub-penny historical bases (corrupted split/denomination splices)

/* ---- 1. universe selection --------------------------------------------- */
async function pickUniverse() {
  // The screener caps offset at ~1000, so to reach deeper than the mega-caps we
  // sweep market-cap BANDS (each band well under the cap), all on the US "virtual"
  // exchange. US screener market caps are clean USD; foreign giants appear here as
  // ADRs (also USD) — their true home country comes from AddressData later.
  const BANDS = [[100e9, null], [30e9, 100e9], [10e9, 30e9], [5e9, 10e9], [2e9, 5e9]];
  let rows = [];
  for (const [lo, hi] of BANDS) {
    const filters = [['exchange', '=', 'us'], ['market_capitalization', '>', lo]];
    if (hi) filters.push(['market_capitalization', '<', hi]);
    const enc = encodeURIComponent(JSON.stringify(filters));
    for (let off = 0; off < 1000; off += 100) {
      const j = await getJSON(`${BASE}/screener?${tok}&sort=market_capitalization.desc&filters=${enc}&limit=100&offset=${off}`, { ttlDays: 3 });
      const data = (j && (j.data || [])) || [];
      rows.push(...data);
      if (data.length < 100) break;
    }
  }
  // dedupe share classes / cross-listings by company name, keep the biggest
  const seen = new Map();
  for (const r of rows) {
    const mc = +r.market_capitalization || 0;
    if (mc <= 0) continue;
    const key = normName(r.name); if (!key) continue;
    const cand = { ticker: `${r.code}.${r.exchange || 'US'}`, name: r.name, exch: r.exchange || 'US', sector: r.sector, mcapUSD: mc / 1e9 };
    if (!seen.has(key) || seen.get(key).mcapUSD < cand.mcapUSD) seen.set(key, cand);
  }
  // build extra to absorb common-stock/exchange filter drop-outs; main() re-cuts to LIMIT
  const list = [...seen.values()].sort((a, b) => b.mcapUSD - a.mcapUSD).slice(0, Math.ceil(LIMIT * 1.4));
  console.log(`Universe: ${rows.length} screener rows → ${seen.size} unique companies → ${list.length} candidates (down to ~$2B)`);
  return list;
}

/* ---- 2+3. fetch + per-stock metrics ------------------------------------ */
async function buildStock(c) {
  const f = await getJSON(epFund(c.ticker));
  if (!f || !f.General) return null;
  const G = f.General, H = f.Highlights || {}, V = f.Valuation || {}, SD = f.SplitsDividends || {};
  if (G.Type !== 'Common Stock') return null;                  // drop preferreds, notes/bonds, ETFs, funds
  if (G.Exchange && !MAJOR_EXCH.has(G.Exchange)) return null;  // drop OTC / PINK / grey-market listings
  let mcapUSD = num(H.MarketCapitalization);
  if (!mcapUSD && c.mcapUSD) mcapUSD = c.mcapUSD * 1e9;   // fall back to the screener's market cap
  if (!mcapUSD) return null;

  const [eod, divs, splits] = await Promise.all([getJSON(epEOD(c.ticker)), getJSON(epDiv(c.ticker)), getJSON(epSplits(c.ticker))]);
  if (!Array.isArray(eod) || eod.length < 12) return null;
  if (eod.some(r => r.warning) && !buildStock._warned) {
    console.warn('\n  ⚠ EOD history truncated to ~1yr — free-tier plan. All-time growth/CAGR/TSR need a paid plan.');
    buildStock._warned = true;
  }

  // clean the raw series: drop EODHD sentinel/garbage rows (e.g. close=999999.9999)
  // and any pre-IPO spliced predecessor data (a ticker reused after a spin-off,
  // like MCO carrying Dun & Bradstreet's pre-2000 prices), so growth is measured
  // over the CURRENT company's real listing only.
  // drop sentinel/garbage rows: raw close must be a real price (sub-penny RAW
  // closes are corrupted, e.g. AU's $0.0002 — but a low SPLIT-ADJUSTED price is
  // fine for heavily-split winners like Monster, so the floor is on raw close).
  const sane = eod.filter(r => { const c = num(r.close); return c != null && c >= BASE_FLOOR && c < 999990; });
  let series = sane;
  const ipoISO = (G.IPODate && /^\d{4}-\d\d-\d\d/.test(G.IPODate)) ? G.IPODate : null;
  if (ipoISO) {
    const clipped = sane.filter(r => r.date >= ipoISO);
    // use the IPO-clipped series only if it STILL spans a real track record (this
    // drops pre-IPO predecessor splices like MCO=Dun&Bradstreet); but if clipping
    // would erase a long history (a rename, e.g. Hansen→Monster), keep the full one
    if (clipped.length >= 12 && yearsBetween(clipped[0].date, clipped[clipped.length - 1].date) >= MIN_GROWTH_YRS) series = clipped;
  }
  if (series.length < 12) return null;

  // split-adjusted price series (price-only) + adjusted_close (total return)
  const splitFactor = buildSplitFactors(splits, series);
  const px = series.map(r => ({ d: r.date, p: num(r.close) * (splitFactor[r.date] || 1), adj: num(r.adjusted_close) || num(r.close) })).filter(r => r.p);
  const first = px[0], last = px[px.length - 1];
  const yrs = Math.max(yearsBetween(first.d, last.d), 0.5);
  // all-time growth metrics are only meaningful with a long, clean history —
  // null them for recent IPOs/spinoffs and corrupted sub-penny price splices,
  // so they don't pollute the growth / hall-of-shame leaderboards.
  const cleanHist = yrs >= MIN_GROWTH_YRS; // raw-price sanity already enforced in `sane`
  const absGrowth = cleanHist ? (last.p / first.p - 1) * 100 : null;
  const cagr = cleanHist ? (Math.pow(last.p / first.p, 1 / yrs) - 1) * 100 : null;
  const tsr = cleanHist ? (Math.pow((last.adj || last.p) / (first.adj || first.p), 1 / yrs) - 1) * 100 : null;

  // monthly returns of total-return series → vol, sharpe, maxDD
  const adj = px.map(r => r.adj || r.p);
  const rets = []; for (let i = 1; i < adj.length; i++) rets.push(adj[i] / adj[i - 1] - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length || 1));
  const vol = sd * Math.sqrt(12) * 100;
  const sharpe = (sd && rets.length >= 36) ? ((mean * 12 - 0.03) / (sd * Math.sqrt(12))) : null; // 3% rf, ≥3yr
  let peak = -1e9, maxDD = 0; adj.forEach(v => { peak = Math.max(peak, v); maxDD = Math.min(maxDD, v / peak - 1); });

  // dividends: cumulative/share, avg yield, current yield, growth streak
  const divRows = Array.isArray(divs) ? divs.map(d => ({ y: +d.date.slice(0, 4), v: num(d.value) })).filter(d => d.v) : [];
  const cumDiv = divRows.reduce((a, b) => a + b.v, 0);
  const byYear = {}; divRows.forEach(d => byYear[d.y] = (byYear[d.y] || 0) + d.v);
  const curYr = +last.d.slice(0, 4);                                    // exclude the in-progress year
  const divYears = Object.keys(byYear).map(Number).filter(y => y < curYr).sort((a, b) => a - b);
  let divStreak = 0;                                                    // consecutive full calendar years of rising dividends
  for (let i = divYears.length - 1; i > 0; i--) {
    if (divYears[i] === divYears[i - 1] + 1 && byYear[divYears[i]] > byYear[divYears[i - 1]]) divStreak++;
    else break;                                                        // a gap year or a cut ends the streak
  }
  const curYield = num(SD.ForwardAnnualDividendYield) != null ? num(SD.ForwardAnnualDividendYield) * 100
    : (num(H.DividendYield) != null ? num(H.DividendYield) * 100 : 0);
  // avg yield ≈ mean of (annual dividend / that year's avg price)
  const yrlyClose = {}; px.forEach(r => (yrlyClose[+r.d.slice(0, 4)] ||= []).push(r.p));
  const yields = divYears.map(y => { const arr = yrlyClose[y]; if (!arr) return null; const ap = arr.reduce((a, b) => a + b, 0) / arr.length; return byYear[y] / ap * 100; }).filter(x => x != null);
  const avgYield = yields.length ? yields.reduce((a, b) => a + b, 0) / yields.length : 0;

  const r1 = trailingReturn(px, 1) * 100;

  // real home country from HQ address (ADRs list as USA but are domiciled abroad)
  let homeCountry = (G.AddressData && G.AddressData.Country) || G.CountryName || 'United States';
  if (homeCountry === 'USA') homeCountry = 'United States'; // canonicalise so US names merge
  // per-decade total return (powers the champions-by-decade view)
  const dec = {};
  for (const ds of [1970, 1980, 1990, 2000, 2010, 2020]) {
    const seg = px.filter(r => { const y = +r.d.slice(0, 4); return y >= ds && y <= ds + 9; });
    if (seg.length >= 6) { const a0 = seg[0].adj || seg[0].p, a1 = seg[seg.length - 1].adj || seg[seg.length - 1].p; if (a0 > 0) dec[ds + 's'] = round((a1 / a0 - 1) * 100); }
  }

  return {
    id: G.Code, ticker: c.ticker, name: G.Name, exchange: G.Exchange || c.exch,
    country: homeCountry, flag: flagFor(homeCountry), sector: G.Sector || c.sector || 'Other',
    currency: G.CurrencyCode || 'USD', ipoYear: +first.d.slice(0, 4), price: num(last.p), // "since" = first available price
    mcap: +(mcapUSD / 1e9).toFixed(2),
    m: {
      absGrowth: round(absGrowth), cagr: round(cagr, 1), tsr: round(tsr, 1),
      cumDiv: round(cumDiv, 2), avgYield: round(avgYield, 2), curYield: round(curYield, 2),
      pe: num(V.TrailingPE) || num(H.PERatio), pb: num(V.PriceBookMRQ), ps: num(V.PriceSalesTTM),
      evEbitda: num(V.EnterpriseValueEbitda), peg: num(H.PEGRatio),
      sharpe: sharpe != null ? round(sharpe, 2) : null, vol: round(vol), maxDD: round(maxDD * 100),
      divStreak,
      roe: num(H.ReturnOnEquityTTM) != null ? round(num(H.ReturnOnEquityTTM) * 100) : null,
      roic: num(H.ReturnOnAssetsTTM) != null ? round(num(H.ReturnOnAssetsTTM) * 100) : null,
      grossMargin: (num(H.GrossProfitTTM) != null && num(H.RevenueTTM)) ? round(num(H.GrossProfitTTM) / num(H.RevenueTTM) * 100) : null,
      netMargin: num(H.ProfitMargin) != null ? round(num(H.ProfitMargin) * 100) : null,
      wealthUSD: +(mcapUSD / 1e9).toFixed(0), // proxy: present shareholder value; refined later
      ret1y: round(r1, 1),
      valueScore: null, qualityScore: null, // filled cross-sectionally below
    },
    series: downsampleSeries(px), dec,
  };
}

function buildSplitFactors(splits, eod) {
  // returns map date→cumulative factor so close*factor is split-adjusted to "today"
  const f = {}; eod.forEach(r => f[r.date] = 1);
  if (!Array.isArray(splits) || !splits.length) return f;
  const events = splits.map(s => ({ d: s.date, r: parseSplit(s.split) })).filter(s => s.r).sort((a, b) => a.d < b.d ? -1 : 1);
  // factor for a date = product of all splits that happen AFTER that date
  const dates = eod.map(r => r.date);
  // divide by each post-date split ratio: a 2:1 split makes one old share into
  // two of today's, so a pre-split raw close must be HALVED onto today's basis.
  dates.forEach(d => { let factor = 1; events.forEach(ev => { if (ev.d > d) factor /= ev.r; }); f[d] = factor; });
  return f;
}
const parseSplit = s => { if (!s) return null; const m = ('' + s).split(/[\/:]/).map(Number); return (m.length === 2 && m[1]) ? m[0] / m[1] : null; };

function trailingReturn(px, years) {
  const last = px[px.length - 1]; const cutoff = new Date(last.d); cutoff.setFullYear(cutoff.getFullYear() - years);
  const base = px.find(r => new Date(r.d) >= cutoff) || px[0];
  return (last.adj || last.p) / (base.adj || base.p) - 1;
}
function downsampleSeries(px) {
  // one indexed point per year, normalised to 100 at the first point (total-return)
  const byYear = {}; px.forEach(r => byYear[+r.d.slice(0, 4)] = (r.adj || r.p));
  const years = Object.keys(byYear).map(Number).sort(); if (!years.length) return null;
  const base = byYear[years[0]];
  return years.map(y => [y, +(100 * byYear[y] / base).toFixed(2)]);
}
const round = (x, d = 0) => x == null || isNaN(x) ? null : +(+x).toFixed(d);

/* ---- 4. cross-sectional composites ------------------------------------- */
function addComposites(stocks) {
  const inv = v => v == null ? null : v; // higher multiple = richer
  const pe = stocks.map(s => s.m.pe), pb = stocks.map(s => s.m.pb), ps = stocks.map(s => s.m.ps), ev = stocks.map(s => s.m.evEbitda), peg = stocks.map(s => s.m.peg);
  const roic = stocks.map(s => s.m.roic), nm = stocks.map(s => s.m.netMargin), gm = stocks.map(s => s.m.grossMargin), shp = stocks.map(s => s.m.sharpe);
  stocks.forEach(s => {
    const vparts = [pctRank(pe, s.m.pe), pctRank(pb, s.m.pb), pctRank(ps, s.m.ps), pctRank(ev, s.m.evEbitda), pctRank(peg, s.m.peg)].filter(x => x != null);
    s.m.valueScore = vparts.length ? Math.round(vparts.reduce((a, b) => a + b, 0) / vparts.length) : 50;
    const qparts = [pctRank(roic, s.m.roic), pctRank(nm, s.m.netMargin), pctRank(gm, s.m.grossMargin), pctRank(shp, s.m.sharpe)].filter(x => x != null);
    s.m.qualityScore = qparts.length ? Math.round(qparts.reduce((a, b) => a + b, 0) / qparts.length) : 50;
  });
}

/* ---- runner ------------------------------------------------------------- */
async function pool(items, worker, n) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const idx = i++; try { out[idx] = await worker(items[idx], idx); } catch (e) { out[idx] = null; }
      if (idx % 25 === 0) process.stdout.write(`\r  fetched ${idx}/${items.length}   `); }
  }));
  return out;
}

(async function main() {
  console.log('Stock Explorer — building dataset from EODHD');
  const shortlist = TICKERS
    ? TICKERS.split(',').map(t => { t = t.trim(); return { ticker: t, name: t, exch: (t.split('.')[1] || 'US') }; })
    : await pickUniverse();
  console.log(`Fetching fundamentals + history for ${shortlist.length} candidates…`);
  let stocks = (await pool(shortlist, buildStock, CONCURRENCY)).filter(Boolean);
  console.log(`\n  built ${stocks.length} stocks`);
  // global market-cap cut (skip when an explicit ticker list was given)
  stocks.sort((a, b) => b.mcap - a.mcap);
  if (!TICKERS) stocks = stocks.slice(0, LIMIT);
  addComposites(stocks);

  const out = {
    meta: { asOf: new Date().toISOString().slice(0, 10), source: 'EODHD All-In-One', universe: `Global equities · ${EXCHANGES.join(', ')}`, count: stocks.length, currency: 'USD (market cap normalised)', sample: false },
    perspectives: SAMPLE_PERSPECTIVES(),
    stocks,
  };
  const body = `/* GENERATED by build_stocks.mjs on ${out.meta.asOf} — do not edit by hand. */\nwindow.STOCKS = ${JSON.stringify(out)};\n`;
  writeFileSync(join(__dir, 'data', 'stocks.js'), body);
  console.log(`✓ wrote data/stocks.js — ${stocks.length} companies`);
})();

/* the perspective definitions must match the frontend; kept here so a rebuild
   regenerates them too. (Mirror of the sample file's `perspectives`.) */
function SAMPLE_PERSPECTIVES() {
  return JSON.parse(readFileSync(join(__dir, 'data', 'perspectives.json'), 'utf8'));
}
