const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const sqlite3 = require("sqlite3").verbose();
const pino = require("pino");

// Logger setup
const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport: {
    target: "pino-pretty",
    options: { colorize: true }
  }
});

// Configuration
const CONTENT_ROOT = path.join(__dirname, "..", "content");
const DB_PATH = path.join(__dirname, "..", "database.db");
const FFMPEG_TIMEOUT = parseInt(process.env.FFMPEG_TIMEOUT || "600000", 10); // 10 minutes
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || "3", 10);
const RETRY_DELAY = parseInt(process.env.RETRY_DELAY || "5000", 10); // 5 seconds

// Database utilities
let db = null;

const initDatabase = () => {
  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) {
        logger.error({ err }, "Failed to open database");
        reject(err);
      } else {
        logger.info("Database connected");
        resolve();
      }
    });
  });
};

const getRow = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => {
    if (err) reject(err);
    else resolve(row);
  });
});

const runQuery = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function(err) {
    if (err) reject(err);
    else resolve(this);
  });
});

// File utilities
const ensureDir = (dirPath) => fsSync.existsSync(dirPath) || fsSync.mkdirSync(dirPath, { recursive: true });

const fileExists = (filePath) => fsSync.existsSync(filePath);

const isPathSafe = (userPath, baseDir) => {
  const resolved = path.resolve(userPath);
  const baseDirResolved = path.resolve(baseDir);
  return resolved.startsWith(baseDirResolved);
};

// FFmpeg execution with timeout and proper error handling
const execFFmpeg = (args, timeout = FFMPEG_TIMEOUT) => {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdoutData = "";
    let stderrData = "";

    child.stdout?.on("data", (data) => {
      stdoutData += data.toString();
    });

    child.stderr?.on("data", (data) => {
      stderrData += data.toString();
    });

    const timeoutId = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`FFmpeg timeout after ${timeout}ms`));
    }, timeout);

    child.on("close", (code) => {
      clearTimeout(timeoutId);
      if (code === 0) {
        resolve({ stdout: stdoutData, stderr: stderrData });
      } else {
        reject(new Error(`FFmpeg failed with exit code ${code}: ${stderrData}`));
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeoutId);
      reject(new Error(`FFmpeg process error: ${err.message}`));
    });
  });
};

// Validation
const validateInputFile = async (filePath) => {
  if (!isPathSafe(filePath, CONTENT_ROOT)) {
    throw new Error("Path traversal attack detected");
  }

  if (!fileExists(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const stats = await fs.stat(filePath);
  if (!stats.isFile()) {
    throw new Error("Path is not a file");
  }
};

// Process media file
const processMediaFile = async (fileRecord, retryCount = 0) => {
  const { content_file_id, original_path } = fileRecord;
  
  logger.info({ fileId: content_file_id, path: original_path, retry: retryCount }, "Processing file");

  try {
    // Update status to processing
    await runQuery(
      `UPDATE content_files SET processing_status = ?, updated_at = datetime('now') WHERE content_file_id = ?`,
      ["processing", content_file_id]
    );

    const src = path.join(CONTENT_ROOT, original_path);

    // Validate input file
    await validateInputFile(src);

    const episodeDir = path.resolve(src, "..", "..");
    const base = path.basename(src, path.extname(src));

    // Setup output directories
    const hlsDir = path.join(episodeDir, "hls");
    const previewDir = path.join(episodeDir, "preview");
    const posterDir = path.join(episodeDir, "poster");

    ensureDir(hlsDir);
    ensureDir(previewDir);
    ensureDir(posterDir);

    const hlsOut = path.join(hlsDir, `${base}.m3u8`);
    const previewOut = path.join(previewDir, `${base}.mp4`);
    const posterOut = path.join(posterDir, `${base}.jpg`);

    // Skip if already processed
    if (fileExists(hlsOut) && fileExists(previewOut) && fileExists(posterOut)) {
      logger.info({ fileId: content_file_id }, "Output files already exist, skipping processing");
      
      await runQuery(
        `UPDATE content_files SET hls_path = ?, preview_path = ?, poster_path = ?, processing_status = ?, updated_at = datetime('now') WHERE content_file_id = ?`,
        [
          path.relative(CONTENT_ROOT, hlsOut),
          path.relative(CONTENT_ROOT, previewOut),
          path.relative(CONTENT_ROOT, posterOut),
          "ready",
          content_file_id
        ]
      );
      
      return;
    }

    // Execute FFmpeg commands
    logger.debug({ fileId: content_file_id }, "Generating HLS stream");
    await execFFmpeg(["-y", "-i", src, "-map", "0:v", "-map", "0:a", "-f", "hls", hlsOut]);

    logger.debug({ fileId: content_file_id }, "Generating preview");
    await execFFmpeg(["-y", "-i", src, "-t", "30", previewOut]);

    logger.debug({ fileId: content_file_id }, "Generating poster");
    await execFFmpeg(["-y", "-ss", "5", "-i", src, "-frames:v", "1", posterOut]);

    // Verify output files
    const hlsExists = fileExists(hlsOut);
    const previewExists = fileExists(previewOut);
    const posterExists = fileExists(posterOut);

    if (!hlsExists || !previewExists || !posterExists) {
      throw new Error(`Output files incomplete. HLS: ${hlsExists}, Preview: ${previewExists}, Poster: ${posterExists}`);
    }

    // Update database with success
    await runQuery(
      `UPDATE content_files SET hls_path = ?, preview_path = ?, poster_path = ?, processing_status = ?, updated_at = datetime('now') WHERE content_file_id = ?`,
      [
        path.relative(CONTENT_ROOT, hlsOut),
        path.relative(CONTENT_ROOT, previewOut),
        path.relative(CONTENT_ROOT, posterOut),
        "ready",
        content_file_id
      ]
    );

    logger.info({ fileId: content_file_id, path: original_path }, "✔ File processed successfully");
  } catch (error) {
    logger.error({ fileId: content_file_id, error: error.message, retry: retryCount }, "Processing failed");

    if (retryCount < MAX_RETRIES) {
      logger.info({ fileId: content_file_id, nextRetry: RETRY_DELAY }, "Retrying in milliseconds");
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      return processMediaFile(fileRecord, retryCount + 1);
    }

    // Mark as failed after max retries
    await runQuery(
      `UPDATE content_files SET processing_status = ?, error_message = ?, retry_count = ?, updated_at = datetime('now') WHERE content_file_id = ?`,
      ["failed", error.message, retryCount, content_file_id]
    );
  }
};

// Graceful shutdown
const shutdown = async (signal) => {
  logger.info({ signal }, "Shutdown signal received");
  
  if (db) {
    return new Promise((resolve) => {
      db.close((err) => {
        if (err) {
          logger.error({ err }, "Error closing database");
        } else {
          logger.info("Database closed");
        }
        resolve();
      });
    });
  }
};

// Main worker loop
const startWorker = async () => {
  try {
    await initDatabase();
    logger.info("⚙ Episode-level processing worker started");

    let hasWork = true;

    while (hasWork) {
      try {
        const row = await getRow(
          `SELECT * FROM content_files WHERE processing_status IN ('pending', 'failed') ORDER BY created_at LIMIT 1`
        );

        if (!row) {
          hasWork = false;
          logger.info("No pending files to process");
          break;
        }

        await processMediaFile(row);
      } catch (err) {
        logger.error({ err }, "Error in worker loop");
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    logger.info("✅ Worker finished successfully");
  } catch (err) {
    logger.fatal({ err }, "Fatal worker error");
    process.exit(1);
  } finally {
    await shutdown("normal");
    process.exit(0);
  }
};

// Signal handlers
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Start worker
startWorker();
