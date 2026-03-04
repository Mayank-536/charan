require("dotenv").config();

const config = {
  port: Number(process.env.PORT || 8080),
  jwtSecret: process.env.JWT_SECRET || "replace-this-secret-in-production",
  accessTokenTtl: process.env.ACCESS_TOKEN_TTL || "15m",
  refreshTokenTtl: process.env.REFRESH_TOKEN_TTL || "7d",
  pagePricing: {
    bwPerPage: Number(process.env.BW_PER_PAGE || 2),
    colorPerPage: Number(process.env.COLOR_PER_PAGE || 8),
  },
  gstPercent: Number(process.env.GST_PERCENT || 18),
  db: {
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME || "printing_press",
    user: process.env.DB_USER || "printing_user",
    password: process.env.DB_PASSWORD || "printing_pass",
  },
  debug: process.env.DEBUG === "true",
};

module.exports = { config };
