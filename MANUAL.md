# Trending Lab — Manual

What the lab does, and **every hard-coded decision** it makes. If you change a threshold
or a list, change it here too.

| What | Where it lives |
|---|---|
| Thresholds for every spam flag | `rules.js` → `RULES` |
| Addresses that are never shown (stablecoins, majors) | `config/exclusions.json` |
| Source endpoints, time window, polling | `server.js` + `.env` |
| API keys | `.env` (never commit) |

---

## 1. Pipeline (one poll)

Runs once at startup and again each time **Poll fresh** is clicked.

1. **Fetch** the three trending lists in parallel (section 2).
2. **Enrich every Solana token with Jupiter data**: organic score, organic volume,
   organic buyers, holder growth, verified flag, audit (mint/freeze, top holders).
   This covers Solana tokens from all three lists, not only Jupiter's own list.
3. **Enrich every token with CoinGecko token data** (`/tokens/multi/{addrs}?include=top_pools`,
   30 tokens per call; Solana tokens Jupiter already covers are skipped): whether it is a
   listed CoinGecko coin, its liquidity across *all* pools, and its **main pool's buys,
   sells, buyers, sellers (24h and 1h), 24h volume, 24h price change and creation time**.
   This gives wallet-level activity, volume and age on **every chain** using calls we
   already make.
4. **Merge** each token across sources. Liquidity is the **largest** value any source
   reports. Age is the **earliest** pool creation (Jupiter's first-pool time wins when
   available).
5. **Exclude** any token whose chain + address is in `config/exclusions.json`. Excluded
   tokens are listed in the **Excluded** view and never get flags.
6. **Flag** what's left using the rules in section 4. Each source's row is flagged on its
   **own** data. Fields the row is **missing** are filled from the token's other rows
   (order: Jupiter → CoinGecko → Birdeye); values a row already has are never replaced. So
   when sources disagree (e.g. one reports a $0 market cap), the same token can show
   different flags on different lists.
7. **Save** a snapshot to `data/snapshots/YYYY-MM-DD/HHMMSS.json`.

## 2. Sources

| Source | Endpoint | Time window | Notes |
|---|---|---|---|
| Jupiter | `GET /tokens/v2/toptrending/{window}?limit=50` | 5m | Solana only. Keyless `lite-api` unless `JUPITER_API_KEY` is set. |
| CoinGecko | `GET /onchain/networks/trending_pools?duration={window}` (pages 1–3 = 60 pools, `COINGECKO_PAGES`) | 5m | Returns **pools**; one token can have several. We keep the highest-ranked pool per token. |
| Birdeye | `GET /defi/token_trending?interval=5m&mode=selective`, one call per chain, top 50 per chain (`BIRDEYE_MAX_PER_CHAIN`) | 5m | 5m and 30m exist only in `mode=selective`; `classic` mode starts at 1h. Chains: `BIRDEYE_CHAINS`. Quiet chains may return few or no tokens. |


**DexScreener is not a list source.** Its public API has no trending endpoint; its only
list is paid boosts (19 of 30 were red, only 6 of 30 on any other list). It is used for two
tags instead (section 4): `GET /token-boosts/top/v1` (1 call) and a batch lookup via
`GET /tokens/v1/{chain}/{up to 30 addresses}` (free, no key), whose pairs include
`boosts.active`. The batch lookup runs **after flagging and only for tokens that will be
shown** (no red row) — red tokens are hidden, so checking them would waste calls.

Time window is set by `TRENDING_WINDOW` in `.env` (`5m` | `1h` | `6h` | `24h`).
Birdeye has no 6h, so `6h` maps to Birdeye `4h`.

## 3. Exclusions (`config/exclusions.json`)

Tokens matched **by chain + contract address only** are removed from every list.
Ticker or name matching is never used to exclude (too easy to get wrong).

**What goes in:**

- **`stablecoins`**: any token meant to hold a fixed value (USD, EUR), including bridged
  versions (USDC.e) and yield-bearing wrappers (jlUSDC, syrupUSDC).
- **`lp_and_index`**: pool-share and index tokens that aren't traded as coins (e.g. JLP,
  Jupiter Perps LP).
- **`majors`**: the native coin of a major chain and its wrapped, bridged and staked
  versions on any chain. Covers BTC, ETH, SOL, BNB, HYPE, XRP, TRX, DOGE, NEAR, ZEC,
  XMR, AVAX, plus staked versions such as JitoSOL, mSOL, stETH, wstETH and cbETH.

**Current size:** 107 addresses (49 stablecoins, 1 LP/index, 57 majors) across Solana, Ethereum,
Base, BSC, Arbitrum, World Chain, Robinhood Chain and HyperEVM.

**Adding a token**

1. Copy the contract address (the copy button next to any token).
2. Add `{ "chain": "...", "address": "...", "symbol": "..." }` under the right list.
   Chain ids: `solana`, `ethereum`, `base`, `bsc`, `arbitrum`, `world-chain`, `hyperevm`,
   `robinhood`, …
3. Run `node scripts/verify-exclusions.js`. It checks every address against DexScreener
   (and Jupiter for Solana) and prints any that resolve to a different symbol or aren't found.
4. Click **Poll fresh**. The file is re-read on every poll; no restart is needed.

**Finding missing ones:** an established token (Jupiter-verified or a listed CoinGecko
coin) whose ticker looks like a major or a stablecoin, but isn't in the file, gets the
blue **`add_to_exclusions`** hint. Stablecoin means USD/EUR/DAI/GHO in the ticker and a
price between $0.90 and $1.25. Add its address if it really is one.

**Shared tickers are fine.** A token that reuses a major's ticker (e.g. a meme called
"BTC") is judged on its own numbers like any other token. Sharing tickers is normal, so
there is no impersonator flag.

Major tickers recognised: BTC, ETH, SOL, BNB, HYPE, XRP, TRX, DOGE, ADA, AVAX, SUI, TON,
NEAR, LTC, BCH, XMR, ZEC, DOT, including W/cb/st/wst/so/x/z/u/b prefixes (WBTC, cbBTC, …).

**Refreshing the Solana staked-SOL list:** Jupiter lists every liquid-staking token
under `GET /tokens/v2/tag?query=lst` (163 at last check). Only those above about $5M
market cap are in the file.

## 4. Flags

Colours: **red row** = at least one high flag. Chips: red = high, yellow = medium,
blue = information only. **"Hide high-risk"** hides red rows; **"Hide any flagged"**
also hides yellow.

"**Established**" means Jupiter-verified **or** a listed CoinGecko coin. Some checks
skip established tokens because big tokens trade mostly on centralised exchanges, so
their on-chain pools look small next to their market cap.

"**Market cap**" means the source's market cap; when it is missing or reported as $0 (CoinGecko
does this for some tokens), **FDV** is used instead, and the list shows "FDV" instead of "MC".
**Self-check:** a row's market cap can't be larger than its own FDV (circulating supply ≤
total supply). If it is (more than 1% above, e.g. CoinGecko's IRYS: $154M cap vs $4.8M
FDV), the row's FDV is used as its market cap, and the token popup notes the original figure.
Only that row's own data is used.

"**Liquidity**" always means the largest liquidity any source reports for the token
(section 1, step 4). This avoids judging a token by one small pool.

| Flag | Severity | Fires when | Threshold (`RULES`) |
|---|---|---|---|
| `no_liq` | high | best liquidity < $1K, or none reported. Ratio checks are skipped. | `liquidity.noneUsd = 1,000` |
| `low_liq` | high | liquidity < $10K | `liquidity.lowUsd = 10,000` |
| `thin_liq` | med | liquidity ≥ $10K but **under 5% of market cap** (FDV if no market cap). Skipped for established tokens with a $10M+ cap: big caps trade mostly on CEXs, so their on-chain liquidity is naturally small (CAKE 0.5%, JUP 0.6%). Small tokens' median is ~17%. Overlaps with `mcap_vs_liq` (liquidity < 2%); in the ranking only one −5 counts. | `liquidity.thinPctOfCap = 5` |
| `mcap_vs_liq` | high / med | market cap ÷ liquidity > 200 / > 50. **Skipped for established tokens.** | `mcapVsLiquidity.highRatio = 200`, `medRatio = 50` |
| `fake_cap` | high | (a) market cap > $1B with liquidity < $1M, not established; **or** (b) token **under 24h old** with liquidity **< 3% of market cap** (FDV if none). A real launch starts with liquidity ~15–25% of market cap (healthy new tokens measured 6–22%), so far below that on a fresh token means the cap isn't real (e.g. USDF "United States Dividend Fund", 1h old pump.fun: $129.5M FDV on $965K liquidity = 0.7%). | `fakeCap.minCapUsd`, `maxLiquidityUsd`, `newTokenMaxHours = 24`, `newTokenMinLiqPct = 3` |
| `wash` | high | 24h volume ÷ liquidity > 50 **on a pool under $50K** (fake volume on a tiny pool) | `wash.turnover = 50`, `wash.maxLiquidityUsd = 50,000` |
| `high_turnover` | med | same ratio > 50 on a bigger pool (a hot token or wash trading; check `botted`) | same |
| `bot_trading_small_cap` | med | **All chains.** More than 25 trades per unique wallet in 24h (at least 500 trades), on a token that is **not established or under $10M** market cap. A few wallets trading back and forth to create volume. Wallet data, best first: Jupiter (Solana, all pools), then the token's main pool from CoinGecko (any chain), then the trending row. Ranking −5. | `botWallets.tradesPerWallet = 25`, `minTrades = 500` |
| `bot_trading_large_cap` | med | Same measurement, on an **established token with a $10M+** market cap (e.g. JCT, SPYx). Big tokens draw arbitrage and market-making bots, which is normal. Ranking 0 (tag only). | same, plus `organic.knownCoinMinCapUsd` |
| `no_sells` | high | **All chains, 24h only.** ≥ 50 buys and 0 sells (trending row or main pool), **or** ≥ 50 unique buyers in the main pool and sellers are under **1%** of buyers (e.g. ONE on BSC: 3,676 buyers, 13 sellers = 0.35%). **Skipped** for established tokens and whenever the source's own data shows sells. (A 1h window was dropped: JUP once showed 87 buys / 0 sells in one pool for an hour while having 46k sells overall.) | `honeypot.minBuys = 50`, `minBuyers = 50`, `maxSellerRatio = 0.01` |
| `big_trades` | high | **All chains.** Average trade size (24h volume ÷ 24h trades) > **$10K**, with ≥ 20 trades, on a token that is **not established or under $10M**. Retail memecoin trades are small; a few wallets moving tens of thousands per trade is fake volume (e.g. ELON on Base: $8.2M over 148 trades ≈ $55K per trade). Volume and trade counts come from the same place: main pool (CoinGecko), else Jupiter (all pools), else the trending row. | `bigTrades.avgTradeUsd = 10,000`, `minTrades = 20` |
| `few_sellers` | med | ≥ 100 buyers and sellers are under 5% of buyers in 24h (not for established tokens) | `honeypot.fewSellersRatio = 0.05` |
| `pump` | med | price +2000% in 24h | `pump.change24hPct = 2000` |
| `inorganic` | med | Jupiter organic score < 30 (Jupiter actually scored it: has an organic-buyer count, or the token is neither established nor under 24h old). Yellow, ranking −5. | `organic.minScore = 30` |
| `known_coin` | info | Jupiter didn't score the token (score < 30 and no organic-buyer count), it is established, **and** its market cap is ≥ $10M (e.g. Pnut, jellyjelly). A known coin, not a warning. | `organic.knownCoinMinCapUsd = 10,000,000` |
| `organic_unknown` | med | Jupiter didn't score the token (score < 30 and no organic-buyer count) and it is either **established with a cap under $10M** (e.g. JBMB) **or under 24h old** (too new to be scored yet, e.g. SpaceX, Google at < 1h). Can't tell how much activity is real. Ranking 0. Tokens Jupiter *has* scored low stay red `inorganic`, and `botted` still applies. | `organic.unscoredGraceHours = 24` |
| `botted` (fake crowd) | high | **Token 24h+ old:** holders up > 1000% in 24h **and** < 50 organic buyers. **Token under 24h old** ("24h holder growth" is just growth since launch): ≥ 200 traders **and** organic buyers < **1%** of traders **and** Jupiter organic score < **60** — both must agree. The ratio alone undercounts (JUP ≈ 1.2%, NVDAx ≈ 1.0%) and wrongly flagged healthy launches like Moustache Baby (1.8% real buyers, organic score 78, top holders 18%). Wallet farms: bots spray tokens to thousands of fresh wallets to fake a crowd. | `botted.holderGrowthPct = 1000`, `maxOrganicBuyers = 50`, `newTokenMaxRealBuyerPct = 1`, `newTokenMinTraders = 200`, `newTokenMaxOrganicScore = 60` |
| `botted` (young & inorganic) | high | younger than 7 days **and** < 1% of 24h volume is organic | `botted.maxAgeDays = 7`, `minOrganicVolumePct = 1` |
| `mint_auth` / `freeze_auth` | high | the creator can still mint more tokens or freeze holders (Solana, from Jupiter's audit) | — |
| `concentrated` | med | top holders own > 50%, **only for tokens under $10M market cap** (FDV if no market cap). Big tokens' top holders are mostly exchanges, pools and custody wallets. | `concentration.topHoldersPct = 50`, `maxCapUsd = 10,000,000` |
| `new` | info | younger than 60 minutes. Blue, not a warning: a new token that passed every red check and still made a list is a positive signal (+5 in the ranking). | `newToken.minAgeMinutes = 60` |
| `add_to_exclusions` | info | established token that looks like a major/stablecoin but isn't excluded — see section 3 | — |
| `dex_paid` | info | token has active DexScreener boosts (paid promotion), from the batch lookup | — |
| `dex_trending` | info | token is in DexScreener's top-30 boosted list (`/token-boosts/top/v1`). DexScreener's public "top" list is ranked by boosts, so this means "heavily promoted on DexScreener" | — |

### Why organic share alone isn't a filter

By Jupiter's measure, most volume on *every* Solana token is non-organic, because
arbitrage, market-making and MEV bots keep prices aligned across venues. At last check
JUP was 13.5% organic, cbBTC 2.5%, HYPE 1.3% and BOME 0.3%. A rule like "exclude
anything with bots" would empty the list. The `botted` rules target **fabricated demand**
instead: a *young* token with almost no organic volume, or holders exploding while almost
nobody real buys. (Example: ODIE had 11,837 "traders" but 19 organic buyers, and holders
went from about 41 to 8,251 in 24h.)

### `non_stable_pair` tag

Blue info tag (no risk weight, no ranking weight) when the token's **main pool is paired with something other
than a major or stablecoin**, e.g. SAI/SAC or ONE/OLY. A pool's liquidity is valued
using the paired token's price; if the creator controls that token, both liquidity and
market cap can be inflated. "Major or stablecoin" means any address in
`config/exclusions.json`, or a chain's native-coin placeholder (0x000…0 / 0xeee…e). Pair
data comes from the CoinGecko main pool (non-Solana), or the CoinGecko trending pool. If a real major or stablecoin shows up as the pair, add its address to
the exclusions file (e.g. Robinhood WETH and USDG were added this way).

### Honeypots without contract checks

`no_sells` detects honeypots from **trading data only**: people buy, nobody sells. It
costs no extra calls and works on every chain. Limits:

- It **can't prove** the contract blocks selling. At first check, 4 BSC tokens it flagged
  (AR, ONE, CLAW, MCOIN) were **not** called honeypots by Birdeye's or CoinGecko's
  contract scanners, yet CLAW had 1,436 buyers and 0 sellers. AR's contract lets the owner
  pause transfers, has a hidden owner and is mintable. So the flag means "possible
  honeypot or rigged market".
- It **misses** honeypots that let you sell but take a huge tax, timed traps that switch on
  later, and brand-new tokens with too few trades.
- A per-token contract scan (Birdeye `/defi/token_security`, one call per token, results can
  be cached forever) would catch coded traps before anyone gets stuck. Not enabled, to keep
  the call count down.

### Known gaps

- **Organic data (organic score, organic buyers, holder growth) is Solana-only** (from
  Jupiter), so `inorganic` and `botted` only fire on Solana. Other chains are covered by
  `bot_trading_small_cap` and `no_sells` (main-pool data from CoinGecko), which looks at the main
  pool only, not every pool.
- **CoinGecko liquidity can be $0** for tokens still on a launchpad bonding curve.
  These get `no_liq`.

## 5. Suzi Trending (combined ranking)

The fourth column. All three lists are combined into one ranked list. Weights live in
`rules.js` → `RANKING`. **These are starting values for discussion**, not final.

- **Red tokens are never shown.** If *any* of a token's rows is red, it's hidden (the column
  header shows how many).
- One entry per token. Display data comes from its first source row (Jupiter → CoinGecko →
  Birdeye), with missing fields filled from its other rows.

| Part | Points | Notes |
|---|---|---|
| Position on each list | up to **+40** (Jupiter), **+30** (CoinGecko, Birdeye), **added up** across the lists the token is on | Each list: #1 gets the full points, the last token ~0, linear (`listPosition`). List size is the source's original length (before exclusions). Birdeye uses its merged rank across all chains. |
| Appears on several lists | **2 lists −10, 3 lists −15** | (`listCount`). Negative because list positions are added up, so a multi-list token already collects points from each list; this damps that double reward. |
| `dex_trending` | **+10** | in DexScreener's top-30 boosted list |
| `dex_paid` | **+5** | has active paid boosts |
| 5m volume | **0** | no weight (`volume5m.maxPoints = 0`) |
| 24h price change | **−5 to −15** | Only when the price is **down**: −5 for any drop, then −0.5 per %, capped at **−15** (−20% or worse). E.g. −2% → −6, −10% → −10. Going up adds nothing — rising tokens already rank high on the source lists (`change24h`). Taken from the token's own row; if missing, from Jupiter (Solana) or its main pool on CoinGecko — no extra API calls. |
| 5m price change | **−3 to +3** | 0.5 points per %, capped at ±3 (±6% in 5 minutes) (`change5m`) |
| Yellow flags | **0 to −8** each | `high_turnover` −8; `few_sellers`, `mcap_vs_liq`, `bot_trading_small_cap`, `thin_liq`, `concentrated`, `pump`, `inorganic` −5; `bot_trading_large_cap`, `organic_unknown` 0; any other yellow −5 |
| Blue tags | `known_coin` **+5**, `new` **+5** | all other blue tags 0, including `non_stable_pair` (pairing with a non-major isn't necessarily bad) |
| Chain | BSC **−10** | per-chain adjustment, once per token (`chain`) |

**Conflicting rows:** a token's rows are flagged separately, so two sources can answer the
same check differently (IRYS: CoinGecko said $154M cap → `bot_trading_large_cap`, Birdeye
said $4.8M → `bot_trading_small_cap`). In the ranking, tags in the same group count once, the
stricter one wins (`exclusiveGroups`): `bot_trading_small_cap` over `bot_trading_large_cap`,
`organic_unknown` over `known_coin`, `mcap_vs_liq` over `thin_liq`.

Score = sum of all parts. Click a token to see its breakdown. The search results show
each token's Suzi rank, or "hidden (red)".

## 6. API calls per poll

Measured on a full poll (all three lists working):

| Provider | Calls | What |
|---|---|---|
| CoinGecko | ~9 | 3 trending pages + ~6 token lookups (30 per call, per chain; Solana tokens Jupiter covers are skipped) |
| Birdeye | 5 | 1 per chain (top 50 each) |
| Jupiter | ~2–3 | 1 trending list + ~2 lookups for Solana tokens from the other lists (50 per call) |
| DexScreener | ~11 | 1 top-boosts list + lookups for shown (non-red) tokens only (~190 tokens across ~8 chains, 30 per call per chain) |

Total ~27 (paid ~16). Trimmed from ~35 based on snapshot data: CoinGecko pages 4–5 put 0 tokens in the top 50;
Birdeye BSC ranks 51+ rarely rank; DexScreener checks of red tokens were wasted. Not done
yet: reusing lookups between polls (only look up new tokens) — the next big saving, for
production.

## 7. Running

```bash
node server.js                       # http://localhost:4321
node scripts/verify-exclusions.js    # check exclusion addresses (--all to list every match)
```

`.env` settings: `JUPITER_API_KEY`, `BIRDEYE_API_KEY`, `COINGECKO_PRO_API_KEY` (or
`COINGECKO_DEMO_API_KEY`), `TRENDING_WINDOW` (default `5m`), `POLL_SECONDS` (default `0`
= manual only), `BIRDEYE_CHAINS`, `PORT`.

CoinGecko keys must start with uppercase **`CG-`**; a lowercase `cg-` is rejected.
