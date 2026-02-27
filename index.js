/**
 * index.js
 * Main application entry point with comprehensive error handling,
 * logging, session management, and graceful shutdown
 */

const express = require("express");
const path = require("path");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const sqlite3 = require("sqlite3").verbose();
const pino = require("pino");
require("dotenv").config();

// ============================
// LOGGER SETUP
// ============================
const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport: {
    target: "pino-pretty",
    options: { colorize: true }
  }
});

// ============================
// CONFIGURATION & VALIDATION
// ============================
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || "development";
const DB_PATH = process.env.DB_PATH || "./database.db";
const SESSION_SECRET = process.env.SESSION_SECRET;
const SESSION_TIMEOUT = parseInt(process.env.SESSION_TIMEOUT || "7200000", 10); // 2 hours

// Validate required environment variables
const validateEnv = () => {
  const required = ["SESSION_SECRET"];
  const missing = required.filter(key => !process.env[key]);

  if (missing.length > 0) {
    logger.error({ missing }, "❌ Missing required environment variables");
    process.exit(1);
  }

  logger.info({ port: PORT, env: NODE_ENV, dbPath: DB_PATH }, "✅ Environment validation passed");
};

// ============================
// DATABASE SETUP
// ============================
let db = null;
let isShuttingDown = false;

const initDatabase = () => {
  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) {
        logger.error({ err }, "Failed to open database");
        reject(err);
      } else {
        // Enable foreign keys
        db.run("PRAGMA foreign_keys=ON", (err) => {
          if (err) {
            logger.error({ err }, "Failed to enable foreign keys");
            reject(err);
          } else {
            logger.info({ dbPath: DB_PATH }, "✅ Database connected with foreign keys enabled");
            resolve(db);
          }
        });
      }
    });
  });
};

const closeDatabase = () => {
  return new Promise((resolve) => {
    if (db) {
      db.close((err) => {
        if (err) {
          logger.error({ err }, "Error closing database");
        } else {
          logger.info("✅ Database closed");
        }
        resolve();
      });
    } else {
      resolve();
    }
  });
};

// ============================
// EXPRESS APP SETUP
// ============================
const app = express();

// Trust proxy (important for production)
app.set("trust proxy", 1);

// View engine
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// ============================
// MIDDLEWARE (ORDER MATTERS)
// ============================

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    logger.info(
      {
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        duration: `${duration}ms`,
        ip: req.ip
      },
      `${req.method} ${req.path}`
    );
  });
  next();
});

// Body parsers with size limits
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(express.json({ limit: "10mb" }));

// Session configuration with security best practices
const sessionConfig = {
  store: new SQLiteStore({ db: "sessions.db" }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  name: "sessionId",
  cookie: {
    maxAge: SESSION_TIMEOUT,
    httpOnly: true,
    secure: NODE_ENV === "production",
    sameSite: "strict"
  }
};

app.use(session(sessionConfig));

// Make session user available to views
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.isProduction = NODE_ENV === "production";
  next();
});

// Static files with caching
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));

// ============================
// HEALTH CHECK ENDPOINT
// ============================
app.get("/health", (req, res) => {
  if (isShuttingDown) {
    res.status(503).json({ status: "shutting_down" });
  } else if (db) {
    res.status(200).json({
      status: "ok",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: NODE_ENV
    });
  } else {
    res.status(503).json({ status: "database_unavailable" });
  }
});

// ============================
// ROUTES
// ============================

// Home page
app.get("/", (req, res) => {
  try {
    res.render("index");
  } catch (err) {
    logger.error({ err }, "Error rendering home page");
    res.status(500).render("error", { error: "Internal server error" });
  }
});

// Route handlers
try {
  app.use("/attendee", require("./routes/attendee"));
  app.use("/content", require("./routes/content"));
  app.use("/admin", require("./routes/admin"));
  app.use("/admin", require("./routes/content-upload"));
} catch (err) {
  logger.error({ err }, "Error loading routes");
}

// ============================
// ERROR HANDLING
// ============================

// 404 handler
app.use((req, res) => {
  logger.warn({ method: req.method, path: req.path }, "404 Not Found");
  res.status(404).render("error", {
    error: "Page not found",
    statusCode: 404
  });
});

// Global error handler (must be last)
app.use((err, req, res, next) => {
  const statusCode = err.statusCode || 500;
  const isDev = NODE_ENV === "development";

  logger.error(
    {
      err: err.message,
      method: req.method,
      path: req.path,
      statusCode,
      stack: err.stack
    },
    "Unhandled error"
  );

  // Don't expose error details in production
  const errorMessage = isDev ? err.message : "Internal server error";
  const errorStack = isDev ? err.stack : undefined;

  res.status(statusCode).render("error", {
    error: errorMessage,
    statusCode,
    stack: errorStack,
    isDev
  });
});

// ============================
// SERVER START & GRACEFUL SHUTDOWN
// ============================
const startServer = async () => {
  try {
    validateEnv();
    await initDatabase();

    // Make db globally available
    global.db = db;

    const server = app.listen(PORT, () => {
      logger.info({ port: PORT, env: NODE_ENV }, `🚀 Server running on http://localhost:${PORT}`);
    });

    // Graceful shutdown handler
    const gracefulShutdown = async (signal) => {
      if (isShuttingDown) return;
      isShuttingDown = true;

      logger.info({ signal }, "Received shutdown signal, initiating graceful shutdown");

      // Stop accepting new connections
      server.close(() => {
        logger.info("HTTP server closed");
      });

      // Close database connection
      await closeDatabase();

      logger.info("✅ Graceful shutdown complete");
      process.exit(0);
    };

    // Listen for shutdown signals
    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
    process.on("SIGINT", () => gracefulShutdown("SIGINT"));

    // Handle uncaught exceptions
    process.on("uncaughtException", (err) => {
      logger.fatal({ err }, "❌ Uncaught exception - shutting down");
      process.exit(1);
    });

    // Handle unhandled promise rejections
    process.on("unhandledRejection", (reason, promise) => {
      logger.fatal({ reason }, "❌ Unhandled promise rejection - shutting down");
      process.exit(1);
    });

  } catch (err) {
    logger.fatal({ err }, "Failed to start server");
    process.exit(1);
  }
};

// Start the server
startServer();

module.exports = app;
