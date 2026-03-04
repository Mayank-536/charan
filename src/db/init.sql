-- Printing Press Database Schema

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(50) PRIMARY KEY,
    username VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) DEFAULT 'user',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Refresh tokens table
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR(100) UNIQUE NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Kiosks table
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
);

-- Documents table
CREATE TABLE IF NOT EXISTS documents (
    id VARCHAR(50) PRIMARY KEY,
    kiosk_id VARCHAR(50) REFERENCES kiosks(id) ON DELETE CASCADE,
    user_phone VARCHAR(20),
    file_url TEXT NOT NULL,
    file_name VARCHAR(255) DEFAULT 'document.pdf',
    page_count INTEGER NOT NULL,
    checksum VARCHAR(128),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Jobs table
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
);

-- Payments table
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
);

-- Idempotency keys table
CREATE TABLE IF NOT EXISTS idempotency_keys (
    key VARCHAR(100) PRIMARY KEY,
    response JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_kiosks_owner ON kiosks(owner_id);
CREATE INDEX IF NOT EXISTS idx_documents_kiosk ON documents(kiosk_id);
CREATE INDEX IF NOT EXISTS idx_jobs_kiosk ON jobs(kiosk_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_kiosk_status ON jobs(kiosk_id, status);
CREATE INDEX IF NOT EXISTS idx_payments_job ON payments(job_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);

-- Insert demo admin user (password: demo123)
INSERT INTO users (id, username, password_hash, role)
VALUES ('u_demo', 'admin', '$2a$10$rOzJqQZQZQZQZQZQZQZQZOqQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ', 'admin')
ON CONFLICT (id) DO NOTHING;
