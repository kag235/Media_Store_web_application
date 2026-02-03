PRAGMA foreign_keys = ON;

BEGIN TRANSACTION;

-- ============================
-- USERS
-- ============================
CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_name TEXT UNIQUE NOT NULL,
    user_email TEXT UNIQUE NOT NULL,
    user_password_hash TEXT NOT NULL,
    user_status TEXT CHECK(user_status IN ('active','pending','suspended')) DEFAULT 'pending',
    user_created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============================
-- ADMIN USERS
-- ============================
CREATE TABLE IF NOT EXISTS admin_users (
    admin_id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_user_name TEXT UNIQUE NOT NULL,
    admin_user_password_hash TEXT NOT NULL
);

-- ============================
-- CONTENT TYPES
-- ============================
CREATE TABLE IF NOT EXISTS content_types (
    content_type_id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_type_name TEXT UNIQUE NOT NULL
);

INSERT OR IGNORE INTO content_types (content_type_name) VALUES
('movie'),
('series'),
('documentary'),
('book'),
('music'),
('Turkish'),
('Amharic'),
('Tigrinya'),
('other');

-- ============================
-- CONTENT
-- ============================
CREATE TABLE IF NOT EXISTS content (
    content_id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_title TEXT NOT NULL,
    content_description TEXT,
    content_type_id INTEGER NOT NULL,
    content_kind TEXT CHECK(content_kind IN ('video','audio','document')) NOT NULL DEFAULT 'document',
    content_created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (content_type_id)
        REFERENCES content_types(content_type_id)
);

-- ============================
-- CONTENT FILES (New)
-- ============================
CREATE TABLE IF NOT EXISTS content_files (
    content_file_id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_id INTEGER NOT NULL,

    original_path TEXT NOT NULL,
    hls_path TEXT,
    preview_path TEXT,
    poster_path TEXT,

    file_size_mb REAL NOT NULL,
    duration_minutes INTEGER DEFAULT 0,

    processing_status TEXT DEFAULT 'pending'
        CHECK(processing_status IN ('pending','processing','ready','failed')),

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (content_id)
        REFERENCES content(content_id)
        ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS series (
    series_id INTEGER PRIMARY KEY AUTOINCREMENT,
    series_title TEXT NOT NULL UNIQUE,
    series_description TEXT,
    content_type_id INTEGER NOT NULL,
    poster_path TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (content_type_id)
        REFERENCES content_types(content_type_id)
);
CREATE TABLE IF NOT EXISTS series_episodes (
    episode_id INTEGER PRIMARY KEY AUTOINCREMENT,
    series_id INTEGER NOT NULL,
    season_number INTEGER NOT NULL,
    episode_number INTEGER NOT NULL,
    episode_title TEXT,

    content_file_id INTEGER NOT NULL,

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(series_id, season_number, episode_number),

    FOREIGN KEY (series_id)
        REFERENCES series(series_id)
        ON DELETE CASCADE,

    FOREIGN KEY (content_file_id)
        REFERENCES content_files(content_file_id)
        ON DELETE CASCADE
);


-- ============================
-- PRICING PLANS
-- ============================
CREATE TABLE IF NOT EXISTS pricing_plans (
    pricing_plan_id INTEGER PRIMARY KEY AUTOINCREMENT,
    pricing_plan_name TEXT NOT NULL,
    pricing_plan_data_limit_gb REAL NOT NULL,
    pricing_plan_price REAL NOT NULL,
    pricing_plan_currency TEXT DEFAULT 'ERN'
);

-- ============================
-- PAYMENTS
-- ============================
CREATE TABLE IF NOT EXISTS payments (
    payment_id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    pricing_plan_id INTEGER NOT NULL,
    payment_amount_paid REAL NOT NULL CHECK (payment_amount_paid > 0),
    payment_method TEXT DEFAULT 'cash',
    payment_received_by INTEGER,
    payment_date DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (user_id)
        REFERENCES users(user_id) ON DELETE SET NULL,
    FOREIGN KEY (pricing_plan_id)
        REFERENCES pricing_plans(pricing_plan_id),
    FOREIGN KEY (payment_received_by)
        REFERENCES admin_users(admin_id) ON DELETE SET NULL
);

-- ============================
-- USER QUOTA
-- ============================
CREATE TABLE IF NOT EXISTS user_quota (
    user_id INTEGER PRIMARY KEY,
    user_quota_total_gb REAL NOT NULL,
    used_quota_gb REAL DEFAULT 0,
    user_quota_last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (user_id)
        REFERENCES users(user_id) ON DELETE CASCADE
);

-- ============================
-- STREAMING / DOWNLOAD LOGS
-- ============================
CREATE TABLE IF NOT EXISTS streaming_logs (
    streaming_log_id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    content_file_id INTEGER,
    data_used_mb REAL NOT NULL,
    log_action TEXT NOT NULL CHECK(log_action IN ('stream','download')),
    accessed_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (user_id)
        REFERENCES users(user_id) ON DELETE CASCADE,
    FOREIGN KEY (content_file_id)
        REFERENCES content_files(content_file_id) ON DELETE SET NULL
);

-- ============================
-- ACCESS PASSCODES
-- ============================
CREATE TABLE IF NOT EXISTS access_passcodes (
    access_passcode_id INTEGER PRIMARY KEY AUTOINCREMENT,
    access_passcode TEXT UNIQUE NOT NULL,
    access_passcode_quota_gb REAL NOT NULL,
    access_passcode_is_used INTEGER DEFAULT 0
        CHECK (access_passcode_is_used IN (0,1)),
    access_passcode_issued_by INTEGER NOT NULL,
    access_passcode_issued_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    access_passcode_expires_at DATETIME,
    access_passcode_used_by INTEGER,
    access_passcode_used_at DATETIME,
    FOREIGN KEY (access_passcode_issued_by)
        REFERENCES admin_users(admin_id),
    FOREIGN KEY (access_passcode_used_by)
        REFERENCES users(user_id)
);

-- ============================
-- INDEXES FOR PERFORMANCE
-- ============================
CREATE INDEX IF NOT EXISTS idx_logs_user ON streaming_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_logs_content_file ON streaming_logs(content_file_id);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_content_type ON content(content_type_id);
CREATE INDEX IF NOT EXISTS idx_content_kind ON content(content_kind);

COMMIT;
