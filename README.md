# Trending Tokens

A cross-chain trending-token list: merges the trending lists from **Jupiter**, **CoinGecko** and
**Birdeye**, filters out spam, removes stablecoins and majors, and ranks what's left with our own
scoring.

- **How it works, every rule and weight:** [MANUAL.md](MANUAL.md)
- **All thresholds, flags and ranking weights:** [rules.js](rules.js)
- **Blocklist (stablecoins, majors, LP/index tokens):** [config/exclusions.json](config/exclusions.json)

## Run it

Requires Node 18+. No dependencies.

Create a `.env` file in this folder:

```
BIRDEYE_API_KEY=your_key
COINGECKO_PRO_API_KEY=your_key   # or COINGECKO_DEMO_API_KEY; without one, keyless GeckoTerminal is used
JUPITER_API_KEY=                 # optional, Jupiter works without one
```

Then:

```bash
node server.js   # open http://localhost:4321
```

Optional settings: `TRENDING_WINDOW` (default `5m`), `POLL_SECONDS` (default `0` = manual only),
`BIRDEYE_CHAINS`, `COINGECKO_PAGES`, `BIRDEYE_MAX_PER_CHAIN`, `JUPITER_LIMIT`, `PORT`.

The page shows the three source lists plus the combined **Suzi Trending** column. Data refreshes
only when you click **Poll fresh**. Each poll is saved to `data/snapshots/` (git-ignored).

After editing the blocklist:

```bash
node scripts/verify-exclusions.js
```
