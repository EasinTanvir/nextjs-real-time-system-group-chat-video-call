const fs = require("fs");
const path = require("path");
const { redisClient } = require("../redis");
const LUA_PATH = path.join(__dirname, "../../../scripts", "hybrid-limiter.lua");
const LUA_SCRIPT = fs.readFileSync(LUA_PATH, "utf8");

let cachedSha = null;

async function getSha() {
  if (cachedSha) return cachedSha;
  cachedSha = await redisClient.scriptLoad(LUA_SCRIPT);
  return cachedSha;
}

async function evalLimiter(keys, args) {
  try {
    const sha = await getSha();
    return await redisClient.evalSha(sha, { keys, arguments: args });
  } catch (err) {
    // Script got flushed from Redis cache (e.g. after a redis restart/FLUSHALL) -> reload once.
    if (err && err.message && err.message.includes("NOSCRIPT")) {
      cachedSha = null;
      const sha = await getSha();
      return redisClient.evalSha(sha, { keys, arguments: args });
    }
    // Last resort fallback
    return redisClient.eval(LUA_SCRIPT, { keys, arguments: args });
  }
}

/**
 * checkLimit - combined Token Bucket (burst) + Sliding Window (sustained) rate limiter.
 *
 * @param {string} id - unique identifier for the caller (userId, ip, apiKey, socketId, etc.)
 * @param {object} [opts]
 * @param {number} [opts.capacity=20]          burst size / max tokens in the bucket
 * @param {number} [opts.refillRatePerSec=5]   tokens refilled per second
 * @param {number} [opts.windowSizeMs=60000]   sliding window length in ms
 * @param {number} [opts.windowLimit=100]      max requests allowed per rolling window
 * @param {number} [opts.cost=1]               tokens this request costs
 * @param {string} [opts.prefix="rl"]          redis key namespace
 *
 * @returns {Promise<{
 *   allowed: boolean,
 *   reason: "ok"|"token_bucket"|"sliding_window",
 *   tokensRemaining: number,
 *   tokenCapacity: number,
 *   currentWindowCount: number,
 *   previousWindowCount: number,
 *   estimatedWindowCount: number,
 *   windowLimit: number,
 *   retryAfterMs: number
 * }>}
 */
async function checkLimit(id, opts = {}) {
  const {
    capacity = 20,
    refillRatePerSec = 5,
    windowSizeMs = 60000,
    windowLimit = 100,
    cost = 1,
    prefix = "rl",
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
    tokensRemaining,
    tokenCapacity,
    currentWindowCount,
    previousWindowCount,
    estimatedWindowCount,
    windowLimitOut,
    retryAfterMs,
  ] = result;

  return {
    allowed: Number(allowed) === 1,
    reason,
    tokensRemaining: parseFloat(tokensRemaining),
    tokenCapacity: parseFloat(tokenCapacity),
    currentWindowCount: parseInt(currentWindowCount, 10),
    previousWindowCount: parseInt(previousWindowCount, 10),
    estimatedWindowCount: parseFloat(estimatedWindowCount),
    windowLimit: parseInt(windowLimitOut, 10),
    retryAfterMs: parseInt(retryAfterMs, 10),
  };
}

module.exports = { checkLimit };
