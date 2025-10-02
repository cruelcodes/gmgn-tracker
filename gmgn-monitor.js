/**
 * gmgn_monitor_pump_completed.js
 *
 * Usage:
 *  npm i puppeteer-extra puppeteer-extra-plugin-stealth puppeteer axios dotenv
 *  # first run: open visible browser so you can solve CF if prompted
 *  HEADLESS=false WEBHOOK_URLS_PUMP="https://discord/..." WEBHOOK_URLS_MIGRATED="https://discord/..." node gmgn_monitor_pump_completed.js
 *
 * Env:
 *  HEADLESS=true|false  (default false recommended for first run)
 *  POLL_INTERVAL (seconds, default 12)
 *  DEBUG=true
 *  WEBHOOK_URLS_PUMP (comma-separated)
 *  WEBHOOK_URLS_MIGRATED (comma-separated)
 *  WEBHOOK_URLS_TEST (optional)
 *  CHROME_EXECUTABLE_PATH (optional)
 */

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const axios = require("axios");
const fs = require("fs");
require("dotenv").config();

puppeteer.use(StealthPlugin());

const OUT_DIR = "./output";
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR);

const LAST_DATA = `${OUT_DIR}/gmgn_tokens_last.json`;
const NOTIFIED = `${OUT_DIR}/gmgn_notified_pump_completed.json`;
const SESSION_DIR = "./session";

const ENDPOINT =
  "https://gmgn.ai/vas/api/v1/rank/bsc?device_id=c726abfb-282c-4e13-9989-38e32421c8ff&fp_did=c353531e72967c0e225fbcfb70630c7c&client_id=gmgn_web_20251001-4892-0e84618&from_app=gmgn&app_ver=20251001-4892-0e84618&tz_name=Asia%2FCalcutta&tz_offset=19800&app_lang=en-US&os=web";

// exact payload you provided
const POST_BODY = {
  new_creation: {
    filters: [],
    launchpad_platform: ["fourmeme", "flap"],
    quote_address_type: [6, 7, 1, 8, 9, 10, 2],
    limit: 80,
    launchpad_platform_v2: true,
  },
  near_completion: {
    filters: [],
    launchpad_platform: ["fourmeme", "flap"],
    quote_address_type: [6, 7, 1, 8, 9, 10, 2],
    limit: 80,
    launchpad_platform_v2: true,
  },
  completed: {
    filters: [],
    launchpad_platform: ["fourmeme", "flap"],
    quote_address_type: [6, 7, 1, 8, 9, 10, 2],
    limit: 60,
    launchpad_platform_v2: true,
  },
};

const DEBUG = process.env.DEBUG === "true";
const POLL_INTERVAL = (parseInt(process.env.POLL_INTERVAL || "12", 10)) * 1000;
const HEADLESS = process.env.HEADLESS === "true";
const WEBHOOK_URLS_PUMP = (process.env.WEBHOOK_URLS_PUMP || "").split(",").map(s=>s.trim()).filter(Boolean);
const WEBHOOK_URLS_MIGRATED = (process.env.WEBHOOK_URLS_MIGRATED || "").split(",").map(s=>s.trim()).filter(Boolean);
const WEBHOOK_URLS_TEST = (process.env.WEBHOOK_URLS_TEST || "").split(",").map(s=>s.trim()).filter(Boolean);

function debugLog(...args){ if (DEBUG) console.log("[DEBUG]", ...args); }
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
function now(){ return new Date().toLocaleTimeString(); }

// load notified map (structure: { "<id>": { pump: true/false, migrated: true/false } })
let notified = {};
if (fs.existsSync(NOTIFIED)) {
  try { notified = JSON.parse(fs.readFileSync(NOTIFIED, "utf8")); } catch(e){ notified = {}; console.error("Failed to parse notified file:", e.message); }
}

// helper: persist notified
function saveNotified(){ fs.writeFileSync(NOTIFIED, JSON.stringify(notified, null, 2)); }

// cookies to header
function cookiesToHeader(cookies){ return cookies.map(c => `${c.name}=${c.value}`).join("; "); }

// simple webhook sender (discord style)
async function sendDiscordWebhook(urls = [], content, embeds = []) {
  if (!urls || !urls.length) return;
  for (const url of urls) {
    try {
      await axios.post(url, { content, embeds });
    } catch (err) {
      console.error("Webhook failed:", err.message);
    }
  }
}

// choose buy/sell count from available fields
function chooseCount(obj, prefix) {
  // prefix: "buys" or "sells"
  // prefer minute count then hour count
  const m = obj[`${prefix}_1m`];
  if (typeof m === "number" && m >= 0) return m;
  const h = obj[`${prefix}_1h`];
  if (typeof h === "number" && h >= 0) return h;
  // fallback to swaps_1m or swaps_1h
  const s1 = obj["swaps_1m"];
  if (typeof s1 === "number" && s1 >= 0) return s1;
  const s2 = obj["swaps_1h"];
  if (typeof s2 === "number" && s2 >= 0) return s2;
  return 0;
}

// convert gmgn timestamp (seconds) to age minutes
function ageMinutesFromTs(tsSeconds) {
  if (!tsSeconds) return Infinity;
  const nowSec = Math.floor(Date.now() / 1000);
  const diff = nowSec - Number(tsSeconds);
  return diff / 60;
}

// fetch via page POST (so cookies/origin included)
async function pagePostFetch(page, endpoint, body) {
  try {
    // reload homepage to ensure cookies/origin are correct
    await page.goto("https://gmgn.ai/", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(()=>{});
    await sleep(700);
    const result = await page.evaluate(async (url, payload) => {
      try {
        const r = await fetch(url, {
          method: "POST",
          mode: "cors",
          credentials: "include",
          headers: { "accept": "application/json, text/plain, */*", "content-type": "application/json" },
          body: JSON.stringify(payload || {})
        });
        const status = r.status;
        const ct = r.headers.get("content-type") || "";
        const text = await r.text();
        let json = null;
        try { json = JSON.parse(text); } catch(e){ /* ignore */ }
        return { ok: true, status, contentType: ct, rawText: text, json };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    }, endpoint, body);
    return result;
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// axios fallback POST with cookie header
async function axiosFetchPOST(endpoint, body, cookieHeader = null) {
  try {
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      "Accept": "application/json, text/plain, */*",
      "Content-Type": "application/json",
      "Referer": "https://gmgn.ai/",
      "Origin": "https://gmgn.ai"
    };
    if (cookieHeader) headers.Cookie = cookieHeader;
    const res = await axios.post(endpoint, body, { headers, timeout: 20000, transformResponse: [d => d] });
    const rawText = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
    let json = null;
    try { json = JSON.parse(rawText); } catch(e){ /* */ }
    return { ok: true, status: res.status, rawText, json };
  } catch (err) {
    return { ok: false, error: err.message, status: err.response?.status, data: err.response?.data };
  }
}

// cloudflare detection
async function pageShowsCloudflare(page) {
  try {
    const body = await page.evaluate(() => document.body.innerText || "");
    const t = (body || "").toLowerCase();
    if (!t) return true;
    if (t.includes("attention required") || t.includes("you have been blocked") || t.includes("please enable cookies") || t.includes("cloudflare")) return true;
    return false;
  } catch (e) { return true; }
}

// build a discord embed for a token
function buildEmbedForToken(tok, reason = "") {
  const ca = tok.address || tok.pool_address || tok.poolAddress || "N/A";
  const symbol = tok.symbol || tok.name || "N/A";
  const name = tok.name || "";
  const mcap = Math.floor(tok.usd_market_cap || tok.market_cap || 0).toLocaleString();
  const holders = tok.holder_count || tok.holderCount || tok.holder_count || tok.holder_count || tok.holder_count || tok.holder_count || tok.holder_count || tok.holderCount || tok.holder_count || tok.holder_count || tok.holder_count || tok.holder_count || tok.holder_count || tok.holder_count || tok.holder_count || tok.holder_count || tok.holder_count || tok.holderCount || 0;
  const liquidity = Math.floor(tok.liquidity || 0).toLocaleString();
  const buys = chooseCount(tok, "buys");
  const sells = chooseCount(tok, "sells");
  const ageMin = ageMinutesFromTs(tok.created_timestamp || tok.createdTimestamp || 0).toFixed(1);
  const logo = tok.logo || tok.icon || null;
  const fields = [
    { name: "Market", value: `MCAP: $${mcap}\nLiquidity: $${liquidity}`, inline: true },
    { name: "Stats", value: `Holders: ${holders}\nBuys: ${buys} • Sells: ${sells}\nAge: ${ageMin} min`, inline: true },
    { name: "Launchpad", value: tok.launchpad || tok.launchpad_platform || "N/A", inline: true },
    { name: "Addresses", value: `CA: \`\`\`${ca}\`\`\`\nQuote: \`${tok.quote_address}\``, inline: false },
  ];
  return {
    title: `${symbol} — ${name} ${reason ? `(${reason})` : ""}`,
    url: `https://gmgn.ai/token/${ca}`,
    thumbnail: logo ? { url: logo } : undefined,
    fields,
    timestamp: new Date().toISOString()
  };
}

// main
(async () => {
  console.log("🚀 GMGN Pump & Completed Monitor");
  console.log(`  HEADLESS=${HEADLESS} POLL=${POLL_INTERVAL/1000}s DEBUG=${DEBUG}`);
  console.log("  Watching: near_completion -> pump, and completed -> migrated");
  console.log("  Filters: pump => mcap>=16900, buys>=5, sells>=5, age<15min");
  console.log("           completed => mcap>=60000, holders>69, buys>=30, sells>=30");
  console.log("-------------------------------------------------------------");

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    executablePath: process.env.CHROME_EXECUTABLE_PATH || undefined,
    userDataDir: SESSION_DIR,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    defaultViewport: { width: 1200, height: 800 }
  });

  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

  // ensure CF solved (interactive if needed)
  await page.goto("https://gmgn.ai/", { waitUntil: "domcontentloaded" }).catch(()=>{});
  if (await pageShowsCloudflare(page)) {
    if (!HEADLESS) {
      console.log("⚠️ Cloudflare challenge detected — please solve it in the opened browser window.");
      const start = Date.now();
      const TIMEOUT = 120000;
      while (Date.now() - start < TIMEOUT) {
        if (!(await pageShowsCloudflare(page))) break;
        process.stdout.write(".");
        await sleep(2500);
      }
      console.log("");
      if (await pageShowsCloudflare(page)) {
        console.error("❌ Timeout — CF still blocking. Restart and solve manually.");
        await browser.close();
        process.exit(1);
      } else {
        console.log("✅ CF solved — continuing.");
      }
    } else {
      console.error("❌ CF detected and running headless. Restart with HEADLESS=false and solve CF once.");
      await browser.close();
      process.exit(1);
    }
  } else {
    debugLog("No CF interstitial detected.");
  }

  // extract cookies for axios fallback
  const cookies = await page.cookies();
  const cookieHeader = cookiesToHeader(cookies);
  debugLog("Cookie header clipped:", cookieHeader.slice(0,300));

  while (true) {
    try {
      // fetch from page context
      const pageResp = await page.evaluate(async (url, payload) => {
        try {
          const r = await fetch(url, {
            method: "POST",
            mode: "cors",
            credentials: "include",
            headers: { "accept": "application/json, text/plain, */*", "content-type": "application/json" },
            body: JSON.stringify(payload || {})
          });
          const status = r.status;
          const text = await r.text();
          let json = null;
          try { json = JSON.parse(text); } catch(e){ /* not JSON */ }
          return { ok: true, status, rawText: text, json };
        } catch (err) {
          return { ok: false, error: String(err) };
        }
      }, ENDPOINT, POST_BODY);

      fs.writeFileSync(LAST_DATA, JSON.stringify({ ts: new Date().toISOString(), result: pageResp }, null, 2));

      let dataObj = pageResp && pageResp.json ? pageResp.json : null;

      // fallback to axios if pageResp wasn't usable
      if (!dataObj) {
        debugLog("Page fetch returned nothing usable, trying axios fallback...");
        const axiosResp = await axiosFetchPOST(ENDPOINT, POST_BODY, cookieHeader);
        fs.writeFileSync(LAST_DATA, JSON.stringify({ ts: new Date().toISOString(), pageResp, axiosResp }, null, 2));
        if (axiosResp.ok && axiosResp.json) dataObj = axiosResp.json;
        else {
          console.log(now(), "❌ Fetch failed or returned no JSON. See", LAST_DATA);
          await sleep(POLL_INTERVAL);
          continue;
        }
      }

      const pumpArr = dataObj.data?.near_completion || dataObj.data?.pump || dataObj.data?.aboutToGraduate || [];
      const completedArr = dataObj.data?.completed || [];

      const matchesPump = [];
      const matchesMigrated = [];

      // evaluate pump filters
      for (const t of pumpArr) {
        const mcap = Number(t.usd_market_cap || t.market_cap || 0);
        const buys = chooseCount(t, "buys");
        const sells = chooseCount(t, "sells");
        const ageMin = ageMinutesFromTs(t.created_timestamp || t.createdTimestamp || 0);

        if (mcap >= 16900 && buys >= 5 && sells >= 5 && ageMin < 15) {
          matchesPump.push({ token: t, mcap, buys, sells, ageMin });
        }
      }

      // evaluate completed filters
      for (const t of completedArr) {
        const mcap = Number(t.usd_market_cap || t.market_cap || 0);
        const holders = Number(t.holder_count || t.holderCount || t.holder_count || t.holder_count || t.holder_count || 0) || Number(t.holder_count || t.holderCount || 0);
        const buys = chooseCount(t, "buys");
        const sells = chooseCount(t, "sells");

        if (mcap >= 60000 && holders > 69 && buys >= 30 && sells >= 30) {
          matchesMigrated.push({ token: t, mcap, holders, buys, sells });
        }
      }

      // Heartbeat
      console.log(now(), `✅ fetched — pump=${pumpArr.length} completed=${completedArr.length} — matchedPump=${matchesPump.length} matchedMigrated=${matchesMigrated.length}`);

      // notify pump matches
      for (const m of matchesPump) {
        const id = m.token.address || m.token.pool_address || m.token.poolAddress || m.token.address?.toLowerCase();
        if (!id) continue;
        notified[id] = notified[id] || {};
        if (notified[id].pump) continue; // already notified
        // send webhook / console
        const embed = buildEmbedForToken(m.token);
        console.log(now(), `🔔 NEW PUMP → ${m.token.symbol || m.token.name}  mcap:${m.mcap} buys:${m.buys} sells:${m.sells} age:${m.ageMin.toFixed(1)}m`);
        await sendDiscordWebhook(WEBHOOK_URLS_PUMP, null, [embed]);
        notified[id].pump = true;
      }

      // notify migrated matches
      for (const m of matchesMigrated) {
        const id = m.token.address || m.token.pool_address || m.token.poolAddress || m.token.address?.toLowerCase();
        if (!id) continue;
        notified[id] = notified[id] || {};
        if (notified[id].migrated) continue;
        const embed = buildEmbedForToken(m.token);
        console.log(now(), `🔔 NEW MIGRATED → ${m.token.symbol || m.token.name} mcap:${m.mcap} holders:${m.holders} buys:${m.buys} sells:${m.sells}`);
        await sendDiscordWebhook(WEBHOOK_URLS_MIGRATED, null, [embed]);
        notified[id].migrated = true;
      }

      // persist notified map
      try { saveNotified(); } catch(e) { console.error("Failed to persist notified:", e.message); }

    } catch (err) {
      console.error(now(), "Loop error:", err.message);
    }

    await sleep(POLL_INTERVAL);
  }
})();
