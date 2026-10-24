// Trending Lab — polls trending lists from Jupiter, CoinGecko (onchain), Birdeye and
// DexScreener every minute, normalizes them, flags likely spam, saves snapshots, and
// serves a small dashboard. Zero dependencies (Node 18+).

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const { RANKING, loadExclusions, norm, flagsFor, scoreToken } = require('./rules');
loadEnv(path.join(ROOT, '.env'));

const PORT = Number(process.env.PORT || 4321);
// 0 = manual only: poll once at startup, then only when "Poll fresh" is clicked.
const POLL_MS = Number(process.env.POLL_SECONDS || 0) * 1000;
// Trending window, applied to every source that supports one. 5m is the shortest all of
// Jupiter, CoinGecko and Birdeye (selective mode) accept. DexScreener has no window.
const WINDOW = process.env.TRENDING_WINDOW || '5m'; // 5m | 1h | 6h | 24h
// Birdeye: 5m/30m only in "selective" mode; 1h/4h/24h in "classic". No 6h → use 4h.
const BIRDEYE_WINDOW = { '5m': '5m', '1h': '1h', '6h': '4h', '24h': '24h' }[WINDOW] || '5m';
const BIRDEYE_MODE = ['5m', '30m'].includes(BIRDEYE_WINDOW) ? 'selective' : 'classic';
const BIRDEYE_CHAINS = (process.env.BIRDEYE_CHAINS || 'solana,ethereum,base,bsc,arbitrum')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const CG_WINDOW = { '5m': 'm5', '1h': 'h1', '6h': 'h6', '24h': 'h24' }[WINDOW];
// How much of each list to pull. Jupiter caps at 100; CoinGecko gives 20 pools/page (10
// pages on Pro without Analyst); Birdeye returns up to 50 per call and we page to the end.
const JUP_LIMIT = Number(process.env.JUPITER_LIMIT || 100);
const CG_PAGES = Number(process.env.COINGECKO_PAGES || 3); // pages 4–5 (ranks 61–100) put 0 tokens in the top 50
const BIRDEYE_MAX_PER_CHAIN = Number(process.env.BIRDEYE_MAX_PER_CHAIN || 50); // 1 page per chain
const SNAP_DIR = path.join(ROOT, 'data', 'snapshots');

// ---------------------------------------------------------------- env

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// ---------------------------------------------------------------- helpers

const num = (v) => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const sum = (...vs) => (vs.every((v) => num(v) === null) ? null : vs.reduce((a, v) => a + (num(v) || 0), 0));

// API calls made during the current poll, per provider — shown in the UI so we can watch cost.
let callCounts = {};
const PROVIDER = [['jup.ag', 'jupiter'], ['coingecko.com', 'coingecko'], ['geckoterminal.com', 'coingecko'], ['birdeye.so', 'birdeye'], ['dexscreener.com', 'dexscreener']];

async function getJson(url, headers = {}, timeoutMs = 15000) {
  const provider = (PROVIDER.find(([host]) => url.includes(host)) || [, 'other'])[1];
  callCounts[provider] = (callCounts[provider] || 0) + 1;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url.split('?')[0]} — ${text.slice(0, 160)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(t);
  }
}

// Map provider chain ids onto one vocabulary.
const CHAIN_ALIASES = {
  eth: 'ethereum', ethereum: 'ethereum', bsc: 'bsc', bnb: 'bsc', base: 'base', solana: 'solana',
  arbitrum: 'arbitrum', polygon_pos: 'polygon', polygon: 'polygon', avax: 'avalanche',
  avalanche: 'avalanche', optimism: 'optimism', sui: 'sui', 'sui-network': 'sui', ton: 'ton',
  tron: 'tron', hyperevm: 'hyperevm', robinhood: 'robinhood', monad: 'monad',
};
const chainOf = (c) => CHAIN_ALIASES[String(c || '').toLowerCase()] || String(c || 'unknown').toLowerCase();
const keyOf = (chain, address) => `${chain}:${chain === 'solana' || chain === 'sui' || chain === 'ton' || chain === 'tron' ? address : String(address).toLowerCase()}`;

function token(base) {
  // One normalized shape for every source. Missing values stay null.
  const t = {
    key: keyOf(base.chain, base.address),
    rank: null, chain: null, address: null, symbol: null, name: null, icon: null,
    priceUsd: null, marketCapUsd: null, fdvUsd: null, liquidityUsd: null,
    volume24hUsd: null, volume1hUsd: null, volume5mUsd: null, change5m: null, change1h: null, change24h: null,
    txns5m: null, windowVolumeUsd: null, windowChange: null,
    txns24h: null, buys24h: null, sells24h: null, traders24h: null,
    holders: null, createdAt: null, organicScore: null, verified: null,
    mintAuthorityDisabled: null, freezeAuthorityDisabled: null, topHoldersPct: null,
    boostAmount: null, url: null, why: '',
    ...base,
    // Some sources (CoinGecko) report an unknown market cap as 0 — treat it as missing so
    // FDV is used instead.
    marketCapUsd: base.marketCapUsd || null,
  };
  // Self-check, using only this row's own data: market cap can't exceed FDV (circulating ≤
  // total supply). When it does (CoinGecko: IRYS $154M cap vs $4.8M FDV), use the FDV.
  if (t.marketCapUsd && t.fdvUsd && t.marketCapUsd > t.fdvUsd * 1.01) {
    t.mcapReported = t.marketCapUsd;
    t.marketCapUsd = t.fdvUsd;
  }
  return t;
}

// Fields only Jupiter has (Solana): organic activity, holders, audit. Used for Jupiter's own
// list and to enrich Solana tokens that came from the other sources.
function jupiterExtras(t) {
  const s24 = t.stats24h || {}, audit = t.audit || {};
  const vol = sum(s24.buyVolume, s24.sellVolume);
  const organicVol = sum(s24.buyOrganicVolume, s24.sellOrganicVolume);
  return {
    liquidityUsd: num(t.liquidity), volume24hUsd: vol,
    txns24h: sum(s24.numBuys, s24.numSells), traders24h: num(s24.numTraders),
    buys24h: num(s24.numBuys), sells24h: num(s24.numSells), jupChange24h: num(s24.priceChange),
    holders: num(t.holderCount), holderChange24h: num(s24.holderChange),
    organicScore: num(t.organicScore), organicBuyers24h: num(s24.numOrganicBuyers),
    organicVolumePct: vol && organicVol !== null ? (organicVol / vol) * 100 : null, // null = Jupiter has no data
    verified: t.isVerified ?? null, jupTags: t.tags || [],
    createdAt: (t.firstPool && t.firstPool.createdAt) || null,
    mintAuthorityDisabled: audit.mintAuthorityDisabled ?? null,
    freezeAuthorityDisabled: audit.freezeAuthorityDisabled ?? null,
    topHoldersPct: num(audit.topHoldersPercentage),
  };
}

// CoinGecko onchain base + auth (Pro → Demo → keyless GeckoTerminal).
function cgBase() {
  const pro = process.env.COINGECKO_PRO_API_KEY;
  const demo = process.env.COINGECKO_DEMO_API_KEY || process.env.COINGECKO_API_KEY;
  if (pro) return ['https://pro-api.coingecko.com/api/v3/onchain', { 'x-cg-pro-api-key': pro }];
  if (demo) return ['https://api.coingecko.com/api/v3/onchain', { 'x-cg-demo-api-key': demo }];
  return ['https://api.geckoterminal.com/api/v2', {}];
}
// Buys/sells/buyers/sellers of a token's main pool, from the token's side. GeckoTerminal
// counts them for the pool's *base* token, so swap them when our token is the quote.
function poolActivity(pool, tokenId) {
  const a = pool.attributes || {};
  const isBase = pool.relationships?.base_token?.data?.id === tokenId;
  const side = (w) => {
    const x = a.transactions?.[w] || {};
    return isBase
      ? { buys: num(x.buys), sells: num(x.sells), buyers: num(x.buyers), sellers: num(x.sellers) }
      : { buys: num(x.sells), sells: num(x.buys), buyers: num(x.sellers), sellers: num(x.buyers) };
  };
  const other = (isBase ? pool.relationships?.quote_token : pool.relationships?.base_token)?.data?.id || '';
  const names = String(a.name || '').split(' / ');
  const pc = num(a.price_change_percentage?.h24);
  return {
    address: a.address, name: a.name, h24: side('h24'), h1: side('h1'),
    volume24hUsd: num(a.volume_usd?.h24), createdAt: a.pool_created_at || null,
    // Price change of the pool's base token; flip it when our token is the quote.
    change24h: pc == null ? null : isBase ? pc : (1 / (1 + pc / 100) - 1) * 100,
    pairedWith: { address: other.slice(other.indexOf('_') + 1), symbol: (isBase ? names[1] : names[0])?.split(' ')[0] || null },
  };
}
// Fill only the fields this row is missing from the token's other rows (source order:
// Jupiter, CoinGecko, Birdeye). Values the row already has are never replaced, so when
// sources disagree each row is judged on its own data.
function fillMissing(row, rows) {
  const out = { ...row };
  for (const r of rows) {
    if (r === row) continue;
    for (const [k, v] of Object.entries(r)) if (out[k] == null && v != null) out[k] = v;
  }
  return out;
}

// Our chain id → DexScreener chain id (where they differ).
const DEX_CHAIN = { 'world-chain': 'worldchain' };
// Our chain id → CoinGecko onchain network id.
const CG_NETWORK = { ethereum: 'eth', bsc: 'bsc', base: 'base', arbitrum: 'arbitrum', solana: 'solana', polygon: 'polygon_pos', avalanche: 'avax', optimism: 'optimism', 'world-chain': 'world-chain', robinhood: 'robinhood', ton: 'ton', hyperevm: 'hyperevm', monad: 'monad' };

const jupBase = () => (process.env.JUPITER_API_KEY ? 'https://api.jup.ag' : 'https://lite-api.jup.ag');
const jupHeaders = () => (process.env.JUPITER_API_KEY ? { 'x-api-key': process.env.JUPITER_API_KEY } : {});

// ---------------------------------------------------------------- sources

const sources = {
  jupiter: {
    label: 'Jupiter',
    note: `GET /tokens/v2/toptrending/${WINDOW}?limit=${JUP_LIMIT} · Solana only · ranked by Jupiter's trending model`,
    needsKey: 'JUPITER_API_KEY',
    async fetch() {
      const rows = await getJson(`${jupBase()}/tokens/v2/toptrending/${WINDOW}?limit=${JUP_LIMIT}`, jupHeaders());
      if (!Array.isArray(rows)) throw new Error('unexpected response');
      return rows.map((t, i) => {
        const s24 = t.stats24h || {}, s1 = t.stats1h || {}, s5 = t.stats5m || {};
        const sw = t[`stats${WINDOW}`] || {};
        return token({
          rank: i + 1, chain: 'solana', address: t.id, symbol: t.symbol, name: t.name, icon: t.icon,
          priceUsd: num(t.usdPrice), marketCapUsd: num(t.mcap), fdvUsd: num(t.fdv), liquidityUsd: num(t.liquidity),
          volume24hUsd: sum(s24.buyVolume, s24.sellVolume), volume1hUsd: sum(s1.buyVolume, s1.sellVolume),
          change1h: num(s1.priceChange), change24h: num(s24.priceChange),
          volume5mUsd: sum(s5.buyVolume, s5.sellVolume), change5m: num(s5.priceChange), txns5m: sum(s5.numBuys, s5.numSells),
          windowVolumeUsd: sum(sw.buyVolume, sw.sellVolume), windowChange: num(sw.priceChange),
          buys24h: num(s24.numBuys), sells24h: num(s24.numSells), txns24h: sum(s24.numBuys, s24.numSells),
          ...jupiterExtras(t), jup: jupiterExtras(t),
          url: `https://jup.ag/tokens/${t.id}`,
          why: `#${i + 1} on Jupiter ${WINDOW} trending · organic ${t.organicScoreLabel || '?'}${t.launchpad ? ` · ${t.launchpad}` : ''}`,
        });
      });
    },
  },

  coingecko: {
    label: 'CoinGecko',
    note: `GET /onchain/networks/trending_pools?duration=${WINDOW} (${CG_PAGES} pages × 20 pools) · all chains · GeckoTerminal engagement + volume/txns + pool safety`,
    needsKey: null,
    async fetch() {
      const pro = process.env.COINGECKO_PRO_API_KEY;
      const demo = process.env.COINGECKO_DEMO_API_KEY || process.env.COINGECKO_API_KEY;
      let base, headers;
      if (pro) [base, headers] = ['https://pro-api.coingecko.com/api/v3/onchain', { 'x-cg-pro-api-key': pro }];
      else if (demo) [base, headers] = ['https://api.coingecko.com/api/v3/onchain', { 'x-cg-demo-api-key': demo }];
      else [base, headers] = ['https://api.geckoterminal.com/api/v2', {}]; // keyless public tier
      const fetchPages = (b, h) => Promise.all(Array.from({ length: CG_PAGES }, (_, i) => i + 1).map((p) =>
        getJson(`${b}/networks/trending_pools?include=base_token&duration=${WINDOW}&page=${p}`, h)));
      let pages, warning = null;
      try {
        pages = await fetchPages(base, headers);
      } catch (e) {
        if (!/HTTP 40[13]/.test(e.message) || !Object.keys(headers).length) throw e;
        // Rejected key → keep the column alive on the keyless GeckoTerminal tier.
        warning = `CoinGecko key rejected (${e.message.match(/HTTP \d+/)[0]}) — using keyless GeckoTerminal`;
        pages = await fetchPages('https://api.geckoterminal.com/api/v2', {});
      }
      const out = [];
      const seen = new Set();
      for (const page of pages) {
        const included = new Map((page.included || []).map((x) => [x.id, x.attributes || {}]));
        for (const pool of page.data || []) {
          const a = pool.attributes || {};
          const [net] = String(pool.id).split('_');
          const baseRef = pool.relationships?.base_token?.data?.id || '';
          const address = baseRef.slice(baseRef.indexOf('_') + 1);
          const bt = included.get(baseRef) || {};
          const chain = chainOf(net);
          const t = token({
            chain, address, symbol: bt.symbol || String(a.name || '').split(' / ')[0], name: bt.name || a.name,
            icon: bt.image_url && bt.image_url !== 'missing.png' ? bt.image_url : null,
            priceUsd: num(a.base_token_price_usd), marketCapUsd: num(a.market_cap_usd), fdvUsd: num(a.fdv_usd),
            liquidityUsd: num(a.reserve_in_usd), volume24hUsd: num(a.volume_usd?.h24), volume1hUsd: num(a.volume_usd?.h1),
            change1h: num(a.price_change_percentage?.h1), change24h: num(a.price_change_percentage?.h24),
            volume5mUsd: num(a.volume_usd?.m5), change5m: num(a.price_change_percentage?.m5),
            txns5m: sum(a.transactions?.m5?.buys, a.transactions?.m5?.sells),
            windowVolumeUsd: num(a.volume_usd?.[CG_WINDOW]), windowChange: num(a.price_change_percentage?.[CG_WINDOW]),
            buys24h: num(a.transactions?.h24?.buys), sells24h: num(a.transactions?.h24?.sells),
            txns24h: sum(a.transactions?.h24?.buys, a.transactions?.h24?.sells),
            traders24h: sum(a.transactions?.h24?.buyers, a.transactions?.h24?.sellers),
            createdAt: a.pool_created_at || null,
            cgListed: bt.coingecko_coin_id ? true : null,
            url: `https://www.geckoterminal.com/${net}/pools/${a.address}`,
            pairedWith: (() => {
              const q = pool.relationships?.quote_token?.data?.id || '';
              return q ? { address: q.slice(q.indexOf('_') + 1), symbol: String(a.name || '').split(' / ')[1]?.split(' ')[0] || null } : null;
            })(),
            why: `Trending pool ${a.name} on ${net}`,
          });
          if (seen.has(t.key)) continue; // several pools of one token → keep the highest-ranked
          seen.add(t.key);
          t.rank = out.length + 1;
          out.push(t);
        }
      }
      if (warning) out.partialErrors = [warning];
      return out;
    },
  },

  birdeye: {
    label: 'Birdeye',
    note: `GET /defi/token_trending?interval=${BIRDEYE_WINDOW}&mode=${BIRDEYE_MODE} · one call per chain (${BIRDEYE_CHAINS.join(', ')}) · sorted by Birdeye rank`,
    needsKey: 'BIRDEYE_API_KEY',
    async fetch() {
      const key = process.env.BIRDEYE_API_KEY;
      if (!key) throw new Error('missing BIRDEYE_API_KEY');
      const results = await Promise.allSettled(BIRDEYE_CHAINS.map(async (chain) => {
        // Page through the chain's whole trending list (50 per call).
        const rows = [];
        for (let offset = 0; offset < BIRDEYE_MAX_PER_CHAIN; offset += 50) {
          const body = await getJson(
            `https://public-api.birdeye.so/defi/token_trending?sort_by=rank&sort_type=asc&offset=${offset}&limit=50&interval=${BIRDEYE_WINDOW}&mode=${BIRDEYE_MODE}`,
            { 'X-API-KEY': key, 'x-chain': chain });
          const page = body?.data?.tokens || [];
          rows.push(...page);
          if (page.length < 50 || rows.length >= (body?.data?.total ?? 0)) break;
        }
        return rows.map((t) => token({
          rank: num(t.rank), chainSize: rows.length, chain: chainOf(chain), address: t.address, symbol: t.symbol, name: t.name, icon: t.logoURI,
          priceUsd: num(t.price), marketCapUsd: num(t.marketcap), fdvUsd: num(t.fdv), liquidityUsd: num(t.liquidity),
          volume24hUsd: num(t.volume24hUSD), change24h: num(t.price24hChangePercent),
          volume5mUsd: num(t.volume5mUSD), change5m: num(t.price5mChangePercent),
          windowVolumeUsd: num(t[`volume${BIRDEYE_WINDOW}USD`]), windowChange: num(t[`price${BIRDEYE_WINDOW}ChangePercent`]),
          url: `https://birdeye.so/token/${t.address}?chain=${chain}`,
          why: `#${t.rank} trending on Birdeye ${chain}`,
        }));
      }));
      const failed = results.filter((r) => r.status === 'rejected');
      if (failed.length === results.length) throw failed[0].reason;
      // Interleave chains by their per-chain rank so the merged list isn't all Solana first.
      const all = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
      all.sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
      all.forEach((t, i) => { t.chainRank = t.rank; t.rank = i + 1; });
      all.partialErrors = failed.map((f) => String(f.reason?.message || f.reason));
      return all;
    },
  },

};

// ---------------------------------------------------------------- polling + history

const state = {
  startedAt: new Date().toISOString(),
  updatedAt: null,
  nextAt: null,
  polls: 0,
  sources: {}, // id -> { status, error, fetchedAt, ms, tokens: [...], excludedTokens: [...] }
  excluded: [], // tokens removed by config/exclusions.json this poll
};
// Per-token memory across polls: when first seen, how many polls on each list, best rank.
const history = new Map();

async function pollOnce() {
  const started = Date.now();
  const exclusions = loadExclusions(); // re-read each poll, so edits apply without a restart
  callCounts = {};

  // 1. Fetch every source in parallel. A failed source keeps its last good list.
  await Promise.all(Object.entries(sources).map(async ([id, src]) => {
    const t0 = Date.now();
    try {
      const tokens = await src.fetch();
      state.sources[id] = {
        status: tokens.partialErrors?.length ? 'partial' : 'ok',
        error: tokens.partialErrors?.join(' | ') || null,
        fetchedAt: new Date().toISOString(), ms: Date.now() - t0, tokens: [...tokens],
      };
    } catch (e) {
      const prev = state.sources[id];
      state.sources[id] = {
        status: src.needsKey && !process.env[src.needsKey] && id !== 'jupiter' ? 'missing_key' : 'error',
        error: String(e.message || e), fetchedAt: new Date().toISOString(), ms: Date.now() - t0,
        tokens: [...(prev?.tokens || []), ...(prev?.excludedTokens || [])],
      };
    }
  }));
  const live = Object.keys(sources).filter((id) => state.sources[id]).map((id) => [id, state.sources[id]]); // fixed order: Jupiter, CoinGecko, Birdeye

  // 2. Jupiter data (organic activity, holders, audit) for every Solana token on any list.
  const jup = new Map();
  for (const t of state.sources.jupiter?.tokens || []) if (t.jup) jup.set(t.address, t.jup);
  const missing = [...new Set(live.flatMap(([, s]) => s.tokens).filter((t) => t.chain === 'solana' && !jup.has(t.address)).map((t) => t.address))];
  for (let i = 0; i < missing.length; i += 50) {
    try {
      const rows = await getJson(`${jupBase()}/tokens/v2/search?query=${missing.slice(i, i + 50).join(',')}`, jupHeaders());
      for (const r of rows || []) jup.set(r.id, jupiterExtras(r));
    } catch (e) {
      console.log(`  jupiter enrichment failed: ${e.message}`);
    }
  }

  // 2b. CoinGecko token data for every token: is it a listed coin, and its liquidity across
  //     all pools (trending lists and Birdeye often report a single pool).
  const cg = new Map();
  const [cgUrl, cgHeaders] = cgBase();
  const byNet = {};
  for (const t of new Map(live.flatMap(([, s]) => s.tokens).map((t) => [t.key, t])).values()) {
    // Solana tokens Jupiter already covers (liquidity, verified, buys/sells/traders) are skipped.
    if (t.chain === 'solana' && jup.has(t.address)) continue;
    if (CG_NETWORK[t.chain]) (byNet[t.chain] ||= []).push(t.address);
  }
  await Promise.all(Object.entries(byNet).flatMap(([chain, addrs]) => {
    const chunks = [];
    for (let i = 0; i < addrs.length; i += 30) chunks.push(addrs.slice(i, i + 30));
    return chunks.map(async (chunk) => {
      try {
        // include=top_pools adds each token's main pool with buys/sells/buyers/sellers per
        // window — wallet-level activity for every chain at no extra calls.
        const body = await getJson(`${cgUrl}/networks/${CG_NETWORK[chain]}/tokens/multi/${chunk.join(',')}?include=top_pools`, cgHeaders);
        const pools = new Map((body.included || []).filter((x) => x.type === 'pool').map((x) => [x.id, x]));
        for (const d of body.data || []) {
          const a = d.attributes || {};
          const pool = pools.get(d.relationships?.top_pools?.data?.[0]?.id);
          cg.set(keyOf(chain, a.address), {
            cgListed: a.coingecko_coin_id ? true : null, cgCoinId: a.coingecko_coin_id || null,
            liquidityUsd: num(a.total_reserve_in_usd), pool: pool ? poolActivity(pool, d.id) : null,
          });
        }
      } catch (e) {
        console.log(`  coingecko enrichment failed (${chain}): ${e.message}`);
      }
    });
  }));

  // 2c. DexScreener: no longer a list. Two facts per token, as tags:
  //     - dex_trending: in DexScreener's top-30 boosted list (1 call, here)
  //     - dex_paid: has active boosts — looked up after flagging, only for tokens that
  //       will be shown (not red), 30 per call (step 4b)
  const dexTop = new Map(); // key → rank in top-30 boosted
  const dexBoosts = new Map(); // key → active boosts
  try {
    const top = await getJson('https://api.dexscreener.com/token-boosts/top/v1');
    for (const b of top || []) {
      const k = keyOf(chainOf(b.chainId), b.tokenAddress);
      if (!dexTop.has(k)) dexTop.set(k, dexTop.size + 1);
    }
  } catch (e) {
    console.log(`  dexscreener top boosts failed: ${e.message}`);
  }
  // 3. Merge each token across sources: best liquidity, earliest creation, verification.
  const merged = new Map();
  for (const [, s] of live) {
    for (const t of s.tokens) {
      const m = merged.get(t.key) || { liquidityUsd: null, volume24hUsd: null, createdAt: null, cgListed: null };
      m.dexTopRank = dexTop.get(t.key) || null;
      m.liquidityUsd = Math.max(m.liquidityUsd ?? 0, t.liquidityUsd ?? 0) || null;
      m.volume24hUsd = Math.max(m.volume24hUsd ?? 0, t.volume24hUsd ?? 0) || null;
      if (t.createdAt && (!m.createdAt || t.createdAt < m.createdAt)) m.createdAt = t.createdAt;
      if (t.cgListed) m.cgListed = true;
      (m.rows ||= []).push(t);
      merged.set(t.key, m);
    }
  }
  for (const [key, m] of merged) {
    const c = cg.get(key);
    if (c) {
      if (c.cgListed) m.cgListed = true;
      m.cgCoinId = c.cgCoinId;
      m.pool = c.pool;
      // Main pool's creation time gives other-chain tokens an age (Birdeye rows have none).
      if (c.pool?.createdAt && (!m.createdAt || c.pool.createdAt < m.createdAt)) m.createdAt = c.pool.createdAt;
      m.liquidityUsd = Math.max(m.liquidityUsd ?? 0, c.liquidityUsd ?? 0) || null;
    }
    const ex = key.startsWith('solana:') ? jup.get(key.slice(7)) : null;
    if (!ex) continue;
    const { liquidityUsd, volume24hUsd, createdAt, ...rest } = ex;
    Object.assign(m, rest);
    m.liquidityUsd = Math.max(m.liquidityUsd ?? 0, liquidityUsd ?? 0) || null;
    m.volume24hUsd = Math.max(m.volume24hUsd ?? 0, volume24hUsd ?? 0) || null;
    if (createdAt) m.createdAt = createdAt; // Jupiter's first-pool time is the token's real age
  }

  // 4. Drop excluded addresses (stablecoins, majors), flag the rest.
  state.excluded = [];
  const now = new Date().toISOString();
  for (const [id, s] of live) {
    const kept = [], dropped = [];
    for (const t of s.tokens) {
      delete t.jup;
      const ex = exclusions.get(norm(t.chain, t.address));
      if (ex) {
        dropped.push(t);
        state.excluded.push({ source: id, rank: t.rank, symbol: t.symbol, chain: t.chain, address: t.address, list: ex.list, listedAs: ex.symbol, note: ex.note || null });
        continue;
      }
      const m = merged.get(t.key);
      t.flags = flagsFor(fillMissing(t, m.rows), m, exclusions);
      t.m = { dexBoosts: m.dexBoosts, dexTopRank: m.dexTopRank, pool: m.pool || null, liquidityUsd: m.liquidityUsd, cgListed: m.cgListed, cgCoinId: m.cgCoinId ?? null, verified: m.verified ?? null, organicScore: m.organicScore ?? null,
        organicVolumePct: m.organicVolumePct ?? null, organicBuyers24h: m.organicBuyers24h ?? null, holderChange24h: m.holderChange24h ?? null,
        holders: m.holders ?? null, createdAt: m.createdAt };
      const h = history.get(t.key) || { firstSeen: now, polls: {}, bestRank: {} };
      if (s.status !== 'error' && s.status !== 'missing_key') h.polls[id] = (h.polls[id] || 0) + 1;
      h.bestRank[id] = Math.min(h.bestRank[id] ?? Infinity, t.rank ?? Infinity);
      h.lastSeen = now;
      history.set(t.key, h);
      kept.push(t);
    }
    s.tokens = kept;
    s.excludedTokens = dropped;
  }

  // 4b. DexScreener boosts, only for tokens that will be shown (no red row). Red tokens are
  //     hidden anyway, so checking them would waste calls.
  const shown = new Map();
  for (const [key, m] of merged) {
    if (m.rows.every((t) => t.flags && !t.flags.some((f) => f.severity === 'high')) && m.rows.some((t) => t.flags)) shown.set(key, m.rows[0]);
  }
  const byDexChain = {};
  for (const t of shown.values()) (byDexChain[DEX_CHAIN[t.chain] || t.chain] ||= []).push(t);
  await Promise.all(Object.entries(byDexChain).flatMap(([dexChain, toks]) => {
    const chunks = [];
    for (let i = 0; i < toks.length; i += 30) chunks.push(toks.slice(i, i + 30));
    return chunks.map(async (chunk) => {
      try {
        const pairs = await getJson(`https://api.dexscreener.com/tokens/v1/${dexChain}/${chunk.map((t) => t.address).join(',')}`);
        for (const p of pairs || []) {
          const k = keyOf(chunk[0].chain, p.baseToken?.address);
          const active = p.boosts?.active || 0;
          if (active > (dexBoosts.get(k) || 0)) dexBoosts.set(k, active);
        }
      } catch (e) {
        console.log(`  dexscreener lookup failed (${dexChain}): ${e.message}`);
      }
    });
  }));

  for (const [key, boosts] of dexBoosts) {
    const m = merged.get(key);
    if (!m || !boosts) continue;
    m.dexBoosts = boosts;
    for (const t of m.rows) {
      t.m.dexBoosts = boosts;
      t.flags.push({ id: 'dex_paid', severity: 'info', reason: `Paid DexScreener promotion: ${boosts} active boosts` });
    }
  }

  // 5. Cross-source overlap: which lists each token is on right now.
  const onLists = new Map();
  for (const [id, s] of live) {
    if (s.status === 'error' || s.status === 'missing_key') continue;
    for (const t of s.tokens) (onLists.get(t.key) || onLists.set(t.key, []).get(t.key)).push(id);
  }
  for (const [, s] of live) {
    for (const t of s.tokens) {
      t.onLists = onLists.get(t.key) || [];
      const h = history.get(t.key);
      t.firstSeen = h?.firstSeen || null;
      t.pollsSeen = h?.polls || {};
    }
  }

  // 6. Combined "Suzi Trending" ranking. A token is hidden if any of its rows is red.
  const groups = new Map();
  for (const [id, s] of live) {
    if (s.status === 'error' || s.status === 'missing_key') continue;
    const size = s.tokens.length + (s.excludedTokens?.length || 0); // original list length
    for (const t of s.tokens) (groups.get(t.key) || groups.set(t.key, []).get(t.key)).push({ id, t, size });
  }
  state.ranked = [];
  state.rankedHidden = 0;
  for (const [key, rows] of groups) {
    if (rows.some(({ t }) => t.flags.some((f) => f.severity === 'high'))) { state.rankedHidden++; continue; }
    const rep = fillMissing(rows[0].t, rows.map((r) => r.t)); // first source's row, gaps filled
    const flags = [...new Map(rows.flatMap(({ t }) => t.flags).map((f) => [f.id, f])).values()];
    // Same question answered differently by different rows → keep only the stricter tag.
    const ids = new Set(flags.map((f) => f.id));
    const dropIds = new Set(RANKING.exclusiveGroups.flatMap((g) => g.filter((id) => ids.has(id)).slice(1)));
    for (let i = flags.length - 1; i >= 0; i--) if (dropIds.has(flags[i].id)) flags.splice(i, 1);
    const m = merged.get(key);
    const { score, parts } = scoreToken({
      chain: rep.chain,
      lists: rows.map(({ id, t, size }) => ({ source: id, rank: t.rank, size })),
      flags, dexTopRank: m.dexTopRank, dexBoosts: m.dexBoosts,
      volume5mUsd: rep.volume5mUsd ?? rep.windowVolumeUsd, change5m: rep.change5m ?? rep.windowChange,
      change24h: rep.change24h ?? m.jupChange24h ?? m.pool?.change24h ?? null,
    });
    state.ranked.push({
      key, src: rows[0].id, symbol: rep.symbol, name: rep.name, chain: rep.chain, address: rep.address, icon: rep.icon,
      priceUsd: rep.priceUsd, marketCapUsd: rep.marketCapUsd, fdvUsd: rep.fdvUsd, liquidityUsd: m.liquidityUsd,
      volume5mUsd: rep.volume5mUsd ?? rep.windowVolumeUsd, change5m: rep.change5m ?? rep.windowChange,
      change24h: rep.change24h ?? m.jupChange24h ?? m.pool?.change24h ?? null,
      ranks: Object.fromEntries(rows.map(({ id, t }) => [id, t.rank])), flags, score, parts,
    });
  }
  state.ranked.sort((a, b) => b.score - a.score);
  state.ranked.forEach((r, i) => { r.rank = i + 1; });

  state.polls += 1;
  state.calls = { ...callCounts, total: Object.values(callCounts).reduce((a, n) => a + n, 0) };
  state.updatedAt = new Date().toISOString();
  state.nextAt = POLL_MS ? new Date(started + POLL_MS).toISOString() : null;
  saveSnapshot();
  const summary = live.map(([id, s]) => `${id}:${s.status}(${s.tokens.length}${s.excludedTokens.length ? `, -${s.excludedTokens.length} excl` : ''})`).join(' ');
  console.log(`[${state.updatedAt}] poll #${state.polls} ${summary} · jupiter-enriched ${jup.size} · coingecko-enriched ${cg.size} · calls ${JSON.stringify(state.calls)}`);
}

function saveSnapshot() {
  const d = new Date(state.updatedAt);
  const dir = path.join(SNAP_DIR, d.toISOString().slice(0, 10));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, d.toISOString().slice(11, 19).replace(/:/g, '') + '.json');
  fs.writeFile(file, JSON.stringify({ at: state.updatedAt, sources: state.sources, excluded: state.excluded, ranked: state.ranked }), () => {});
}

// ---------------------------------------------------------------- http

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/state')) {
    const meta = Object.fromEntries(Object.entries(sources).map(([id, s]) => [id, { label: s.label, note: s.note }]));
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ ...state, pollSeconds: POLL_MS / 1000, window: WINDOW, meta }));
  }
  if (req.url === '/api/refresh' && req.method === 'POST') {
    pollOnce().then(() => { res.writeHead(204); res.end(); });
    return;
  }
  const file = path.join(ROOT, 'public', req.url === '/' ? 'index.html' : path.normalize(req.url).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(path.join(ROOT, 'public')) || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
  const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(file)] || 'text/plain';
  res.writeHead(200, { 'content-type': type + '; charset=utf-8' });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, () => {
  console.log(`Trending Lab → http://localhost:${PORT}  (${POLL_MS ? `polling every ${POLL_MS / 1000}s` : 'manual polling'})`);
  for (const [id, s] of Object.entries(sources)) {
    if (s.needsKey && !process.env[s.needsKey]) console.log(`  ! ${id}: ${s.needsKey} not set${id === 'jupiter' ? ' — trying keyless lite-api' : ''}`);
  }
  pollOnce();
  if (POLL_MS) setInterval(pollOnce, POLL_MS);
});
