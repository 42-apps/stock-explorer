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

  // --- extra metrics: all from cached fundamentals/history, no new API calls ---
  const Fin = f.Financials || {}, Tech = f.Technicals || {};
  const cf = latestFin(Fin.Cash_Flow);
  const absGrowthTR = cleanHist ? ((last.adj || last.p) / (first.adj || first.p) - 1) * 100 : null; // dividends-reinvested
  const downside = Math.sqrt(rets.filter(x => x < 0).reduce((a, b) => a + b * b, 0) / (rets.length || 1));
  const sortino = (downside && cleanHist) ? (mean * 12 - 0.03) / (downside * Math.sqrt(12)) : null;
  const calmar = (cleanHist && maxDD < 0) ? (cagr / 100) / Math.abs(maxDD) : null;
  let pk = -1e9, uw = 0, uwMax = 0;                                  // longest stretch underwater (months)
  adj.forEach(v => { if (v >= pk) { pk = v; uw = 0; } else { uw++; if (uw > uwMax) uwMax = uw; } });
  const ser = downsampleSeries(px) || [];
  let downYears = null; // only meaningful with a long record, else recent IPOs win trivially
  if (ser.length >= 15) { downYears = 0; for (let i = 1; i < ser.length; i++) if (ser[i][1] < ser[i - 1][1]) downYears++; }
  const splitCount = Array.isArray(splits) ? splits.length : 0;
  const splitMult = (Array.isArray(splits) ? splits : []).reduce((a, s) => { const r = parseSplit(s.split); return r ? a * r : a; }, 1);
  let divCagr = null;
  if (divYears.length >= 6) {
    const fy = divYears[1], ly = divYears[divYears.length - 1]; // skip the (often partial) first dividend year
    if (byYear[fy] > 0 && ly > fy) { const g = (Math.pow(byYear[ly] / byYear[fy], 1 / (ly - fy)) - 1) * 100; if (g <= 60 && g >= -50) divCagr = g; }
  }
  // statements are in the filing currency (Cash_Flow.currency_symbol) but mcap is
  // USD, so $-ratios are only valid for USD filers; null the rest until FX lands.
  const cfCcy = (Fin.Cash_Flow && Fin.Cash_Flow.currency_symbol) || 'USD';
  const fcf = cf ? finNum(cf.freeCashFlow) : null;
  let fcfYield = (cfCcy === 'USD' && fcf != null && mcapUSD) ? fcf / mcapUSD * 100 : null;
  const divPaid = cf ? Math.abs(finNum(cf.dividendsPaid) || 0) : 0;
  const buyback = cf ? Math.max(0, -(finNum(cf.salePurchaseOfStock) || 0)) : 0;
  let shYield = (cfCcy === 'USD' && mcapUSD) ? (divPaid + buyback) / mcapUSD * 100 : null;
  if (fcfYield != null && (fcfYield > 60 || fcfYield < -60)) fcfYield = null; // backstop
  if (shYield != null && (shYield < 0 || shYield > 60)) shYield = null;
  let revCagr = finCagr(Fin.Income_Statement, 'totalRevenue', 10);
  if (revCagr != null && (revCagr > 100 || revCagr < -60)) revCagr = null; // tiny-base / distressed artifacts
  const rule40 = (revCagr != null && num(H.ProfitMargin) != null) ? revCagr + num(H.ProfitMargin) * 100 : null;
  const beta = finNum(Tech.Beta);
  const hi52 = finNum(Tech['52WeekHigh']), lo52 = finNum(Tech['52WeekLow']);
  const range52 = (hi52 && lo52 && hi52 > lo52) ? (num(last.p) - lo52) / (hi52 - lo52) * 100 : null;
  const apprec = cleanHist ? Math.max(0.03, Math.min(1, 1 - first.p / last.p)) : 0.5; // share of cap that is appreciation
  const wealthCreated = +((mcapUSD / 1e9) * apprec).toFixed(0);      // improved "wealth created" proxy (was raw mcap)
  // EODHD's adjusted_close is corrupted by some mid-history merger/spinoff splices,
  // inflating total-return absurdly (e.g. JCI 47M%). Null TR fields past a ceiling
  // no real name here reaches (Altria, the legit max, is ~2.65M%).
  const trArtifact = absGrowthTR != null && absGrowthTR > 5000000;
  const absGrowthTRok = trArtifact ? null : absGrowthTR;
  const tsrOk = trArtifact ? null : tsr;
  // Phoenix: huge total return DESPITE a brutal (≥60%) crash along the way
  const phoenix = (cleanHist && !trArtifact && maxDD <= -0.6 && absGrowthTRok > 0) ? round(absGrowthTRok) : null;

  return {
    id: G.Code, ticker: c.ticker, name: G.Name, exchange: G.Exchange || c.exch,
    country: homeCountry, flag: flagFor(homeCountry), sector: G.Sector || c.sector || 'Other', industry: G.Industry || null,
    currency: G.CurrencyCode || 'USD', ipoYear: +first.d.slice(0, 4), price: num(last.p), // "since" = first available price
    mcap: +(mcapUSD / 1e9).toFixed(2),
    m: {
      absGrowth: round(absGrowth), cagr: round(cagr, 1), tsr: round(tsrOk, 1),
      cumDiv: round(cumDiv, 2), avgYield: round(avgYield, 2), curYield: round(curYield, 2),
      pe: num(V.TrailingPE) || num(H.PERatio), pb: num(V.PriceBookMRQ), ps: num(V.PriceSalesTTM),
      evEbitda: num(V.EnterpriseValueEbitda), peg: num(H.PEGRatio),
      absGrowthTR: round(absGrowthTRok), divCagr: round(divCagr, 1),
      sharpe: sharpe != null ? round(sharpe, 2) : null, sortino: round(sortino, 2), calmar: round(calmar, 2),
      vol: round(vol), maxDD: round(maxDD * 100), beta: round(beta, 2), downYears, underwaterMonths: uwMax,
      splitCount, splitMult: round(splitMult, 1), phoenix,
      divStreak,
      roe: num(H.ReturnOnEquityTTM) != null ? round(num(H.ReturnOnEquityTTM) * 100) : null,
      roic: num(H.ReturnOnAssetsTTM) != null ? round(num(H.ReturnOnAssetsTTM) * 100) : null,
      grossMargin: (num(H.GrossProfitTTM) != null && num(H.RevenueTTM)) ? round(num(H.GrossProfitTTM) / num(H.RevenueTTM) * 100) : null,
      netMargin: num(H.ProfitMargin) != null ? round(num(H.ProfitMargin) * 100) : null,
      fcfYield: round(fcfYield, 1), shYield: round(shYield, 1), revCagr: round(revCagr, 1), rule40: round(rule40), range52: round(range52),
      wealthUSD: wealthCreated, // appreciation-weighted proxy of lifetime wealth created (was raw mcap)
      ret1y: round(r1, 1),
      valueScore: null, qualityScore: null, alphaSpy: null, // filled cross-sectionally below
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
const finNum = x => { const n = parseFloat(x); return isFinite(n) ? n : null; };
function latestFin(section) { const y = section && section.yearly; if (!y) return null; const ks = Object.keys(y).sort(); return ks.length ? y[ks[ks.length - 1]] : null; }
function finCagr(section, field, maxYrs = 10) {
  const y = section && section.yearly; if (!y) return null;
  const ks = Object.keys(y).sort(); if (ks.length < 6) return null;
  const si = Math.max(0, ks.length - 1 - maxYrs), n = ks.length - 1 - si;
  const v0 = finNum(y[ks[si]][field]), v1 = finNum(y[ks[ks.length - 1]][field]);
  return (v0 && v1 && v0 > 0 && n >= 2) ? (Math.pow(v1 / v0, 1 / n) - 1) * 100 : null;
}

/* ---- 4. cross-sectional composites ------------------------------------- */
function addComposites(stocks) {
  const roic = stocks.map(s => s.m.roic), nm = stocks.map(s => s.m.netMargin), gm = stocks.map(s => s.m.grossMargin), shp = stocks.map(s => s.m.sharpe);
  const bySector = {}; stocks.forEach(s => (bySector[s.sector] ||= []).push(s));
  stocks.forEach(s => {
    // valuation ranked WITHIN sector — so "undervalued" isn't just a list of
    // structurally low-multiple sectors (banks/energy) vs high ones (tech).
    const peers = bySector[s.sector];
    const vr = field => pctRank(peers.map(x => x.m[field]), s.m[field]);
    const vparts = [vr('pe'), vr('pb'), vr('ps'), vr('evEbitda'), vr('peg')].filter(x => x != null);
    s.m.valueScore = vparts.length ? Math.round(vparts.reduce((a, b) => a + b, 0) / vparts.length) : 50;
    // quality ranked across the whole universe
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

  // benchmarks: SPY/QQQ for "did it beat the market?" + per-stock lifetime alpha
  const bench = {};
  for (const b of ['SPY', 'QQQ']) {
    const e = await getJSON(epEOD(b + '.US'));
    if (!Array.isArray(e)) continue;
    const byY = {}; e.forEach(r => { const y = +r.date.slice(0, 4), v = num(r.adjusted_close); if (v) byY[y] = v; });
    const ys = Object.keys(byY).map(Number).sort((a, b) => a - b);
    if (ys.length > 1) bench[b] = { from: ys[0], cagr: round((Math.pow(byY[ys[ys.length - 1]] / byY[ys[0]], 1 / (ys[ys.length - 1] - ys[0])) - 1) * 100, 1), byY };
  }
  if (bench.SPY) {
    const spy = bench.SPY.byY, ys = Object.keys(spy).map(Number).sort((a, b) => a - b), last = ys[ys.length - 1];
    stocks.forEach(s => {
      if (s.m.tsr == null) return;
      const y0 = spy[s.ipoYear] || spy[ys.find(y => y >= s.ipoYear)];
      if (!y0) return;
      const n = Math.max(last - Math.max(s.ipoYear, ys[0]), 1);
      s.m.alphaSpy = round(s.m.tsr - (Math.pow(spy[last] / y0, 1 / n) - 1) * 100, 1);
    });
  }
  console.log(`  benchmarks: SPY ${bench.SPY ? bench.SPY.cagr + '%/yr' : 'n/a'}, QQQ ${bench.QQQ ? bench.QQQ.cagr + '%/yr' : 'n/a'}`);

  const out = {
    meta: {
      asOf: new Date().toISOString().slice(0, 10), source: 'EODHD All-In-One',
      universe: `Global equities · US-listed (incl. ADRs) · ${stocks.length} companies`,
      count: stocks.length, currency: 'USD', sample: false,
      benchmarks: { SPY: bench.SPY && { from: bench.SPY.from, cagr: bench.SPY.cagr }, QQQ: bench.QQQ && { from: bench.QQQ.from, cagr: bench.QQQ.cagr } },
    },
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
