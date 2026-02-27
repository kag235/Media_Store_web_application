const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
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
const ROOT = path.join(__dirname, "..", "content");
const DB = path.join(__dirname, "..", "database.db");
const VALID_VIDEO_EXTENSIONS = [".mp4", ".mkv", ".avi", ".mov", ".flv", ".wmv", ".webm"];

// Database utilities
let db = null;

const initDatabase = () => {
  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(DB, (err) => {
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

const runQuery = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function(err) {
    if (err) reject(err);
    else resolve(this);
  });
});

const getRow = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => {
    if (err) reject(err);
    else resolve(row);
  });
});

const getAllRows = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => {
    if (err) reject(err);
    else resolve(rows || []);
  });
});

// File utilities
const ensureDir = (dirPath) => {
  if (!fsSync.existsSync(dirPath)) {
    fsSync.mkdirSync(dirPath, { recursive: true });
  }
};

const getFileSizeMB = (filePath) => {
  try {
    const stats = fsSync.statSync(filePath);
    return +(stats.size / 1048576).toFixed(2);
  } catch (err) {
    throw new Error(`Failed to get file size for ${filePath}: ${err.message}`);
  }
};

const isValidVideoFile = (filename) => {
  const ext = path.extname(filename).toLowerCase();
  return VALID_VIDEO_EXTENSIONS.includes(ext);
};

const isPathSafe = (userPath, baseDir) => {
  const resolved = path.resolve(userPath);
  const baseDirResolved = path.resolve(baseDir);
  return resolved.startsWith(baseDirResolved);
};

const dirExists = (dirPath) => {
  try {
    const stats = fsSync.statSync(dirPath);
    return stats.isDirectory();
  } catch {
    return false;
  }
};

const fileExists = (filePath) => fsSync.existsSync(filePath);

// ============================
// NORMAL CONTENT INGESTION
// ============================
async function ingestCategory(typeName, typeId) {
  const base = path.join(ROOT, typeName);

  if (!dirExists(base)) {
    logger.debug({ category: typeName }, "Category directory not found, skipping");
    return;
  }

  logger.info({ category: typeName }, "Processing category");

  try {
    const files = await fs.readdir(base);
    let ingested = 0;
    let skipped = 0;

    for (const file of files) {
      try {
        const src = path.join(base, file);
        const stats = await fs.stat(src);

        // Skip directories and non-video files
        if (stats.isDirectory()) continue;
        if (!isValidVideoFile(file)) {
          logger.debug({ file }, "Skipping non-video file");
          continue;
        }

        // Security check
        if (!isPathSafe(src, ROOT)) {
          logger.warn({ file }, "Path traversal attempt detected, skipping");
          continue;
        }

        const title = path.parse(file).name;
        const dest = path.join(base, title, "original", file);
        const rel = path.relative(ROOT, dest);

        // Check if already ingested
        const existingFile = await getRow(
          `SELECT content_file_id FROM content_files WHERE original_path = ?`,
          [rel]
        );

        if (existingFile) {
          logger.debug({ title }, "File already ingested");
          skipped++;
          continue;
        }

        // Create directories
        ensureDir(path.dirname(dest));

        // Move file
        await fs.rename(src, dest);
        const fileSizeMB = getFileSizeMB(dest);

        // Insert into database
        const contentResult = await runQuery(
          `INSERT INTO content (content_title, content_type_id, content_kind, created_at)
           VALUES (?, ?, 'video', datetime('now'))`,
          [title, typeId]
        );

        await runQuery(
          `INSERT INTO content_files
           (content_id, original_path, file_size_mb, processing_status, created_at)
           VALUES (?, ?, ?, 'pending', datetime('now'))`,
          [contentResult.lastID, rel, fileSizeMB]
        );

        logger.info({ category: typeName, title, sizeMB: fileSizeMB }, "✔ Ingested");
        ingested++;
      } catch (err) {
        logger.error({ file, err: err.message }, "Failed to ingest file");
      }
    }

    logger.info({ category: typeName, ingested, skipped }, "Category processing complete");
  } catch (err) {
    logger.error({ category: typeName, err: err.message }, "Error processing category");
  }
}

// ============================
// SERIES INGESTION
// ============================
async function ingestSeries(typeId) {
  const root = path.join(ROOT, "series");

  if (!dirExists(root)) {
    logger.debug("Series directory not found, skipping");
    return;
  }

  logger.info("Processing series");

  try {
    const seriesDirs = await fs.readdir(root);
    let totalIngested = 0;

    for (const seriesTitle of seriesDirs) {
      try {
        const seriesPath = path.join(root, seriesTitle);
        const stats = await fs.stat(seriesPath);

        if (!stats.isDirectory()) continue;

        // Security check
        if (!isPathSafe(seriesPath, ROOT)) {
          logger.warn({ series: seriesTitle }, "Path traversal attempt detected");
          continue;
        }

        // Insert or get series
        await runQuery(
          `INSERT OR IGNORE INTO series (series_title, content_type_id, created_at)
           VALUES (?, ?, datetime('now'))`,
          [seriesTitle, typeId]
        );

        const seriesRow = await getRow(
          `SELECT series_id FROM series WHERE series_title = ?`,
          [seriesTitle]
        );

        if (!seriesRow) {
          logger.error({ series: seriesTitle }, "Failed to get series ID");
          continue;
        }

        const { series_id } = seriesRow;
        let seriesIngested = 0;

        // Process seasons
        const seasonDirs = await fs.readdir(seriesPath);

        for (const season of seasonDirs) {
          // Validate season format (s1, s2, etc.)
          if (!/^s\d+$/i.test(season)) {
            logger.debug({ season }, "Invalid season format, skipping");
            continue;
          }

          try {
            const seasonNumber = Number(season.slice(1));
            const seasonPath = path.join(seriesPath, season);
            const originalDir = path.join(seasonPath, "original");

            // Ensure original directory exists
            ensureDir(originalDir);

            let episodeNumber = 1;
            const episodeFiles = await fs.readdir(seasonPath);

            // Process episodes
            for (const file of episodeFiles) {
              try {
                const src = path.join(seasonPath, file);
                const stats = await fs.stat(src);

                // Skip directories and non-video files
                if (stats.isDirectory()) continue;
                if (!isValidVideoFile(file)) continue;

                const dest = path.join(originalDir, file);
                const rel = path.relative(ROOT, dest);

                // Check if already ingested
                const existingEpisode = await getRow(
                  `SELECT content_file_id FROM content_files WHERE original_path = ?`,
                  [rel]
                );

                if (existingEpisode) {
                  logger.debug(
                    { series: seriesTitle, season: seasonNumber, episode: episodeNumber },
                    "Episode already ingested"
                  );
                  episodeNumber++;
                  continue;
                }

                // Move file
                await fs.rename(src, dest);
                const fileSizeMB = getFileSizeMB(dest);

                // Insert content
                const contentResult = await runQuery(
                  `INSERT INTO content (content_title, content_type_id, content_kind, created_at)
                   VALUES (?, ?, 'video', datetime('now'))`,
                  [`${seriesTitle} S${seasonNumber}E${episodeNumber}`, typeId]
                );

                // Insert content file
                const fileResult = await runQuery(
                  `INSERT INTO content_files
                   (content_id, original_path, file_size_mb, processing_status, created_at)
                   VALUES (?, ?, ?, 'pending', datetime('now'))`,
                  [contentResult.lastID, rel, fileSizeMB]
                );

                // Insert series episode mapping
                await runQuery(
                  `INSERT INTO series_episodes
                   (series_id, season_number, episode_number, content_file_id)
                   VALUES (?, ?, ?, ?)`,
                  [series_id, seasonNumber, episodeNumber, fileResult.lastID]
                );

                logger.info(
                  {
                    series: seriesTitle,
                    season: seasonNumber,
                    episode: episodeNumber,
                    sizeMB: fileSizeMB
                  },
                  "✔ Episode ingested"
                );

                seriesIngested++;
                episodeNumber++;
              } catch (err) {
                logger.error(
                  { file, season, series: seriesTitle, err: err.message },
                  "Failed to ingest episode"
                );
                episodeNumber++;
              }
            }
          } catch (err) {
            logger.error(
              { season, series: seriesTitle, err: err.message },
              "Error processing season"
            );
          }
        }

        logger.info({ series: seriesTitle, episodes: seriesIngested }, "Series processing complete");
        totalIngested += seriesIngested;
      } catch (err) {
        logger.error({ series: seriesTitle, err: err.message }, "Error processing series");
      }
    }

    logger.info({ totalEpisodes: totalIngested }, "Series ingestion complete");
  } catch (err) {
    logger.error({ err: err.message }, "Error processing series directory");
  }
}

// ============================
// MAIN
// ============================
async function main() {
  try {
    await initDatabase();
    logger.info("📥 Content ingestion started");

    // Get all content types
    const contentTypes = await getAllRows(
      `SELECT content_type_id, content_type_name FROM content_types ORDER BY content_type_id`
    );

    if (contentTypes.length === 0) {
      logger.warn("No content types found in database");
    }

    // Process each content type
    for (const contentType of contentTypes) {
      try {
        if (contentType.content_type_name === "series") {
          await ingestSeries(contentType.content_type_id);
        } else {
          await ingestCategory(contentType.content_type_name, contentType.content_type_id);
        }
      } catch (err) {
        logger.error(
          { type: contentType.content_type_name, err: err.message },
          "Error processing content type"
        );
      }
    }

    logger.info("✅ Content ingestion complete");
  } catch (err) {
    logger.fatal({ err }, "Fatal error during ingestion");
    process.exit(1);
  } finally {
    if (db) {
      db.close((err) => {
        if (err) {
          logger.error({ err }, "Error closing database");
        } else {
          logger.info("Database closed");
        }
        process.exit(0);
      });
    }
  }
}

// Run main
main();