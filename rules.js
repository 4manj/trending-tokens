// Every hard-coded threshold and list the lab uses lives here (thresholds) or in
// config/exclusions.json (addresses). MANUAL.md documents each one — keep them in sync.

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------- thresholds

const RULES = {
  liquidity: {
    noneUsd: 1_000, // below → high `no_liq`; ratio checks are skipped (they'd be meaningless)
    lowUsd: 10_000, // below → high `low_liq`
    thinPctOfCap: 5, // ≥ lowUsd but liquidity < this % of market cap (FDV if none) → med `thin_liq`;
    // skipped for established tokens with a $10M+ cap (big caps trade mostly on CEXs).
    // Small tokens' median is ~17%; CAKE/JUP sit at 0.5%.
  },
  mcapVsLiquidity: {
    highRatio: 200, // market cap ÷ liquidity above → high
    medRatio: 50, // above → med
    // Skipped for "established" tokens (Jupiter-verified or listed on CoinGecko): big tokens
    // trade mostly on CEXs, so their on-chain pools are small compared to their cap.
  },
  fakeCap: {
    minCapUsd: 1e9, maxLiquidityUsd: 1e6, // huge cap on a tiny pool, not established → high
    // New tokens: a real launch starts with liquidity ~15–25% of market cap (healthy <24h
    // tokens measured 6–22%). Far below that on a fresh token means the cap isn't real.
    newTokenMaxHours: 24, // younger than this…
    newTokenMinLiqPct: 3, // …with liquidity below this % of market cap (FDV if none) → high
  },
  wash: {
    turnover: 50, // 24h volume ÷ liquidity above this…
    maxLiquidityUsd: 50_000, // …on a pool smaller than this → high `wash`
    // Same turnover on a bigger pool → med `high_turnover` (could be a real runner).
  },
  botWallets: {
    tradesPerWallet: 25, // 24h trades ÷ unique wallets above → med `bot_trading_small_cap` (all chains)
    minTrades: 500, // ignore tokens with fewer 24h trades (too little data)
  },
  honeypot: {
    minBuys: 50, // at least this many buys (24h or 1h) and zero sells → high
    minBuyers: 50, // at least this many unique buyers…
    maxSellerRatio: 0.01, // …and sellers ÷ buyers below 1% → high (only insiders can sell)
    fewSellersRatio: 0.05, // sellers ÷ buyers below 5%, with ≥ 100 buyers → med `few_sellers`
  },
  pump: { change24hPct: 2000 }, // +2000% in 24h → med
  bigTrades: {
    avgTradeUsd: 10_000, // 24h volume ÷ 24h trades above this…
    minTrades: 20, // …with at least this many trades (too few = noise)…
    // …on a token that is not established or under $10M → high `big_trades` (few wallets
    // trading huge amounts to fake volume; e.g. ELON on Base: $8.2M over 148 trades).
  },
  organic: {
    minScore: 30, // Jupiter organic score below → med `inorganic` (−5 in ranking)
    knownCoinMinCapUsd: 10e6, // unscored + established + cap ≥ this → info `known_coin` (else med `organic_unknown`)
    unscoredGraceHours: 24, // unscored tokens younger than this → med `organic_unknown`, not high `inorganic`
  },
  botted: {
    // Rule B1 "fake crowd": holders exploding while almost nobody real is buying.
    // Tokens 24h+ old: holder growth over 24h is meaningful.
    holderGrowthPct: 1000, // holders up more than this % in 24h…
    maxOrganicBuyers: 50, // …with fewer organic buyers than this → high
    // Tokens under 24h old: "24h holder growth" is just growth since launch (always huge),
    // so judge by the share of traders that are real buyers instead — but only when
    // Jupiter's own organic score agrees (its buyer count undercounts, so the ratio alone
    // flags healthy tokens: JUP ≈ 1.2%, NVDAx ≈ 1.0%).
    newTokenMaxRealBuyerPct: 1, // organic buyers ÷ traders below this % …
    newTokenMinTraders: 200, // …with at least this many traders …
    newTokenMaxOrganicScore: 60, // …and Jupiter organic score below this → high
    // Rule B2 "young and inorganic": new token whose volume is almost all bots.
    maxAgeDays: 7, // younger than this…
    minOrganicVolumePct: 1, // …and organic share of 24h volume below this % → high
  },
  concentration: {
    topHoldersPct: 50, // top holders own more than this % → med
    maxCapUsd: 10e6, // only for tokens under this market cap; big caps' top holders are mostly exchanges/custody
  },
  newToken: { minAgeMinutes: 60 }, // younger → info `new` (+5 in ranking)
};

// ---------------------------------------------------------------- exclusions

const EXCLUSIONS_FILE = path.join(__dirname, 'config', 'exclusions.json');
const ADDRESS_CASE_SENSITIVE = new Set(['solana', 'sui', 'ton', 'tron']);
const norm = (chain, address) => `${chain}:${ADDRESS_CASE_SENSITIVE.has(chain) ? address : String(address).toLowerCase()}`;

function loadExclusions() {
  const cfg = JSON.parse(fs.readFileSync(EXCLUSIONS_FILE, 'utf8'));
  const map = new Map();
  for (const [list, entries] of Object.entries(cfg)) {
    if (!Array.isArray(entries)) continue;
    for (const e of entries) map.set(norm(e.chain, e.address), { list, ...e });
  }
  return map;
}

// Tickers that look like a stablecoin or a major. Used only to *suggest* additions to
// exclusions.json — exclusion itself is by address only. Sharing a ticker is normal and
// never counts against a token.
const MAJOR_BASES = new Set(['BTC', 'ETH', 'SOL', 'BNB', 'HYPE', 'XRP', 'TRX', 'DOGE', 'ADA', 'AVAX', 'SUI', 'TON', 'NEAR', 'LTC', 'BCH', 'XMR', 'ZEC', 'DOT']);
const looksMajor = (sym) => {
  const s = sym.toUpperCase().replace(/^\$/, '').replace(/\.E$/, '');
  return MAJOR_BASES.has(s) || MAJOR_BASES.has(s.replace(/^(W|CB|ST|WST|SO|X|Z|U|B)/, '')) || /^(BTCB|WBTC|CBBTC|WETH|WSOL|WBNB|WHYPE)$/.test(s);
};
const looksStable = (sym, price) => /USD|EUR|DAI|GHO/i.test(sym) && price != null && price > 0.9 && price < 1.25;

// ---------------------------------------------------------------- flags

const fmt = (n) => {
  if (n === null || n === undefined) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toFixed(0);
};

// `t` is one source's row; `m` is the merged view of the same token across all sources
// (best liquidity, Jupiter organic data, verification) — see mergeTokens in server.js.
function flagsFor(t, m, exclusions) {
  const f = [];
  const add = (id, severity, reason) => f.push({ id, severity, reason });
  const R = RULES;
  const liq = m.liquidityUsd; // largest liquidity any source reports for this token
  const mc = t.marketCapUsd ?? t.fdvUsd;
  const vol = t.volume24hUsd ?? m.volume24hUsd ?? m.pool?.volume24hUsd;
  const established = m.verified === true || m.cgListed === true;

  // Liquidity
  const meaningfulLiq = liq && liq >= R.liquidity.noneUsd;
  if (!meaningfulLiq) add('no_liq', 'high', liq ? `Only $${fmt(liq)} liquidity across all sources` : 'No source reports any liquidity for this token');
  else if (liq < R.liquidity.lowUsd) add('low_liq', 'high', `Liquidity $${fmt(liq)} < $${fmt(R.liquidity.lowUsd)}`);
  else if (mc && (liq / mc) * 100 < R.liquidity.thinPctOfCap && !(established && mc >= R.organic.knownCoinMinCapUsd)) {
    add('thin_liq', 'med', `Liquidity $${fmt(liq)} is only ${((liq / mc) * 100).toFixed(1)}% of the $${fmt(mc)} ${t.marketCapUsd ? 'market cap' : 'FDV'}`);
  }

  // Market cap vs liquidity (skipped for established tokens)
  if (!established && mc && meaningfulLiq) {
    const r = mc / liq;
    if (r > R.mcapVsLiquidity.highRatio) add('mcap_vs_liq', 'high', `Market cap is ${Math.round(r)}× liquidity — cap likely not real`);
    else if (r > R.mcapVsLiquidity.medRatio) add('mcap_vs_liq', 'med', `Market cap is ${Math.round(r)}× liquidity`);
  }
  if (!established && mc > R.fakeCap.minCapUsd && (liq ?? 0) < R.fakeCap.maxLiquidityUsd) add('fake_cap', 'high', `$${fmt(mc)} cap with only $${fmt(liq || 0)} liquidity`);
  else {
    const ageH = m.createdAt ? (Date.now() - Date.parse(m.createdAt)) / 36e5 : null;
    if (ageH != null && ageH < R.fakeCap.newTokenMaxHours && mc && meaningfulLiq && (liq / mc) * 100 < R.fakeCap.newTokenMinLiqPct) {
      add('fake_cap', 'high', `New token (${ageH < 1 ? Math.round(ageH * 60) + ' min' : ageH.toFixed(1) + 'h'} old) with liquidity only ${((liq / mc) * 100).toFixed(1)}% of its $${fmt(mc)} ${t.marketCapUsd ? 'market cap' : 'FDV'} — cap isn't real`);
    }
  }

  // Wash trading: only "high" on small pools; on bigger pools it's just a hot token
  if (vol && meaningfulLiq && vol / liq > R.wash.turnover) {
    const x = Math.round(vol / liq);
    if (liq < R.wash.maxLiquidityUsd) add('wash', 'high', `24h volume is ${x}× a $${fmt(liq)} pool — fake volume on a tiny pool`);
    else add('high_turnover', 'med', `24h volume is ${x}× liquidity — hot token or wash trading`);
  }
  // Bot activity, all chains. Best wallet data first: Jupiter (Solana, all pools) → the
  // token's main pool from CoinGecko (any chain) → the source row. Pool wallets are
  // buyers + sellers, which double-counts wallets that did both, so this errs low.
  const p24 = m.pool?.h24;
  const activity = m.traders24h && m.txns24h ? { trades: m.txns24h, wallets: m.traders24h, where: 'all pools' }
    : p24?.buyers != null && (p24.buys ?? 0) + (p24.sells ?? 0) > 0 ? { trades: p24.buys + p24.sells, wallets: p24.buyers + p24.sellers, where: 'main pool' }
    : t.txns24h && t.traders24h ? { trades: t.txns24h, wallets: t.traders24h, where: 'trending pool' } : null;
  if (activity && activity.wallets && activity.trades >= R.botWallets.minTrades && activity.trades / activity.wallets > R.botWallets.tradesPerWallet) {
    const why = `${Math.round(activity.trades / activity.wallets)} trades per wallet in 24h (${activity.trades.toLocaleString()} trades, ${activity.wallets.toLocaleString()} wallets, ${activity.where})`;
    // Established tokens with a $10M+ cap (stocks, big caps) draw arbitrage/market-making
    // bots — normal, so med. Small listed tokens (e.g. PROS, $2.6M) get no pass.
    if (established && (mc ?? 0) >= R.organic.knownCoinMinCapUsd) add('bot_trading_large_cap', 'med', `${why} — mostly arbitrage/market-making bots`);
    else add('bot_trading_small_cap', 'med', `${why} — bot-driven volume`);
  }

  // Huge average trade size: retail memecoin trades are small; a few wallets moving tens of
  // thousands per trade is fake volume. Same-source volume and trade counts only.
  const tradeData = m.pool?.volume24hUsd != null && p24 ? { vol: m.pool.volume24hUsd, trades: (p24.buys ?? 0) + (p24.sells ?? 0), where: 'main pool' }
    : m.volume24hUsd != null && m.txns24h ? { vol: m.volume24hUsd, trades: m.txns24h, where: 'all pools' }
    : t.volume24hUsd != null && t.txns24h ? { vol: t.volume24hUsd, trades: t.txns24h, where: 'trending pool' } : null;
  const smallOrUnknown = !established || (mc ?? 0) < R.organic.knownCoinMinCapUsd;
  if (tradeData && smallOrUnknown && tradeData.trades >= R.bigTrades.minTrades && tradeData.vol / tradeData.trades > R.bigTrades.avgTradeUsd) {
    add('big_trades', 'high', `Average trade $${fmt(tradeData.vol / tradeData.trades)} ($${fmt(tradeData.vol)} over ${tradeData.trades.toLocaleString()} trades, ${tradeData.where}) — a few wallets faking volume`);
  }

  // Honeypot from trading data (no contract check): people buy but can't sell.
  const H = R.honeypot;
  // 24h only (a single pool over 1h is too noisy: JUP once showed 87 buys / 0 sells in 1h
  // while having 46k sells overall). Skipped for established tokens, and whenever any
  // source shows the token being sold.
  const someoneSells = (t.sells24h ?? 0) > 0 || (m.sells24h ?? 0) > 0; // any 24h data shows sells
  const jupAll = m.buys24h != null ? { buys: m.buys24h, sells: m.sells24h } : null; // Solana, all pools
  const windows = established || someoneSells ? [] : [['24h', t.buys24h != null ? { buys: t.buys24h, sells: t.sells24h } : null], ['24h', jupAll], ['24h', p24]];
  const noSells = windows.find(([, w]) => w && (w.buys ?? 0) >= H.minBuys && w.sells === 0);
  // Named `no_sells`, not `honeypot`: trading data shows nobody selling, but can't prove the
  // contract blocks sells (it may be a honeypot, a pausable/whitelisted token, or a rigged market).
  if (noSells) add('no_sells', 'high', `${noSells[1].buys.toLocaleString()} buys and 0 sells in ${noSells[0]} — possible honeypot or rigged market`);
  else if (!established && p24?.buyers >= H.minBuyers && p24.sellers != null && p24.sellers / p24.buyers < H.maxSellerRatio) add('no_sells', 'high', `${p24.buyers.toLocaleString()} wallets bought but only ${p24.sellers} sold in 24h (${((p24.sellers / p24.buyers) * 100).toFixed(2)}%) — possible honeypot or rigged market`);
  else if (!established && p24?.buyers >= 100 && p24.sellers != null && p24.sellers / p24.buyers < H.fewSellersRatio) add('few_sellers', 'med', `${p24.buyers} buyers vs ${p24.sellers} sellers in 24h — check that selling works`);
  if (t.change24h != null && t.change24h > R.pump.change24hPct) add('pump', 'med', `+${Math.round(t.change24h)}% in 24h`);

  // Jupiter organic data (Solana only)
  // Jupiter returns score 0 with no organic fields when it simply has no data on a token
  // (big tokens traded elsewhere, or tokens too new to be scored yet) — treat that as
  // unknown, not as fake, for established tokens and for tokens under 24h old.
  const ageDays = m.createdAt ? (Date.now() - Date.parse(m.createdAt)) / 864e5 : null;
  const hasOrganicData = m.organicBuyers24h != null; // no organic-buyer count = Jupiter didn't score it
  const tooNewToScore = ageDays != null && ageDays * 24 < R.organic.unscoredGraceHours;
  if (m.organicScore != null && m.organicScore < R.organic.minScore) {
    if (hasOrganicData || !(established || tooNewToScore)) add('inorganic', 'med', `Jupiter organic score ${m.organicScore.toFixed(0)}/100`);
    else if (established && (mc ?? 0) >= R.organic.knownCoinMinCapUsd) add('known_coin', 'info', `Known coin ($${fmt(mc)} market cap) — Jupiter doesn't score its organic activity`);
    else add('organic_unknown', 'med', tooNewToScore && !established ? `Too new for Jupiter to score yet (${ageDays < 1 / 24 ? Math.round(ageDays * 1440) + ' min' : Math.round(ageDays * 24) + 'h'} old)` : 'Jupiter has no organic-activity data for this token');
  }
  const B = R.botted;
  if (ageDays != null && ageDays < 1) {
    const traders = m.traders24h;
    if (traders >= B.newTokenMinTraders && m.organicBuyers24h != null && (m.organicBuyers24h / traders) * 100 < B.newTokenMaxRealBuyerPct
      && m.organicScore != null && m.organicScore < B.newTokenMaxOrganicScore) {
      add('botted', 'high', `Fake crowd (new token, ${Math.round(ageDays * 1440)} min old): only ${m.organicBuyers24h} of ${traders.toLocaleString()} traders are real buyers (${((m.organicBuyers24h / traders) * 100).toFixed(1)}%), Jupiter organic score ${Math.round(m.organicScore)}`);
    }
  } else if (m.holderChange24h != null && m.holderChange24h > B.holderGrowthPct && m.organicBuyers24h != null && m.organicBuyers24h < B.maxOrganicBuyers) {
    add('botted', 'high', `Fake crowd: holders +${Math.round(m.holderChange24h)}% in 24h but only ${m.organicBuyers24h} organic buyers`);
  }
  if (ageDays != null && ageDays < R.botted.maxAgeDays && m.organicVolumePct != null && m.organicVolumePct < R.botted.minOrganicVolumePct) {
    add('botted', 'high', `Young and inorganic: ${ageDays < 1 ? Math.round(ageDays * 24) + 'h' : ageDays.toFixed(1) + 'd'} old, only ${m.organicVolumePct.toFixed(2)}% of volume is organic`);
  }

  // Contract / holders
  if (m.mintAuthorityDisabled === false) add('mint_auth', 'high', 'Mint authority still enabled');
  if (m.freezeAuthorityDisabled === false) add('freeze_auth', 'high', 'Freeze authority still enabled');
  if (m.topHoldersPct != null && m.topHoldersPct > R.concentration.topHoldersPct && (mc ?? 0) < R.concentration.maxCapUsd) add('concentrated', 'med', `Top holders own ${m.topHoldersPct.toFixed(0)}%`);
  if (ageDays != null && ageDays * 1440 < R.newToken.minAgeMinutes) add('new', 'info', `New token: ${Math.max(1, Math.round(ageDays * 1440))} min old`);

  // Established token that looks like a major/stable but isn't in exclusions.json → hint only.
  // Tokens that merely share a major's ticker (e.g. a meme called BTC) are not flagged.
  const sym = String(t.symbol || '');
  if (looksMajor(sym) || looksStable(sym, t.priceUsd)) {
    if (established) add('add_to_exclusions', 'info', `Looks like a ${looksStable(sym, t.priceUsd) ? 'stablecoin' : 'major'} — add ${t.address} to config/exclusions.json?`);
  }
  // DexScreener promotion (tags only, no risk weight).
  if (m.dexBoosts > 0) add('dex_paid', 'info', `Paid DexScreener promotion: ${m.dexBoosts} active boosts`);
  if (m.dexTopRank) add('dex_trending', 'info', `#${m.dexTopRank} in DexScreener's top-30 boosted list`);

  // Main pool paired with something other than a major or stablecoin (e.g. SAI/SAC, ONE/OLY).
  // A tag only: liquidity priced in a token the creator may control can be inflated.
  const pair = m.pool?.pairedWith || t.pairedWith;
  if (pair?.address && exclusions && !isMajorOrStable(exclusions, t.chain, pair.address)) {
    add('non_stable_pair', 'info', `Main pool is paired with ${pair.symbol || pair.address} — not a major or stablecoin, so its liquidity value may be inflated`);
  }
  return f;
}

// The pair side counts as solid if it's a known major/stablecoin (exclusions.json) or a chain's
// native-coin placeholder (0x000…0 / 0xeee…e).
function isMajorOrStable(exclusions, chain, address) {
  if (/^0x0{40}$|^0xe{40}$/i.test(address)) return true;
  return exclusions.has(norm(chain, address));
}

// ---------------------------------------------------------------- ranking
// Combined "Suzi Trending" list. Red (high) tokens are never ranked. Everything else gets
// points from the parts below; all weights are here so we can tune them together.

const RANKING = {
  // Position on each source list: #1 gets the full points, the last token gets ~0.
  // Jupiter is Solana-only, so it gets less weight to keep the list from tilting to Solana.
  listPosition: { jupiter: 40, coingecko: 30, birdeye: 30 },
  // Adjustment by number of lists. Negative: list positions are added up, so a token on
  // several lists already collects points from each; this damps that double reward.
  listCount: { 2: -10, 3: -15 },
  // DexScreener tags.
  dexTrending: 10, // in DexScreener's top-30 boosted list
  dexPaid: 5, // has paid boosts
  // 5-minute activity (the trending window).
  volume5m: { maxPoints: 0, zeroAtUsd: 1_000, fullAtUsd: 100_000 }, // no weight (was log scale up to +20)
  // 24h price change: penalty only when down — −5 for any drop, then −0.5 per %, capped at
  // −15 (−20% or worse). Going up adds nothing: rising tokens already rank high on the lists.
  change24h: { basePoints: -5, pointsPerPct: 0.5, maxPoints: 0, minPoints: -15 },
  // 5m price change: small nudge either way — 0.5 points per %, capped at ±3 (±6%).
  change5m: { pointsPerPct: 0.5, maxPoints: 3 },
  // Yellow flags: points subtracted per flag.
  yellow: {
    thin_liq: -5, mcap_vs_liq: -5, high_turnover: -8, bot_trading_large_cap: 0, bot_trading_small_cap: -5, few_sellers: -5,
    concentrated: -5, organic_unknown: 0, inorganic: -5, pump: -5,
  },
  yellowDefault: -5, // any yellow flag not listed above
  // Blue tags.
  // new: under 1h old and it passed every red check to make a list — a positive signal.
  info: { known_coin: 5, new: 5 },
  // Per-chain adjustment, added once per token.
  chain: { bsc: -10 },
  // Tags that answer the same question. When a token's rows disagree (e.g. one source says
  // small cap, another large cap), only the first (stricter) tag in the group counts.
  exclusiveGroups: [
    ['bot_trading_small_cap', 'bot_trading_large_cap'],
    ['organic_unknown', 'known_coin'],
    ['mcap_vs_liq', 'thin_liq'], // both mean: liquidity is small compared with market cap
  ], // non_stable_pair has no weight: pairing with a non-major can be fine
};

// entry = { chain, lists: [{ source, rank, size }], flags: [...], dexTopRank, dexBoosts, volume5mUsd, change5m, change24h }
function scoreToken(e) {
  const R = RANKING;
  const parts = [];
  const add = (label, points) => { if (points) parts.push({ label, points: Math.round(points * 10) / 10 }); };

  // List position: points from every list the token is on, added up.
  for (const l of e.lists) {
    const max = R.listPosition[l.source] || 0;
    add(`#${l.rank} of ${l.size} on ${l.source}`, max * (1 - (l.rank - 1) / Math.max(1, l.size)));
  }
  if (R.listCount[e.lists.length]) add(`On ${e.lists.length} lists`, R.listCount[e.lists.length]);
  if (e.dexTopRank) add(`DexScreener trending #${e.dexTopRank}`, R.dexTrending);
  if (e.dexBoosts > 0) add(`DexScreener paid (${e.dexBoosts} boosts)`, R.dexPaid);

  const v = e.volume5mUsd || 0;
  if (R.volume5m.maxPoints && v > R.volume5m.zeroAtUsd) {
    const frac = Math.log10(v / R.volume5m.zeroAtUsd) / Math.log10(R.volume5m.fullAtUsd / R.volume5m.zeroAtUsd);
    add(`5m volume $${fmt(v)}`, R.volume5m.maxPoints * Math.min(1, frac));
  }
  if (e.change5m != null) add(`5m price ${e.change5m >= 0 ? '+' : ''}${e.change5m.toFixed(1)}%`, Math.max(-R.change5m.maxPoints, Math.min(R.change5m.maxPoints, e.change5m * R.change5m.pointsPerPct)));
  if (e.change24h != null && e.change24h < 0) add(`24h price ${e.change24h >= 0 ? '+' : ''}${e.change24h.toFixed(1)}%`, Math.max(R.change24h.minPoints, R.change24h.basePoints + e.change24h * R.change24h.pointsPerPct));

  if (R.chain[e.chain]) add(`Chain: ${e.chain}`, R.chain[e.chain]);
  const ids = new Set(e.flags.map((f) => f.id));
  const dropped = new Set(R.exclusiveGroups.flatMap((g) => g.filter((id) => ids.has(id)).slice(1)));
  for (const f of e.flags) {
    if (dropped.has(f.id)) continue;
    if (f.severity === 'med') add(`Yellow: ${f.id}`, R.yellow[f.id] ?? R.yellowDefault);
    else if (f.severity === 'info' && R.info[f.id]) add(`Tag: ${f.id}`, R.info[f.id]);
  }
  const score = Math.round(parts.reduce((a, p) => a + p.points, 0) * 10) / 10;
  return { score, parts };
}

module.exports = { RULES, RANKING, loadExclusions, norm, flagsFor, scoreToken };
