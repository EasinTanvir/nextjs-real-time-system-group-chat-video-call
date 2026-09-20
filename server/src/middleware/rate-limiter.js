const { checkLimit } = require("../redis/rate-limiter");

/**
 * Express middleware factory.
 *
 * Example:
 *   app.use("/api/v1", rateLimiter({
 *     capacity: 20,            // allow bursts up to 20 requests
 *     refillRatePerSec: 5,     // then refill at 5 req/sec
 *     windowSizeMs: 60_000,    // and never exceed...
 *     windowLimit: 300,        // ...300 requests per rolling minute
 *   }));
 *
 * Per-route override example:
 *   router.post("/login", rateLimiter({ capacity: 5, refillRatePerSec: 0.1, windowSizeMs: 60_000, windowLimit: 10 }), loginHandler);
 */
function rateLimiter(options = {}) {
  const { keyGenerator = (req) => req.user?.id || req.ip, ...limiterOpts } =
    options;

  return async function rateLimiterMiddleware(req, res, next) {
    try {
      const id = keyGenerator(req);
      const result = await checkLimit(id, limiterOpts);

      res.set("X-RateLimit-Limit", String(result.tokenCapacity));
      res.set(
        "X-RateLimit-Remaining",
        String(Math.max(0, Math.floor(result.tokensRemaining))),
      );
      res.set("X-RateLimit-Window-Limit", String(result.windowLimit));
      res.set(
        "X-RateLimit-Window-Count",
        String(Math.ceil(result.estimatedWindowCount)),
      );

      if (!result.allowed) {
        res.set("Retry-After", String(Math.ceil(result.retryAfterMs / 1000)));
        return res.status(429).json({
          error: "Too Many Requests",
          reason: result.reason, // "token_bucket" (burst) or "sliding_window" (sustained)
          retryAfterMs: result.retryAfterMs,
        });
      }

      return next();
    } catch (err) {
      // Fail-open: a Redis hiccup shouldn't take your whole API down.
      console.error("Rate limiter error:", err);
      return next();
    }
  };
}

module.exports = { rateLimiter };
