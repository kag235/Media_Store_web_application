/**
 * routes/admin.js
 * Admin panel route handler with security, input validation, rate limiting,
 * CSRF protection, structured logging, and audit trails
 */

const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");
const pino = require("pino");
const rateLimit = require("express-rate-limit");
const csrf = require("csurf");
const { issuePasscode } = require("../passcode");

// ============================
// LOGGER SETUP
// ============================
const logger = pino();

// ============================
// CONSTANTS
// ============================
const SALT_ROUNDS = 12;
const MIN_PASSWORD_LENGTH = 8;
const MAX_USERNAME_LENGTH = 50;
const MIN_QUOTA_GB = 0.1;
const MAX_QUOTA_GB = 1000;
const MIN_EXPIRE_DAYS = 1;
const MAX_EXPIRE_DAYS = 365;

// ============================
// RATE LIMITERS
// ============================

// Login attempt limiter: 5 attempts per 15 minutes
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: "Too many login attempts. Please try again later.",
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    logger.warn({ ip: req.ip }, "Login rate limit exceeded");
    return false;
  }
});

// Registration limiter: 3 attempts per hour
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: "Too many registration attempts. Please try again later.",
  standardHeaders: true,
  legacyHeaders: false
});

// Passcode generation limiter: 20 per hour
const passcodeGenerateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: "Too many passcode generation requests. Please try again later.",
  standardHeaders: true,
  legacyHeaders: false
});

// ============================
// CSRF PROTECTION
// ============================
const csrfProtection = csrf({ cookie: false });

// ============================
// DATABASE UTILITIES
// ============================

const dbRun = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    global.db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
};

const dbGet = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    global.db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

const dbAll = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    global.db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
};

// ============================
// VALIDATION FUNCTIONS
// ============================

const validateUsername = (username) => {
  if (!username || typeof username !== "string") {
    return { valid: false, error: "Username is required" };
  }
  if (username.length < 3 || username.length > MAX_USERNAME_LENGTH) {
    return { valid: false, error: `Username must be between 3 and ${MAX_USERNAME_LENGTH} characters` };
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    return { valid: false, error: "Username can only contain letters, numbers, hyphens, and underscores" };
  }
  return { valid: true };
};

const validatePassword = (password) => {
  if (!password || typeof password !== "string") {
    return { valid: false, error: "Password is required" };
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { valid: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }
  if (password.length > 128) {
    return { valid: false, error: "Password is too long" };
  }
  // Optional: require complexity
  // if (!/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/.test(password)) {
  //   return { valid: false, error: "Password must contain uppercase, lowercase, and numbers" };
  // }
  return { valid: true };
};

const validateQuota = (quotaGb) => {
  const quota = parseFloat(quotaGb);
  if (isNaN(quota) || quota < MIN_QUOTA_GB || quota > MAX_QUOTA_GB) {
    return { valid: false, error: `Quota must be between ${MIN_QUOTA_GB} and ${MAX_QUOTA_GB} GB` };
  }
  return { valid: true, value: quota };
};

const validateExpireDays = (expireDays) => {
  const days = parseInt(expireDays, 10);
  if (isNaN(days) || days < MIN_EXPIRE_DAYS || days > MAX_EXPIRE_DAYS) {
    return { valid: false, error: `Expiration must be between ${MIN_EXPIRE_DAYS} and ${MAX_EXPIRE_DAYS} days` };
  }
  return { valid: true, value: days };
};

// ============================
// AUDIT LOGGING
// ============================

const auditLog = async (adminId, action, details = {}) => {
  try {
    await dbRun(
      `INSERT INTO admin_audit_logs (admin_id, action, details, created_at)
       VALUES (?, ?, ?, datetime('now'))`,
      [adminId, action, JSON.stringify(details)]
    );
    logger.info({ adminId, action, details }, "Audit log recorded");
  } catch (err) {
    logger.error({ err, adminId, action }, "Failed to record audit log");
  }
};

// ============================
// MIDDLEWARE: REQUIRE ADMIN
// ============================

const requireAdmin = async (req, res, next) => {
  if (!req.session.adminId) {
    logger.warn({ ip: req.ip }, "Unauthorized admin access attempt");
    return res.redirect("/admin/login");
  }

  // Verify admin still exists in database
  try {
    const admin = await dbGet(
      `SELECT admin_id FROM admin_users WHERE admin_id = ?`,
      [req.session.adminId]
    );

    if (!admin) {
      logger.warn({ adminId: req.session.adminId }, "Session admin not found in database");
      req.session.destroy();
      return res.redirect("/admin/login");
    }

    next();
  } catch (err) {
    logger.error({ err }, "Error verifying admin session");
    res.status(500).render("error", { error: "Session verification failed" });
  }
};

// ============================
// ADMIN REGISTRATION
// ============================

router.get("/register", csrfProtection, (req, res) => {
  res.render("admin-register", { csrfToken: req.csrfToken() });
});

router.post("/register", registerLimiter, csrfProtection, async (req, res) => {
  try {
    const { username, password, secret } = req.body;

    // Validate inputs
    const usernameValidation = validateUsername(username);
    if (!usernameValidation.valid) {
      logger.warn({ username }, usernameValidation.error);
      return res.render("admin-register", {
        error: usernameValidation.error,
        csrfToken: req.csrfToken()
      });
    }

    const passwordValidation = validatePassword(password);
    if (!passwordValidation.valid) {
      logger.warn({ username }, passwordValidation.error);
      return res.render("admin-register", {
        error: passwordValidation.error,
        csrfToken: req.csrfToken()
      });
    }

    if (!secret || typeof secret !== "string") {
      logger.warn({ username, ip: req.ip }, "Missing admin secret");
      return res.render("admin-register", {
        error: "Admin secret is required",
        csrfToken: req.csrfToken()
      });
    }

    // Verify admin secret
    if (secret !== process.env.ADMIN_SECRET) {
      logger.warn({ username, ip: req.ip }, "Invalid admin secret attempt");
      return res.render("admin-register", {
        error: "Invalid admin secret code",
        csrfToken: req.csrfToken()
      });
    }

    // Hash password
    const hash = await bcrypt.hash(password, SALT_ROUNDS);

    // Insert admin user
    await dbRun(
      `INSERT INTO admin_users (admin_user_name, admin_user_password_hash, created_at)
       VALUES (?, ?, datetime('now'))`,
      [username, hash]
    );

    logger.info({ username }, "Admin user registered successfully");

    res.redirect("/admin/login");
  } catch (err) {
    if (err.message && err.message.includes("UNIQUE")) {
      logger.warn({ username: req.body.username }, "Username already exists");
      return res.render("admin-register", {
        error: "Username already exists",
        csrfToken: req.csrfToken()
      });
    }

    logger.error({ err }, "Error during admin registration");
    res.render("admin-register", {
      error: "Registration failed. Please try again.",
      csrfToken: req.csrfToken()
    });
  }
});

// ============================
// ADMIN LOGIN & LOGOUT
// ============================

router.get("/login", csrfProtection, (req, res) => {
  res.render("admin-login", { csrfToken: req.csrfToken() });
});

router.post("/login", loginLimiter, csrfProtection, async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      logger.warn({ ip: req.ip }, "Missing login credentials");
      return res.render("admin-login", {
        error: "Username and password are required",
        csrfToken: req.csrfToken()
      });
    }

    // Query admin user
    const admin = await dbGet(
      `SELECT admin_id, admin_user_password_hash FROM admin_users WHERE admin_user_name = ?`,
      [username]
    );

    if (!admin) {
      logger.warn({ username, ip: req.ip }, "Login attempt with non-existent username");
      return res.render("admin-login", {
        error: "Invalid username or password",
        csrfToken: req.csrfToken()
      });
    }

    // Compare passwords
    const match = await bcrypt.compare(password, admin.admin_user_password_hash);

    if (!match) {
      logger.warn({ username, ip: req.ip }, "Login attempt with incorrect password");
      return res.render("admin-login", {
        error: "Invalid username or password",
        csrfToken: req.csrfToken()
      });
    }

    // Set session
    req.session.adminId = admin.admin_id;
    await auditLog(admin.admin_id, "LOGIN", { ip: req.ip });

    logger.info({ adminId: admin.admin_id, username, ip: req.ip }, "Admin login successful");

    res.redirect("/admin/passcodes");
  } catch (err) {
    logger.error({ err, ip: req.ip }, "Error during admin login");
    res.render("admin-login", {
      error: "Login failed. Please try again.",
      csrfToken: req.csrfToken()
    });
  }
});

router.get("/logout", requireAdmin, async (req, res) => {
  try {
    const adminId = req.session.adminId;
    await auditLog(adminId, "LOGOUT");

    req.session.destroy((err) => {
      if (err) {
        logger.error({ err }, "Error destroying session");
      }
      res.redirect("/admin/login");
    });
  } catch (err) {
    logger.error({ err }, "Error during logout");
    res.redirect("/admin/login");
  }
});

// ============================
// PASSCODES DASHBOARD
// ============================

router.get("/passcodes", requireAdmin, csrfProtection, async (req, res) => {
  try {
    const passcodes = await dbAll(
      `SELECT access_passcode, access_passcode_quota_gb, access_passcode_is_used,
              access_passcode_issued_at, access_passcode_expires_at
       FROM access_passcodes
       ORDER BY access_passcode_issued_at DESC
       LIMIT 100`
    );

    res.render("admin-passcodes", {
      passcodes,
      csrfToken: req.csrfToken()
    });
  } catch (err) {
    logger.error({ err }, "Error fetching passcodes");
    res.status(500).render("error", { error: "Failed to load passcodes" });
  }
});

// ============================
// GENERATE NEW PASSCODE
// ============================

router.post("/passcodes/generate", requireAdmin, passcodeGenerateLimiter, async (req, res) => {
  try {
    const adminId = req.session.adminId;
    const { quota_gb, expires_days } = req.body;

    // Validate quota
    const quotaValidation = validateQuota(quota_gb);
    if (!quotaValidation.valid) {
      logger.warn({ adminId, quota_gb }, quotaValidation.error);
      return res.status(400).json({
        success: false,
        message: quotaValidation.error
      });
    }

    // Validate expiration
    const expireValidation = validateExpireDays(expires_days);
    if (!expireValidation.valid) {
      logger.warn({ adminId, expires_days }, expireValidation.error);
      return res.status(400).json({
        success: false,
        message: expireValidation.error
      });
    }

    // Generate passcode
    const newCode = await issuePasscode(
      adminId,
      quotaValidation.value,
      expireValidation.value
    );

    // Audit log
    await auditLog(adminId, "GENERATE_PASSCODE", {
      passcode: newCode,
      quotaGb: quotaValidation.value,
      expireDays: expireValidation.value
    });

    logger.info(
      { adminId, quota: quotaValidation.value, expireDays: expireValidation.value },
      "Passcode generated successfully"
    );

    res.json({ success: true, passcode: newCode });
  } catch (err) {
    logger.error({ err, adminId: req.session.adminId }, "Error generating passcode");
    res.status(500).json({
      success: false,
      message: "Error generating passcode"
    });
  }
});

// ============================
// PASSCODES JSON API
// ============================

router.get("/passcodes/json", requireAdmin, async (req, res) => {
  try {
    const passcodes = await dbAll(
      `SELECT access_passcode, access_passcode_quota_gb, access_passcode_is_used,
              access_passcode_issued_at, access_passcode_expires_at
       FROM access_passcodes
       ORDER BY access_passcode_issued_at DESC
       LIMIT 100`
    );

    res.json(passcodes);
  } catch (err) {
    logger.error({ err }, "Error fetching passcodes JSON");
    res.status(500).json({ error: "Failed to fetch passcodes" });
  }
});

// ============================
// ERROR HANDLER
// ============================

router.use((err, req, res, next) => {
  if (err.code === "EBADCSRFTOKEN") {
    logger.warn({ ip: req.ip }, "CSRF token validation failed");
    res.status(403).render("error", { error: "CSRF token invalid" });
  } else {
    logger.error({ err }, "Route error");
    res.status(500).render("error", { error: "Internal server error" });
  }
});

module.exports = router;
