const { query } = require("../db");
const { apiError } = require("../utils/errors");

/**
 * Idempotency middleware – reads Idempotency-Key header.
 * If the key was seen before, return the cached response.
 * Otherwise, monkey-patch res.json to capture the response.
 */
function idempotent(req, res, next) {
  const key = req.headers["idempotency-key"];
  if (!key) return next(); // no key → normal flow

  query("SELECT response FROM idempotency_keys WHERE key = $1", [key])
    .then((result) => {
      if (result.rows.length > 0) {
        // Return cached response
        return res.json(result.rows[0].response);
      }

      // Monkey-patch res.json to capture outgoing response
      const originalJson = res.json.bind(res);
      res.json = (body) => {
        // Only cache successful responses (2xx)
        if (res.statusCode >= 200 && res.statusCode < 300) {
          query(
            "INSERT INTO idempotency_keys (key, response) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING",
            [key, JSON.stringify(body)]
          ).catch((err) => console.error("Idempotency cache write failed:", err));
        }
        return originalJson(body);
      };

      next();
    })
    .catch(next);
}

module.exports = { idempotent };
