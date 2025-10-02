// analyze_last_data.js
const fs = require('fs');
const path = './output/gmgn_last_data.json';

if (!fs.existsSync(path)) {
  console.error("No last_data.json found at", path);
  process.exit(1);
}

const raw = fs.readFileSync(path, 'utf8');
let parsed;
try {
  parsed = JSON.parse(raw);
} catch (e) {
  console.log("File is not valid JSON. Raw content:");
  console.log(raw.slice(0, 2000));
  process.exit(0);
}

console.log("=== Top-level keys ===");
console.log(Object.keys(parsed));

function sample(v, n=3) {
  if (Array.isArray(v)) return v.slice(0, n);
  if (v && typeof v === 'object') {
    const keys = Object.keys(v).slice(0, n);
    const out = {};
    for (const k of keys) out[k] = v[k];
    return out;
  }
  return v;
}

console.log("\n=== Top-level samples ===");
for (const k of Object.keys(parsed)) {
  console.log(`\n-- ${k} --`);
  console.log(sample(parsed[k]));
}

// search recursively for likely token-like objects
console.log("\n=== Searching for objects containing token-like keys (id,address,symbol,baseAsset,contract,holders,mcap) ===");
const found = [];
const seen = new WeakSet();

function walk(obj, pathArr = []) {
  if (!obj || typeof obj !== 'object') return;
  if (seen.has(obj)) return;
  seen.add(obj);

  const keys = Object.keys(obj).map(s => s.toLowerCase());
  const tokenKeys = ['id','address','symbol','baseasset','contract','holders','holdercount','mcap','mcab'];
  const matches = tokenKeys.filter(k => keys.includes(k));
  if (matches.length) {
    found.push({ path: pathArr.join('.') || '(root)', matches, sample: sample(obj, 5) });
  }

  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === 'object') walk(v, pathArr.concat(k));
    else if (Array.isArray(v)) v.forEach((el, idx) => walk(el, pathArr.concat(`${k}[${idx}]`)));
  }
}

walk(parsed);

if (!found.length) {
  console.log("No token-like objects found.");
} else {
  console.log("Found", found.length, "matches. Showing top 10:");
  found.slice(0,10).forEach((f, i) => {
    console.log(`\n[${i}] Path: ${f.path}`);
    console.log("Matches:", f.matches);
    console.log("Sample:", JSON.stringify(f.sample, null, 2).slice(0,1000));
  });
}
