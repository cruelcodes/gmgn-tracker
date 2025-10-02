// inspect_gmgn_tokens_stealth.js
// Purpose: stealth Puppeteer + axios inspector for GMGN tokens endpoint (no filters, raw dump)
// Usage examples:
//  HEADLESS=false node inspect_gmgn_tokens_stealth.js
//  POST_BODY_FILE=./payload.json HEADLESS=false node inspect_gmgn_tokens_stealth.js
//  POST_BODY_JSON='{"recent":{"timeframe":"24h"}}' node inspect_gmgn_tokens_stealth.js
//
// Install: npm i puppeteer-extra puppeteer-extra-plugin-stealth puppeteer axios dotenv

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const axios = require("axios");
const fs = require("fs");
require("dotenv").config();
puppeteer.use(StealthPlugin());

const OUT_DIR = "./output";
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR);
const OUT_FILE = `${OUT_DIR}/gmgn_tokens_last.json`;
const SESSION_DIR = "./session";

const ENDPOINT = "https://gmgn.ai/vas/api/v1/rank/bsc?device_id=c726abfb-282c-4e13-9989-38e32421c8ff&fp_did=c353531e72967c0e225fbcfb70630c7c&client_id=gmgn_web_20251001-4892-0e84618&from_app=gmgn&app_ver=20251001-4892-0e84618&tz_name=Asia%2FCalcutta&tz_offset=19800&app_lang=en-US&os=web";

const HEADLESS = process.env.HEADLESS === "true" || false;
const WAIT_CF_TIMEOUT = parseInt(process.env.WAIT_CF_TIMEOUT || "120000", 10);

// Load POST body from env/file/fallback
function getPostBody() {
  if (process.env.POST_BODY_JSON) {
    try { return JSON.parse(process.env.POST_BODY_JSON); } catch (e) { console.error("Invalid POST_BODY_JSON:", e.message); process.exit(1); }
  }
  if (process.env.POST_BODY_FILE && fs.existsSync(process.env.POST_BODY_FILE)) {
    try { return JSON.parse(fs.readFileSync(process.env.POST_BODY_FILE, "utf8")); } catch (e) { console.error("Invalid POST_BODY_FILE:", e.message); process.exit(1); }
  }
  // fallback minimal body that often works; replace with exact DevTools payload if you have it
  return {
    recent: { timeframe: "24h" },
    graduated: { timeframe: "24h" },
    aboutToGraduate: { timeframe: "24h", maxMcap: 40000, minHolderCount: 8, minMcap: 15000 }
  };
}

const POST_BODY = getPostBody();

// small util
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

// CF detection
async function pageShowsCloudflare(page) {
  try {
    const body = await page.evaluate(() => document.body.innerText || "");
    const t = (body || "").toLowerCase();
    if (!t) return true;
    if (t.includes("attention required") || t.includes("you have been blocked") || t.includes("please enable cookies") || t.includes("cloudflare")) return true;
    return false;
  } catch (e) {
    return true;
  }
}

function cookiesToHeader(cookies) {
  return cookies.map(c => `${c.name}=${c.value}`).join("; ");
}

// axios fallback with cookies
async function axiosPostWithCookies(endpoint, body, cookieHeader) {
  try {
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36",
      "Accept": "application/json, text/plain, */*",
      "Content-Type": "application/json",
      "Referer": "https://gmgn.ai/",
      "Origin": "https://gmgn.ai"
    };
    if (cookieHeader) headers.Cookie = cookieHeader;
    const res = await axios.post(endpoint, body, { timeout: 20000, headers, transformResponse: [d => d] });
    const rawText = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
    let json = null;
    try { json = JSON.parse(rawText); } catch (e) { json = null; }
    return { ok: true, status: res.status, headers: res.headers, rawText, json };
  } catch (err) {
    return { ok: false, error: err.message, status: err.response?.status, data: err.response?.data };
  }
}

(async () => {
  console.log("🔎 GMGN tokens inspector (stealth puppeteer) — raw dump");
  console.log("HEADLESS:", HEADLESS, " — POST body length:", JSON.stringify(POST_BODY).length);

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    userDataDir: SESSION_DIR,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    defaultViewport: { width: 1200, height: 800 }
  });

  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

  // open origin to get cookies and detect CF
  console.log("▶️ Loading https://gmgn.ai/ to inherit cookies / check Cloudflare...");
  await page.goto("https://gmgn.ai/", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  await sleep(1200);

  if (await pageShowsCloudflare(page)) {
    console.log("⚠️ Cloudflare interstitial detected.");
    if (HEADLESS) {
      console.log("⚠️ Running headless and CF detected — recommended to run HEADLESS=false to solve manually.");
      // short automatic wait
      const start = Date.now();
      let resolved = false;
      while (Date.now() - start < 7000) {
        if (!(await pageShowsCloudflare(page))) { resolved = true; break; }
        await sleep(1000);
      }
      if (!resolved) {
        console.error("❌ CF challenge present and headless — aborting. Restart with HEADLESS=false to solve it manually.");
        await browser.close();
        process.exit(1);
      }
    } else {
      console.log("🔓 Please solve the Cloudflare challenge in the opened browser window.");
      console.log(` - Waiting up to ${Math.floor(WAIT_CF_TIMEOUT/1000)}s for you to complete it...`);
      const start = Date.now();
      let solved = false;
      while (Date.now() - start < WAIT_CF_TIMEOUT) {
        if (!(await pageShowsCloudflare(page))) { solved = true; break; }
        process.stdout.write(".");
        await sleep(2500);
      }
      console.log("");
      if (!solved) {
        console.error("❌ Timeout waiting for Cloudflare solve. Exiting.");
        await browser.close();
        process.exit(1);
      }
      console.log("✅ Cloudflare solved — continuing.");
    }
  } else {
    console.log("✅ No Cloudflare interstitial detected.");
  }

  // extract cookies for axios fallback
  const cookies = await page.cookies();
  const cookieHeader = cookiesToHeader(cookies);
  console.log("🔐 Cookies extracted (clipped):", cookieHeader.slice(0, 300));

  // Try page POST first (so origin/cookies included)
  console.log("↦ Sending POST from page context to token endpoint...");
  let pageResp = await page.evaluate(async (url, payload) => {
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
      try { json = JSON.parse(text); } catch (e) { json = null; }
      return { ok: true, status, contentType: ct, rawText: text, json };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }, ENDPOINT, POST_BODY).catch(e => ({ ok: false, error: String(e) }));

  // write page result
  const dump = { fetchedAt: (new Date()).toISOString(), pageResult: pageResp };
  fs.writeFileSync(OUT_FILE, JSON.stringify(dump, null, 2));
  console.log("📥 Page POST result saved to", OUT_FILE);
  console.log("📥 ===== RAW PAGE RESPONSE (clipped 4000 chars) =====");
  console.log(String(pageResp?.rawText || pageResp?.error || "(no body)").slice(0, 4000));
  console.log("📥 ================================================");

  // if page result not useful, try axios fallback using cookies
  if (!(pageResp && pageResp.ok && (pageResp.json || (pageResp.rawText && pageResp.rawText.length > 10)))) {
    console.log("↦ Page POST didn't return usable JSON — trying axios POST with saved cookies...");
    const axiosResp = await axiosPostWithCookies(ENDPOINT, POST_BODY, cookieHeader);
    const dump2 = { fetchedAt: (new Date()).toISOString(), pageResult: pageResp, axiosResult: axiosResp };
    fs.writeFileSync(OUT_FILE, JSON.stringify(dump2, null, 2));
    if (axiosResp.ok) {
      console.log("✅ Axios fallback returned data. Raw (clipped):");
      console.log(String(axiosResp.rawText).slice(0, 4000));
    } else {
      console.error("❌ Axios fallback failed:", axiosResp.error || axiosResp.status);
      console.log("📥 Full dump saved to", OUT_FILE);
    }
  }

  console.log("🧾 Done — full raw response is in", OUT_FILE);
  // keep browser open (session saved) so future runs reuse cookies; close if you want:
  // await browser.close();
})();
