# Trending Tokens

A cross-chain trending-token list: merges the trending lists from **Jupiter**, **CoinGecko** and
**Birdeye**, filters out spam, removes stablecoins and majors, and ranks what's left with our own
scoring.

- **How it works, every rule and weight:** [MANUAL.md](MANUAL.md)
- **All thresholds, flags and ranking weights:** [rules.js](rules.js)
- **Blocklist (stablecoins, majors, LP/index tokens):** [config/exclusions.json](config/exclusions.json)

## Run it

Requires Node 18+. No dependencies.

```bash
cp .env.example .env   # add your Birdeye and CoinGecko keys (Jupiter works without one)
node server.js         # open http://localhost:4321
```

The page shows the three source lists plus the combined **Suzi Trending** column. Data refreshes
only when you click **Poll fresh**. Each poll is saved to `data/snapshots/` (git-ignored).

After editing the blocklist:

```bash
node scripts/verify-exclusions.js
```
