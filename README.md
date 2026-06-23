# Stock Explorer 📈

**The greatest stocks of all time — every which way.**

There is no single "best stock"; it depends entirely on what you value. This
explorer takes one global universe of equities and lets you switch the **lens**
to watch it re-rank: the all-time moonshots, the steady compounders, the
dividend kings, the bargains, the priced-for-perfection, the highest-quality
businesses, and the biggest wealth creators in history. Part of the
[42-apps](https://42-apps.github.io/) collection.

🔗 **Live:** https://42-apps.github.io/stock-explorer/

## The lenses

| Group | Lens | What it ranks |
|------|------|---------------|
| Growth | 🚀 Absolute growth · 📈 Annual (CAGR) · 💎 Total return | Price & total shareholder return since listing |
| Dividends | 🏦 Cumulative · 〰️ Average yield · 💵 Current yield · 👑 Aristocrats | Income, today and over a lifetime; 25/50-yr increase streaks |
| Valuation | 🔎 Most undervalued · 🎈 Most overvalued | A blend of P/E, P/B, P/S, EV/EBITDA & PEG vs. the universe |
| Quality | 🏅 Highest quality · 🛡️ Risk-adjusted (Sharpe) | Return on capital, margins, consistency, return-per-risk |
| Impact | 🌍 Wealth creators · 🔥 What's hot now · 💀 Hall of shame | Lifetime wealth created, 12-mo momentum, worst destroyers |

Plus a **⏳ $100 time machine** — pick a stock and a year and see what $100 would
be worth today.

## Data & method

- **Source:** [EODHD](https://eodhd.com) All-In-One — ~150k tickers across 60+
  global exchanges, 30+ years of split/dividend-adjusted history, dividends and
  fundamentals. The dataset is **pre-computed at build time** into a static JSON
  blob (`data/stocks.js`); the app itself makes no API calls and ships no keys.
- **Metrics** (growth, CAGR, total return, dividend stats, Sharpe, drawdown,
  valuation & quality composites, wealth created) are computed by
  `build_stocks.mjs` from raw price/dividend/fundamental history.
- **Caveats:** all-time tables suffer **survivorship bias** (delisted losers
  drop out) and **era bias** (raw growth favours the oldest survivors — hence
  the CAGR and per-decade views). Valuation lenses are **screens, not advice.**
- Wealth-creation framing is inspired by Hendrik Bessembinder's long-run
  shareholder-return research.

## Run it

Static site — no build step for the app itself.

```bash
python3 -m http.server 8772 --directory stock-explorer
# open http://localhost:8772

# regenerate the real dataset (needs an EODHD key — never committed):
export EODHD_API_TOKEN=xxxxx        # or put it in ./.eodhd_key
node build_stocks.mjs --limit 1200 --exchanges US,LSE,XETRA,PA,AS,SW,TO,HK,TSE

# or build an explicit short list (handy for testing one run):
node build_stocks.mjs --tickers AAPL.US,MSFT.US,KO.US,MO.US,JNJ.US
```

> **Plan requirement.** The pipeline needs an EODHD **All-In-One** subscription.
> The free tier (20 calls/day) returns **no fundamentals** and caps price
> history at **1 year**, so it cannot build this dataset — only `/div` and
> `/splits` are full history on free. The current `data/stocks.js` is **sample
> data** (`meta.sample = true`) until the pipeline runs against a paid key.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Markup & overlays |
| `app.css` | Styling (dark market-terminal theme) |
| `app.js` | Lens rail, podium, leaderboard, detail drawer, time machine |
| `data/stocks.js` | The dataset (generated; sample until pipeline runs) |
| `data/perspectives.json` | Canonical lens definitions (shared by app + pipeline) |
| `build_stocks.mjs` | EODHD pipeline → `data/stocks.js` |

Not financial advice. For education and curiosity. Figures are best-available
snapshots; corrections welcome.
