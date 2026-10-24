// Checks every address in config/exclusions.json against DexScreener (and Jupiter for
// Solana) and reports whether it resolves to the symbol we wrote down.
// Usage: node scripts/verify-exclusions.js

const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'config', 'exclusions.json');
const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
const DS_CHAIN = { 'world-chain': 'worldchain' }; // our chain id → DexScreener chain id
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function dexscreener(chain, addrs) {
  const out = new Map();
  for (let i = 0; i < addrs.length; i += 30) {
    const chunk = addrs.slice(i, i + 30);
    const res = await fetch(`https://api.dexscreener.com/tokens/v1/${DS_CHAIN[chain] || chain}/${chunk.join(',')}`);
    const rows = res.ok ? await res.json() : [];
    for (const p of rows) {
      for (const side of [p.baseToken, p.quoteToken]) {
        if (!side) continue;
        const k = chain === 'solana' ? side.address : side.address.toLowerCase();
        if (!out.has(k)) out.set(k, side.symbol);
      }
    }
    await sleep(300);
  }
  return out;
}

async function jupiter(addrs) {
  const out = new Map();
  for (let i = 0; i < addrs.length; i += 50) {
    const res = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${addrs.slice(i, i + 50).join(',')}`);
    const rows = res.ok ? await res.json() : [];
    for (const t of rows) out.set(t.id, t.symbol);
    await sleep(1200);
  }
  return out;
}

(async () => {
  let ok = 0, bad = 0;
  for (const [list, entries] of Object.entries(cfg)) {
    if (!Array.isArray(entries)) continue;
    const byChain = {};
    for (const e of entries) (byChain[e.chain] ||= []).push(e);
    for (const [chain, es] of Object.entries(byChain)) {
      const addrs = es.map((e) => (chain === 'solana' ? e.address : e.address.toLowerCase()));
      const found = await dexscreener(chain, addrs);
      if (chain === 'solana') {
        const missing = addrs.filter((a) => !found.has(a));
        if (missing.length) for (const [k, v] of await jupiter(missing)) found.set(k, v);
      }
      for (const e of es) {
        const k = chain === 'solana' ? e.address : e.address.toLowerCase();
        const got = found.get(k);
        const match = got && got.toUpperCase().replace(/^\$/, '') === e.symbol.toUpperCase();
        if (match) ok++; else bad++;
        const mark = match ? 'ok ' : got ? 'DIFF' : 'MISS';
        if (!match || process.argv.includes('--all')) console.log(`${mark} ${list.padEnd(11)} ${chain.padEnd(11)} ${e.symbol.padEnd(9)} → ${got || 'not found'}  ${e.address}`);
      }
    }
  }
  console.log(`\n${ok} match, ${bad} need a look (DIFF = resolves to a different symbol, MISS = no pools found)`);
})();
