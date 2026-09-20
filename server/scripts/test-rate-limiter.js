require("dotenv").config();
const { createClient } = require("redis");
const path = require("path");
const fs = require("fs");

// ---------------- ANSI colors (no extra dependency needed) ----------------
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const LUA_PATH = path.join(__dirname, "hybrid-limiter.lua");
const LUA_SCRIPT = fs.readFileSync(LUA_PATH, "utf8");

const client = createClient({ url: REDIS_URL });
client.on("error", (err) => console.error("Redis error:", err));

let sha = null;
async function evalLimiter(keys, args) {
  if (!sha) sha = await client.scriptLoad(LUA_SCRIPT);
  try {
    return await client.evalSha(sha, { keys, arguments: args });
  } catch {
    return client.eval(LUA_SCRIPT, { keys, arguments: args });
  }
}

async function checkLimit(id, opts) {
  const {
    capacity,
    refillRatePerSec,
    windowSizeMs,
    windowLimit,
    cost = 1,
    prefix = "rltest",
  } = opts;
  const now = Date.now();
  const currentWindowId = Math.floor(now / windowSizeMs);
  const previousWindowId = currentWindowId - 1;

  const bucketKey = `${prefix}:tb:${id}`;
  const currKey = `${prefix}:sw:${id}:${currentWindowId}`;
  const prevKey = `${prefix}:sw:${id}:${previousWindowId}`;

  const result = await evalLimiter(
    [bucketKey, currKey, prevKey],
    [capacity, refillRatePerSec, windowSizeMs, windowLimit, now, cost].map(
      String,
    ),
  );

  const [
    allowed,
    reason,
    tokens,
    cap,
    currCount,
    prevCount,
    estimated,
    winLimit,
    retryAfterMs,
  ] = result;
  return {
    allowed: Number(allowed) === 1,
    reason,
    tokens: parseFloat(tokens),
    capacity: parseFloat(cap),
    currCount: parseInt(currCount, 10),
    prevCount: parseInt(prevCount, 10),
    estimated: parseFloat(estimated),
    windowLimit: parseInt(winLimit, 10),
    retryAfterMs: parseInt(retryAfterMs, 10),
  };
}

// ---------------- visual helpers ----------------
function bar(value, max, width, color) {
  const ratio = Math.max(0, Math.min(1, value / max));
  const filled = Math.round(ratio * width);
  return (
    color + "█".repeat(filled) + c.gray + "░".repeat(width - filled) + c.reset
  );
}

function printRow(i, r, elapsedSec = null) {
  const statusColor = r.allowed ? c.green : c.red;
  const status = r.allowed ? "ALLOWED" : "DENIED ";
  const reasonTag = r.reason !== "ok" ? `(${r.reason})` : "";

  const tokenBar = bar(r.tokens, r.capacity, 20, c.cyan);
  const windowBar = bar(r.estimated, r.windowLimit, 20, c.yellow);
  const timeTag =
    elapsedSec !== null
      ? `${c.gray}[t=${elapsedSec.toFixed(1)}s]${c.reset} `
      : "";

  console.log(
    `${c.bold}#${String(i).padStart(3, " ")}${c.reset} ${timeTag}` +
      `${statusColor}${status}${c.reset} ${c.red}${reasonTag.padEnd(16)}${c.reset}` +
      `tokens ${tokenBar} ${r.tokens.toFixed(1).padStart(5)}/${r.capacity}   ` +
      `window ${windowBar} ${r.estimated.toFixed(1).padStart(5)}/${r.windowLimit}`,
  );
}

async function resetKeys(id, prefix = "rltest") {
  const keys = await client.keys(`${prefix}:*${id}*`);
  if (keys.length) await client.del(keys);
}

function summarize(allowed, denied, reasons) {
  console.log(
    `\n${c.bold}Result:${c.reset} ${c.green}${allowed} allowed${c.reset}, ${c.red}${denied} denied${c.reset}`,
  );
  if (Object.keys(reasons).length) {
    console.log(`Denial breakdown: ${JSON.stringify(reasons)}`);
  }
}

// ---------------- Scenario 1: burst ----------------
async function burstTest() {
  console.log(`\n${c.bold}${c.cyan}=== SCENARIO 1: BURST TEST ===${c.reset}`);
  console.log(
    `capacity=20 tokens, refill=5 tokens/sec, window=30 req / 5s\n` +
      `Firing 40 requests back-to-back with NO delay -> expect the token bucket to run dry fast.\n`,
  );

  const id = "burst-" + Date.now();
  const opts = {
    capacity: 20,
    refillRatePerSec: 5,
    windowSizeMs: 5000,
    windowLimit: 30,
  };
  await resetKeys(id);

  let allowed = 0,
    denied = 0;
  const reasons = {};

  for (let i = 1; i <= 40; i++) {
    const r = await checkLimit(id, opts);
    printRow(i, r);
    if (r.allowed) allowed++;
    else {
      denied++;
      reasons[r.reason] = (reasons[r.reason] || 0) + 1;
    }
  }

  summarize(allowed, denied, reasons);
}

// ---------------- Scenario 2: sustained / sliding window ----------------
async function sustainedTest() {
  console.log(
    `\n${c.bold}${c.cyan}=== SCENARIO 2: SUSTAINED / SLIDING WINDOW TEST ===${c.reset}`,
  );
  console.log(
    `capacity=10 tokens, refill=3 tokens/sec, window=3s, windowLimit=15\n` +
      `Firing 1 request every 150ms for ~9s -> tokens keep refilling (mostly ALLOWED),\n` +
      `but watch the "window" bar: it climbs across the 3s boundary and gets smoothed\n` +
      `by the previous window's weighted count instead of resetting to 0 instantly.\n`,
  );

  const id = "sustained-" + Date.now();
  const opts = {
    capacity: 10,
    refillRatePerSec: 3,
    windowSizeMs: 3000,
    windowLimit: 15,
  };
  await resetKeys(id);

  let allowed = 0,
    denied = 0;
  const reasons = {};
  const total = 60;

  for (let i = 1; i <= total; i++) {
    const r = await checkLimit(id, opts);
    printRow(i, r);
    if (r.allowed) allowed++;
    else {
      denied++;
      reasons[r.reason] = (reasons[r.reason] || 0) + 1;
    }
    await new Promise((res) => setTimeout(res, 150));
  }

  summarize(allowed, denied, reasons);
}

// ---------------- Scenario 3: strict 10 requests / 10 seconds ----------------
async function strictTest() {
  console.log(
    `\n${c.bold}${c.cyan}=== SCENARIO 3: 10 REQUESTS PER 10 SECONDS ===${c.reset}`,
  );
  console.log(
    `capacity=10 tokens, refill=1 token/sec (10 tokens over 10s), window=10s, windowLimit=10\n` +
      `Phase A: fire 15 requests instantly -> first 10 ALLOWED, rest DENIED (token_bucket empty).\n` +
      `Phase B: wait 11s (bucket fully refills + window rolls over) -> fire 5 more -> ALLOWED again.\n`,
  );

  const id = "strict-" + Date.now();
  const opts = {
    capacity: 10,
    refillRatePerSec: 1,
    windowSizeMs: 10000,
    windowLimit: 10,
  };
  await resetKeys(id);

  const start = Date.now();
  let allowed = 0,
    denied = 0;
  const reasons = {};

  console.log(`${c.bold}-- Phase A: instant burst of 15 --${c.reset}`);
  for (let i = 1; i <= 15; i++) {
    const r = await checkLimit(id, opts);
    printRow(i, r, (Date.now() - start) / 1000);
    if (r.allowed) allowed++;
    else {
      denied++;
      reasons[r.reason] = (reasons[r.reason] || 0) + 1;
    }
  }

  console.log(
    `\n${c.bold}-- waiting 11s for full refill + window rollover --${c.reset}`,
  );
  await new Promise((res) => setTimeout(res, 11000));

  console.log(
    `${c.bold}-- Phase B: 5 more requests after the wait --${c.reset}`,
  );
  for (let i = 16; i <= 20; i++) {
    const r = await checkLimit(id, opts);
    printRow(i, r, (Date.now() - start) / 1000);
    if (r.allowed) allowed++;
    else {
      denied++;
      reasons[r.reason] = (reasons[r.reason] || 0) + 1;
    }
  }

  summarize(allowed, denied, reasons);
}

const SCENARIOS = {
  burst: burstTest,
  sustained: sustainedTest,
  strict: strictTest,
};

(async () => {
  await client.connect();
  console.log(`${c.cyan}Connected to Redis at ${REDIS_URL}${c.reset}`);

  // Run a single scenario with: node scripts/test-rate-limiter.js strict
  // Options: burst | sustained | strict
  const only = process.argv[2];

  if (only && SCENARIOS[only]) {
    await SCENARIOS[only]();
  } else if (only) {
    console.log(
      `${c.red}Unknown scenario "${only}". Options: ${Object.keys(SCENARIOS).join(", ")}${c.reset}`,
    );
  } else {
    await burstTest();
    await sustainedTest();
    await strictTest();
  }

  await client.quit();
  console.log(`\n${c.bold}Done.${c.reset}`);
})();
