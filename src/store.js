const bcrypt = require("bcryptjs");

const demoPasswordHash = bcrypt.hashSync("demo123", 10);

const store = {
  users: [
    {
      id: "u_demo",
      username: "admin",
      passwordHash: demoPasswordHash,
      role: "admin",
      refreshTokens: [],
      printerIds: [],
    },
  ],
  kiosks: {},
  documents: {},
  jobs: {},
  idempotencyClaims: {},
  payments: {},
};

module.exports = { store };
