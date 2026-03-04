const jwt = require("jsonwebtoken");
const { config } = require("../config");
const { apiError } = require("../utils/errors");

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    return next(apiError(401, "AUTH_REQUIRED", "Bearer token is required"));
  }

  try {
    const payload = jwt.verify(token, config.jwtSecret);
    req.user = payload;
    return next();
  } catch (error) {
    return next(apiError(401, "AUTH_INVALID", "Invalid or expired access token"));
  }
}

module.exports = { requireAuth };
