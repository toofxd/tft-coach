#!/usr/bin/env node
// Scrapes item stats from tactics.tools and saves to data/processed/tactics_tools_items.json
// Run: node src/scrape_tactics_tools.js

const https = require("https");
const fs = require("fs");
const path = require("path");

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: new URL(url).hostname,
      path: new URL(url).pathname + new URL(url).search,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
    };
    https.get(options, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return resolve(httpsGet(res.headers.location));
      }
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(data));
    }).on("error", reject);
  });
}

function extractNextData(html) {
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) throw new Error("__NEXT_DATA__ not found in page");
  return JSON.parse(match[1]);
}

async function scrape() {
  console.log("Fetching tactics.tools/items...");
  const html = await httpsGet("https://tactics.tools/items");

  const nextData = extractNextData(html);
  const { totalEntries, lastUpdated, items } = nextData.props.pageProps.statsData;

  const craftable = Object.values(items)
    .filter((item) => {
      const id = item.itemId;
      return (
        !id.match(/^[0-9]/) &&
        !id.includes("Artifact") &&
        !id.includes("EmblemItem") &&
        !id.includes("PsyOps") &&
        !id.includes("AnimaSquad") &&
        !id.includes("Ornn") &&
        !id.includes("Offering") &&
        !id.includes("Radiant") &&
        !id.includes("Trait") &&
        !id.includes("DRX") &&
        !id.includes("TFT17_") &&
        !id.includes("17") &&
        item.count > 1000
      );
    })
    .map((item) => ({
      itemId: item.itemId,
      count: item.count,
      playRate: parseFloat((item.count / totalEntries * 100).toFixed(2)),
      avgPlacement: item.place,
      top4: item.top4,
      winRate: item.won,
      // topUsers sorted by most negative delta (lower placement = better in TFT)
      topUsers: item.topUsers
        .sort((a, b) => a[1] - b[1])
        .slice(0, 8)
        .map(([unitId, delta]) => ({ unitId, delta: parseFloat(delta.toFixed(4)) })),
    }))
    .sort((a, b) => b.top4 - a.top4);

  const out = { lastUpdated, totalEntries, scrapedAt: Date.now(), items: craftable };

  const outPath = path.join(__dirname, "..", "data", "processed", "tactics_tools_items.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

  console.log(`Saved ${craftable.length} items to ${outPath}`);
  console.log(`Total entries: ${totalEntries.toLocaleString()}, last updated: ${new Date(lastUpdated * 1000).toISOString()}`);
}

scrape().catch((e) => { console.error(e); process.exit(1); });
