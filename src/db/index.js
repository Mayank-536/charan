const { Pool } = require("pg");
const { config } = require("../config");

const pool = new Pool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.database,
  user: config.db.user,
  password: config.db.password,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on("error", (err) => {
  console.error("Unexpected PostgreSQL pool error:", err);
});

async function query(text, params) {
  const start = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - start;
  if (config.debug) {
    console.log("Executed query", { text, duration, rows: result.rowCount });
  }
  return result;
}

async function getClient() {
  const client = await pool.connect();
  const originalRelease = client.release.bind(client);
  client.release = () => {
    originalRelease();
  };
  return client;
}

async function transaction(callback) {
  const client = await getClient();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function initializeDb() {
  const bcrypt = require("bcryptjs");
  const demoPasswordHash = bcrypt.hashSync("demo123", 10);

  // Create tables if they don't exist
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(50) PRIMARY KEY,
      username VARCHAR(100) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(20) DEFAULT 'user',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id SERIAL PRIMARY KEY,
      user_id VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
      token VARCHAR(100) UNIQUE NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS kiosks (
      id VARCHAR(50) PRIMARY KEY,
      owner_id VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(100) NOT NULL,
      location VARCHAR(255),
      printer_model VARCHAR(100),
      status VARCHAR(20) DEFAULT 'offline',
      ink_cyan INTEGER DEFAULT 100,
      ink_magenta INTEGER DEFAULT 100,
      ink_yellow INTEGER DEFAULT 100,
      ink_black INTEGER DEFAULT 100,
      paper_count INTEGER DEFAULT 500,
      last_heartbeat TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS documents (
      id VARCHAR(50) PRIMARY KEY,
      kiosk_id VARCHAR(50) REFERENCES kiosks(id) ON DELETE CASCADE,
      user_phone VARCHAR(20),
      file_url TEXT NOT NULL,
      file_name VARCHAR(255) DEFAULT 'document.pdf',
      page_count INTEGER NOT NULL,
      checksum VARCHAR(128),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS jobs (
      id VARCHAR(50) PRIMARY KEY,
      document_id VARCHAR(50) REFERENCES documents(id) ON DELETE CASCADE,
      kiosk_id VARCHAR(50) REFERENCES kiosks(id) ON DELETE CASCADE,
      copies INTEGER DEFAULT 1,
      color_mode VARCHAR(10) DEFAULT 'bw',
      currency VARCHAR(10) DEFAULT 'INR',
      unit_page_price DECIMAL(10,2),
      sub_total DECIMAL(10,2),
      gst_percent DECIMAL(5,2),
      gst_amount DECIMAL(10,2),
      total DECIMAL(10,2),
      status VARCHAR(30) DEFAULT 'pending_payment',
      payment_id VARCHAR(50),
      claimed_by VARCHAR(50),
      claimed_at TIMESTAMP,
      completed_at TIMESTAMP,
      failure_reason TEXT,
      idempotency_key VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS payments (
      id VARCHAR(50) PRIMARY KEY,
      job_id VARCHAR(50) REFERENCES jobs(id) ON DELETE CASCADE,
      amount DECIMAL(10,2) NOT NULL,
      currency VARCHAR(10) DEFAULT 'INR',
      provider VARCHAR(50),
      status VARCHAR(20) DEFAULT 'pending',
      payment_link TEXT,
      paid_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key VARCHAR(100) PRIMARY KEY,
      response JSONB NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Insert demo user if not exists
  const existingUser = await query("SELECT id FROM users WHERE id = $1", ["u_demo"]);
  if (existingUser.rows.length === 0) {
    await query(
      "INSERT INTO users (id, username, password_hash, role) VALUES ($1, $2, $3, $4)",
      ["u_demo", "admin", demoPasswordHash, "admin"]
    );
    console.log("Demo user created: admin / demo123");
  }

  console.log("Database initialized successfully");
}

module.exports = { pool, query, getClient, transaction, initializeDb };
