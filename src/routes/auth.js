const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");
const { config } = require("../config");
const { query } = require("../db");
const { apiError } = require("../utils/errors");

const router = express.Router();

// POST /auth/login
router.post("/login", async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      throw apiError(400, "VALIDATION_ERROR", "username and password required");
    }

    const result = await query("SELECT * FROM users WHERE username = $1", [username]);
    const user = result.rows[0];

    if (!user) {
      throw apiError(401, "AUTH_FAILED", "Invalid credentials");
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      throw apiError(401, "AUTH_FAILED", "Invalid credentials");
    }

    const accessToken = jwt.sign(
      { sub: user.id, role: user.role },
      config.jwtSecret,
      { expiresIn: config.accessTokenTtl }
    );

    const refreshToken = uuidv4();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await query(
      "INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)",
      [user.id, refreshToken, expiresAt]
    );

    res.json({
      accessToken,
      refreshToken,
      expiresIn: config.accessTokenTtl,
      tokenType: "Bearer",
    });
  } catch (err) {
    next(err);
  }
});

// POST /auth/refresh
router.post("/refresh", async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      throw apiError(400, "VALIDATION_ERROR", "refreshToken required");
    }

    const result = await query(
      "SELECT rt.*, u.role FROM refresh_tokens rt JOIN users u ON rt.user_id = u.id WHERE rt.token = $1 AND rt.expires_at > NOW()",
      [refreshToken]
    );

    if (result.rows.length === 0) {
      throw apiError(401, "AUTH_FAILED", "Invalid or expired refresh token");
    }

    const tokenRecord = result.rows[0];

    // Delete old token
    await query("DELETE FROM refresh_tokens WHERE token = $1", [refreshToken]);

    // Create new tokens
    const accessToken = jwt.sign(
      { sub: tokenRecord.user_id, role: tokenRecord.role },
      config.jwtSecret,
      { expiresIn: config.accessTokenTtl }
    );

    const newRefreshToken = uuidv4();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await query(
      "INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)",
      [tokenRecord.user_id, newRefreshToken, expiresAt]
    );

    res.json({
      accessToken,
      refreshToken: newRefreshToken,
      expiresIn: config.accessTokenTtl,
      tokenType: "Bearer",
    });
  } catch (err) {
    next(err);
  }
});

// POST /auth/logout
router.post("/logout", async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) {
      await query("DELETE FROM refresh_tokens WHERE token = $1", [refreshToken]);
    }
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// POST /auth/register - create new user account
router.post("/register", async (req, res, next) => {
  try {
    const { username, password, role } = req.body;

    if (!username || !password) {
      throw apiError(400, "VALIDATION_ERROR", "username and password required");
    }

    if (password.length < 6) {
      throw apiError(400, "VALIDATION_ERROR", "password must be at least 6 characters");
    }

    const existing = await query("SELECT id FROM users WHERE username = $1", [username]);
    if (existing.rows.length > 0) {
      throw apiError(409, "USER_EXISTS", "Username already taken");
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const userId = `u_${uuidv4()}`;
    const userRole = role === "admin" ? "admin" : "user";

    await query(
      "INSERT INTO users (id, username, password_hash, role) VALUES ($1, $2, $3, $4)",
      [userId, username, passwordHash, userRole]
    );

    res.status(201).json({
      id: userId,
      username,
      role: userRole,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
