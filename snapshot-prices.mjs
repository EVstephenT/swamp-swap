// Swamp Swap floor-price snapshot.
// Runs on GitHub Actions (Node 20+). Looks up the cheapest OpenSea listing for every card number and
// finish in Mudwater: Swamp Origins and writes prices.json next to index.html.
// Needs the OpenSea API key in the OPENSEA_API_KEY environment variable (a repository secret).

import { writeFile, readFile } from "node:fs/promises";

const API = "https://api.opensea.io/api/v2";
const SLUG = "mudwater-cards";
const CARDS = 120;
const CONCURRENCY = 3;
const OUT = process.argv[2] || "prices.json";
const KEY = process.env.OPENSEA_API_KEY;
if (!KEY) { console.error("OPENSEA_API_KEY is not set."); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function os(path) {
  for (let attempt = 0; attempt < 6; attempt++) {
    let res;
    try { res = await fetch(API + path, { headers: { "x-api-key": KEY, accept: "application/json" } }); }
    catch (e) { await sleep(1000 * (attempt + 1)); continue; }
    if (res.ok) return res.json();
    if (res.status === 429 || res.status >= 500) { await sleep(1500 * (attempt + 1)); continue; }
    throw new Error(`${res.status} on ${path}`);
  }
  throw new Error(`Gave up on ${path}`);
}

// Finish values come from OpenSea, so new finishes (e.g. Cracked Ice) are picked up automatically.
const traits = await os(`/traits/${SLUG}`);
const finishes = Object.keys((traits.counts || {}).Finish || {});
if (!finishes.includes("Base")) { console.error("Unexpected traits response; Finish values:", finishes); process.exit(1); }

const jobs = [];
for (let n = 1; n <= CARDS; n++) for (const f of finishes) jobs.push([n, f]);

const prices = {};
let failed = 0, listed = 0;
const started = Date.now();
async function worker() {
  while (jobs.length) {
    const [n, f] = jobs.shift();
    const traitsParam = encodeURIComponent(JSON.stringify([{ traitType: "Card Number", value: String(n) }, { traitType: "Finish", value: f }]));
    try {
      const j = await os(`/listings/collection/${SLUG}/best?limit=1&traits=${traitsParam}`);
      const l = j.listings && j.listings[0];
      const cur = l && l.price && l.price.current;
      prices[`${n}|${f}`] = cur ? Number(cur.value) / Math.pow(10, cur.decimals ?? 9) : null;
      if (cur) listed++;
    } catch (e) { failed++; console.error(`#${n} ${f}: ${e.message}`); }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const total = CARDS * finishes.length;
console.log(`Looked up ${total} card/finish combos in ${Math.round((Date.now() - started) / 1000)}s: ${listed} listed, ${total - listed - failed} with no listing, ${failed} failed.`);

// Don't publish a half-empty snapshot: if more than 5% of lookups failed, keep the previous file.
if (failed > total * 0.05) { console.error("Too many failed lookups; keeping the previous prices.json."); process.exit(1); }

// Carry forward the last known value for any lookup that failed this time.
if (failed) {
  try { const prev = JSON.parse(await readFile(OUT, "utf8")).prices || {}; for (const k of Object.keys(prev)) if (!(k in prices)) prices[k] = prev[k]; } catch {}
}

const sorted = Object.fromEntries(Object.entries(prices).sort(([a], [b]) => parseInt(a) - parseInt(b) || a.localeCompare(b)));
await writeFile(OUT, JSON.stringify({ updated: new Date().toISOString(), currency: "SOL", source: "OpenSea best listing per Card Number + Finish", finishes, prices: sorted }, null, 1) + "\n");
console.log(`Wrote ${OUT}.`);
