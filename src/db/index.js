const { Pool } = require("pg");
const { config } = require("../config");

// Prefer DATABASE_URL (provided by Render, Railway, etc.)
// Fall back to individual env vars for local dev
const poolConfig = process.env.DATABASE_URL
  ? {
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    }
  : {
      host: config.db.host,
      port: config.db.port,
      database: config.db.database,
      user: config.db.user,
      password: config.db.password,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    };

const pool = new Pool(poolConfig);

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

  // ── Seed data ──────────────────────────────────────────────

  // Users
  const existingUser = await query("SELECT id FROM users WHERE id = $1", ["u_demo"]);
  if (existingUser.rows.length === 0) {
    const staffHash = bcrypt.hashSync("staff123", 10);
    const demoPasswordHash2 = bcrypt.hashSync("demo123", 10);
    await query(
      "INSERT INTO users (id, username, password_hash, role) VALUES ($1, $2, $3, $4)",
      ["u_demo", "admin", demoPasswordHash, "admin"]
    );
    await query(
      "INSERT INTO users (id, username, password_hash, role) VALUES ($1, $2, $3, $4)",
      ["u_staff1", "staff_ravi", staffHash, "staff"]
    );
    await query(
      "INSERT INTO users (id, username, password_hash, role) VALUES ($1, $2, $3, $4)",
      ["u_cust1", "customer1", demoPasswordHash2, "user"]
    );
    console.log("Seed users created: admin/demo123, staff_ravi/staff123, customer1/demo123");
  }

  // Kiosks
  const existingKiosk = await query("SELECT id FROM kiosks WHERE id = $1", ["k_main"]);
  if (existingKiosk.rows.length === 0) {
    await query(
      `INSERT INTO kiosks (id, owner_id, name, location, printer_model, status, ink_cyan, ink_magenta, ink_yellow, ink_black, paper_count, last_heartbeat)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())`,
      ["k_main", "u_demo", "Main Lobby Kiosk", "Building A, Ground Floor", "HP LaserJet Pro M454", "online", 85, 72, 90, 65, 420]
    );
    await query(
      `INSERT INTO kiosks (id, owner_id, name, location, printer_model, status, ink_cyan, ink_magenta, ink_yellow, ink_black, paper_count, last_heartbeat)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())`,
      ["k_lib", "u_demo", "Library Kiosk", "Central Library, 2nd Floor", "Canon imageCLASS MF644", "online", 95, 88, 92, 78, 300]
    );
    await query(
      `INSERT INTO kiosks (id, owner_id, name, location, printer_model, status, ink_cyan, ink_magenta, ink_yellow, ink_black, paper_count, last_heartbeat)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULL)`,
      ["k_cafe", "u_staff1", "Cafe Corner Kiosk", "Campus Cafe, Near Entrance", "Epson EcoTank L3250", "offline", 50, 45, 55, 30, 150]
    );
    console.log("Seed kiosks created: k_main, k_lib, k_cafe");
  }

  // Documents
  const existingDoc = await query("SELECT id FROM documents WHERE id = $1", ["doc_resume1"]);
  if (existingDoc.rows.length === 0) {
    await query(
      `INSERT INTO documents (id, kiosk_id, user_phone, file_url, file_name, page_count, checksum)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      ["doc_resume1", "k_main", "+919876543210", "https://example.com/files/resume.pdf", "Ravi_Resume_2026.pdf", 2, "abc123hash"]
    );
    await query(
      `INSERT INTO documents (id, kiosk_id, user_phone, file_url, file_name, page_count, checksum)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      ["doc_notes1", "k_lib", "+919876543210", "https://example.com/files/notes.pdf", "Physics_Notes_Ch5.pdf", 18, "def456hash"]
    );
    await query(
      `INSERT INTO documents (id, kiosk_id, user_phone, file_url, file_name, page_count, checksum)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      ["doc_poster1", "k_main", "+918765432109", "https://example.com/files/poster.pdf", "Event_Poster.pdf", 1, "ghi789hash"]
    );
    console.log("Seed documents created: doc_resume1, doc_notes1, doc_poster1");
  }

  // Jobs
  const existingJob = await query("SELECT id FROM jobs WHERE id = $1", ["job_1"]);
  if (existingJob.rows.length === 0) {
    await query(
      `INSERT INTO jobs (id, document_id, kiosk_id, copies, color_mode, currency, unit_page_price, sub_total, gst_percent, gst_amount, total, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      ["job_1", "doc_resume1", "k_main", 3, "bw", "INR", 2.00, 12.00, 18, 2.16, 14.16, "pending_payment"]
    );
    await query(
      `INSERT INTO jobs (id, document_id, kiosk_id, copies, color_mode, currency, unit_page_price, sub_total, gst_percent, gst_amount, total, status, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())`,
      ["job_2", "doc_notes1", "k_lib", 1, "bw", "INR", 2.00, 36.00, 18, 6.48, 42.48, "completed"]
    );
    await query(
      `INSERT INTO jobs (id, document_id, kiosk_id, copies, color_mode, currency, unit_page_price, sub_total, gst_percent, gst_amount, total, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      ["job_3", "doc_poster1", "k_main", 5, "color", "INR", 8.00, 40.00, 18, 7.20, 47.20, "ready_to_print"]
    );
    console.log("Seed jobs created: job_1 (pending), job_2 (completed), job_3 (ready)");
  }

  // Payments
  const existingPay = await query("SELECT id FROM payments WHERE id = $1", ["pay_1"]);
  if (existingPay.rows.length === 0) {
    await query(
      `INSERT INTO payments (id, job_id, amount, currency, provider, status, payment_link)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      ["pay_1", "job_1", 14.16, "INR", "mock", "pending", "https://pay.example.com/mock/pay_1"]
    );
    await query(
      `INSERT INTO payments (id, job_id, amount, currency, provider, status, payment_link, paid_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
      ["pay_2", "job_2", 42.48, "INR", "mock", "success", "https://pay.example.com/mock/pay_2"]
    );
    await query(
      `INSERT INTO payments (id, job_id, amount, currency, provider, status, payment_link, paid_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
      ["pay_3", "job_3", 47.20, "INR", "mock", "success", "https://pay.example.com/mock/pay_3"]
    );
    console.log("Seed payments created: pay_1 (pending), pay_2 (success), pay_3 (success)");
  }

  console.log("Database initialized successfully");
}

module.exports = { pool, query, getClient, transaction, initializeDb };
