-- Hybrid rate limiter: Token Bucket (burst control) + Sliding Window Counter (sustained rate control)
-- Both checks run atomically in one Redis call so concurrent requests can't race each other.
--
-- KEYS[1] = token bucket hash key      e.g. rl:tb:<id>
-- KEYS[2] = current window counter key e.g. rl:sw:<id>:<currentWindowId>
-- KEYS[3] = previous window counter key e.g. rl:sw:<id>:<prevWindowId>
--
-- ARGV[1] = capacity            max tokens in the bucket (burst size)
-- ARGV[2] = refillRatePerSec    tokens added back per second
-- ARGV[3] = windowSizeMs        sliding window length in ms (e.g. 60000 = 1 min)
-- ARGV[4] = windowLimit         max requests allowed per rolling window
-- ARGV[5] = now                 current time in ms (Date.now() from Node)
-- ARGV[6] = cost                tokens this request costs (usually 1)

local bucketKey   = KEYS[1]
local currKey     = KEYS[2]
local prevKey     = KEYS[3]

local capacity    = tonumber(ARGV[1])
local refillRate  = tonumber(ARGV[2])
local windowSize  = tonumber(ARGV[3])
local windowLimit = tonumber(ARGV[4])
local now         = tonumber(ARGV[5])
local cost        = tonumber(ARGV[6])

-- ============ 1. TOKEN BUCKET (burst control) ============
local bucket = redis.call("HMGET", bucketKey, "tokens", "ts")
local tokens = tonumber(bucket[1])
local lastTs = tonumber(bucket[2])

if tokens == nil then
  tokens = capacity
  lastTs = now
end

local elapsed = math.max(0, now - lastTs)
local refill = (elapsed / 1000) * refillRate
tokens = math.min(capacity, tokens + refill)

local tokenOk = tokens >= cost

-- ============ 2. SLIDING WINDOW COUNTER (sustained-rate control) ============
-- Classic weighted-window approach: estimate = prevWindowCount * overlapWeight + currWindowCount
local currCount = tonumber(redis.call("GET", currKey)) or 0
local prevCount = tonumber(redis.call("GET", prevKey)) or 0

local elapsedInWindow = now % windowSize
local weight = (windowSize - elapsedInWindow) / windowSize
local estimated = (prevCount * weight) + currCount

local windowOk = estimated < windowLimit

-- ============ 3. DECISION ============
local allowed = 0
local reason = "ok"

if not tokenOk then
  reason = "token_bucket"      -- burst limit hit
elseif not windowOk then
  reason = "sliding_window"    -- sustained rate limit hit
else
  allowed = 1
end

if allowed == 1 then
  tokens = tokens - cost
  currCount = redis.call("INCR", currKey)
  redis.call("PEXPIRE", currKey, windowSize * 2)
end

-- Persist bucket state regardless of the decision so refill math stays correct next call
redis.call("HMSET", bucketKey, "tokens", tostring(tokens), "ts", tostring(now))
redis.call("PEXPIRE", bucketKey, math.ceil((capacity / refillRate) * 1000) + windowSize)

-- How long until enough tokens are available (only meaningful when token bucket was the blocker)
local retryAfterMs = 0
if not tokenOk then
  local need = cost - tokens
  retryAfterMs = math.ceil((need / refillRate) * 1000)
end

return {
  allowed,
  reason,
  tostring(tokens),
  tostring(capacity),
  tostring(currCount),
  tostring(prevCount),
  tostring(estimated),
  tostring(windowLimit),
  tostring(retryAfterMs)
}