require("dotenv").config();

const { createClient } = require("redis");
const path = require("path");
const fs = require("fs");

// ============================================================
// 🎨 COLORS
// ============================================================

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
  white: "\x1b[37m",
};

// ============================================================
// ⚙️ CONFIG
// ============================================================

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

const CONFIG = {
  // Token Bucket
  capacity: 5,
  refillRatePerSec: 1,

  // Dynamic Sliding Window
  windowSizeMs: 5_000,
  windowLimit: 5,

  cost: 1,

  prefix: "linkedin-rate-limit-demo",
};

const LUA_PATH = path.join(__dirname, "hybrid-limiter.lua");

const LUA_SCRIPT = fs.readFileSync(LUA_PATH, "utf8");

// ============================================================
// 🔴 REDIS
// ============================================================

const redis = createClient({
  url: REDIS_URL,
});

redis.on("error", (err) => {
  console.error(`${c.red}Redis error:${c.reset}`, err);
});

// ============================================================
// 🔐 LUA EXECUTION
// ============================================================

let scriptSha = null;

async function evalLimiter(keys, args) {
  if (!scriptSha) {
    scriptSha = await redis.scriptLoad(LUA_SCRIPT);
  }

  try {
    return await redis.evalSha(scriptSha, {
      keys,
      arguments: args,
    });
  } catch {
    return await redis.eval(LUA_SCRIPT, {
      keys,
      arguments: args,
    });
  }
}

// ============================================================
// 🚦 RATE LIMIT CHECK
// ============================================================

async function checkLimit(clientId) {
  const now = Date.now();

  const currentWindowId = Math.floor(now / CONFIG.windowSizeMs);

  const previousWindowId = currentWindowId - 1;

  const bucketKey = `${CONFIG.prefix}:tb:${clientId}`;

  const currentWindowKey = `${CONFIG.prefix}:sw:${clientId}:${currentWindowId}`;

  const previousWindowKey = `${CONFIG.prefix}:sw:${clientId}:${previousWindowId}`;

  const result = await evalLimiter(
    [bucketKey, currentWindowKey, previousWindowKey],
    [
      CONFIG.capacity,
      CONFIG.refillRatePerSec,
      CONFIG.windowSizeMs,
      CONFIG.windowLimit,
      now,
      CONFIG.cost,
    ].map(String),
  );

  const [
    allowed,
    reason,
    tokens,
    capacity,
    currentCount,
    previousCount,
    estimated,
    windowLimit,
    retryAfterMs,
  ] = result;

  return {
    allowed: Number(allowed) === 1,
    reason: String(reason),

    tokens: Number(tokens),
    capacity: Number(capacity),

    currentCount: Number(currentCount),
    previousCount: Number(previousCount),

    estimated: Number(estimated),
    windowLimit: Number(windowLimit),

    retryAfterMs: Number(retryAfterMs),
  };
}

// ============================================================
// 🧹 RESET
// ============================================================

async function resetTest(clientId) {
  const keys = await redis.keys(`${CONFIG.prefix}:*${clientId}*`);

  if (keys.length) {
    await redis.del(keys);
  }
}

// ============================================================
// 📊 PROGRESS BAR
// ============================================================

function bar(value, max, width, color) {
  const ratio = Math.max(0, Math.min(1, value / max));

  const filled = Math.round(ratio * width);

  return (
    color + "█".repeat(filled) + c.gray + "░".repeat(width - filled) + c.reset
  );
}

// ============================================================
// 🖥️ HEADER
// ============================================================

function printHeader() {
  console.log();

  console.log(
    `${c.bold}${c.cyan}` +
      "╔══════════════════════════════════════════════════════════════════════════════╗" +
      `${c.reset}`,
  );

  console.log(
    `${c.bold}${c.cyan}` +
      "║                 🚦 REDIS HYBRID RATE LIMITER                              ║" +
      `${c.reset}`,
  );

  console.log(
    `${c.bold}${c.cyan}` +
      "║                 Token Bucket + Sliding Window                             ║" +
      `${c.reset}`,
  );

  console.log(
    `${c.bold}${c.cyan}` +
      "╚══════════════════════════════════════════════════════════════════════════════╝" +
      `${c.reset}`,
  );

  console.log();

  console.log(
    `${c.bold}Token Bucket${c.reset}` +
      `   capacity=${c.cyan}${CONFIG.capacity}${c.reset}` +
      `   refill=${c.cyan}${CONFIG.refillRatePerSec}/sec${c.reset}`,
  );

  console.log(
    `${c.bold}Sliding Window${c.reset}` +
      `  limit=${c.yellow}${CONFIG.windowLimit}${c.reset}` +
      `   window=${c.yellow}5s${c.reset}`,
  );

  console.log();

  console.log(
    `${c.gray}Request is ALLOWED only when both limits pass.${c.reset}`,
  );

  console.log();
}

// ============================================================
// 📋 REQUEST OUTPUT
// ============================================================

function printRequest(number, result, elapsed) {
  const status = result.allowed
    ? `${c.green}${c.bold}✓ ALLOWED${c.reset}`
    : `${c.red}${c.bold}✗ BLOCKED${c.reset}`;

  const reason =
    result.reason === "ok"
      ? `${c.green}OK${c.reset}`
      : `${c.red}${result.reason}${c.reset}`;

  const tokenBar = bar(result.tokens, result.capacity, 8, c.cyan);

  const windowBar = bar(result.estimated, result.windowLimit, 8, c.yellow);

  console.log(
    `${c.gray}${elapsed.toFixed(1).padStart(5)}s${c.reset} │ ` +
      `${c.bold}#${String(number).padStart(2)}${c.reset} │ ` +
      `${status} │ ` +
      `${reason.padEnd(20)} │ ` +
      `TB ${tokenBar} ${result.tokens
        .toFixed(1)
        .padStart(4)}/${result.capacity} │ ` +
      `SW ${windowBar} ${result.estimated
        .toFixed(1)
        .padStart(4)}/${result.windowLimit}`,
  );

  console.log(
    `       │ ${c.gray}` +
      `current=${result.currentCount}  ` +
      `previous=${result.previousCount}  ` +
      `weighted=${result.estimated.toFixed(2)}` +
      `${c.reset}`,
  );
}

// ============================================================
// 📌 PHASE
// ============================================================

function phase(title, description) {
  console.log();

  console.log(`${c.bold}${c.magenta}┌─ ${title}${c.reset}`);

  console.log(`${c.gray}│ ${description}${c.reset}`);

  console.log(
    `${c.magenta}` +
      "└────────────────────────────────────────────────────────────────────────────" +
      `${c.reset}`,
  );

  console.log(
    `${c.gray}` +
      " Time  │ Req │ Status     │ Reason               │ Token Bucket │ Sliding Window" +
      `${c.reset}`,
  );

  console.log(
    `${c.gray}` +
      "───────┼─────┼────────────┼──────────────────────┼──────────────┼───────────────" +
      `${c.reset}`,
  );
}

// ============================================================
// ⏱️ SLEEP
// ============================================================

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================
// 🧪 DEMO
// ============================================================

async function runDemo() {
  const clientId = `demo-${Date.now()}`;

  await resetTest(clientId);

  printHeader();

  const start = Date.now();

  let allowed = 0;
  let blocked = 0;

  // ==========================================================
  // PHASE 1
  // ==========================================================

  phase(
    "PHASE 1 — BURST",
    "5 requests arrive instantly. The Token Bucket allows the burst.",
  );

  for (let i = 1; i <= 5; i++) {
    const result = await checkLimit(clientId);

    printRequest(i, result, (Date.now() - start) / 1000);

    result.allowed ? allowed++ : blocked++;
  }

  // ==========================================================
  // PHASE 2
  // ==========================================================

  phase(
    "PHASE 2 — BLOCKED REQUESTS",
    "Bucket starts refilling, but the Sliding Window already contains 5 requests.",
  );

  await sleep(1000);

  for (let i = 6; i <= 10; i++) {
    const result = await checkLimit(clientId);

    printRequest(i, result, (Date.now() - start) / 1000);

    result.allowed ? allowed++ : blocked++;

    await sleep(300);
  }

  // ==========================================================
  // PHASE 3
  // ==========================================================

  phase(
    "PHASE 3 — WINDOW ROLLOVER",
    "Wait for the 5-second window to move forward. Previous traffic becomes weighted history.",
  );

  await sleep(3000);

  for (let i = 11; i <= 15; i++) {
    const result = await checkLimit(clientId);

    printRequest(i, result, (Date.now() - start) / 1000);

    result.allowed ? allowed++ : blocked++;

    await sleep(500);
  }

  // ==========================================================
  // SUMMARY
  // ==========================================================

  console.log();

  console.log(
    `${c.bold}${c.cyan}` +
      "╔══════════════════════════════════════════════════════════════════════════════╗" +
      `${c.reset}`,
  );

  console.log(
    `${c.bold}${c.cyan}` +
      "║                              📊 SUMMARY                                    ║" +
      `${c.reset}`,
  );

  console.log(
    `${c.bold}${c.cyan}` +
      "╚══════════════════════════════════════════════════════════════════════════════╝" +
      `${c.reset}`,
  );

  console.log();

  console.log(`  Total Requests : ${c.bold}15${c.reset}`);

  console.log(`  Allowed        : ${c.green}${c.bold}${allowed}${c.reset}`);

  console.log(`  Blocked        : ${c.red}${c.bold}${blocked}${c.reset}`);

  console.log();

  console.log(`${c.bold}Rate Limiting Flow${c.reset}`);

  console.log(
    `  ${c.cyan}①${c.reset} Token Bucket → ${CONFIG.capacity} request burst`,
  );

  console.log(
    `  ${c.cyan}②${c.reset} Refill → ${CONFIG.refillRatePerSec} token/sec`,
  );

  console.log(
    `  ${c.yellow}③${c.reset} Sliding Window → ${CONFIG.windowLimit} req / 5 sec`,
  );

  console.log(
    `  ${c.magenta}④${c.reset} Weighted previous window → smooth boundary`,
  );

  console.log(`  ${c.blue}⑤${c.reset} Redis → shared state`);

  console.log();
}

// ============================================================
// 🚀 START
// ============================================================

(async () => {
  try {
    await redis.connect();

    console.log(
      `${c.green}● Redis connected${c.reset} ` +
        `${c.gray}${REDIS_URL}${c.reset}`,
    );

    await runDemo();

    await redis.quit();

    console.log(`${c.green}● Demo completed${c.reset}\n`);
  } catch (error) {
    console.error(`\n${c.red}${c.bold}✗ Demo failed${c.reset}`);

    console.error(error);

    process.exit(1);
  }
})();
