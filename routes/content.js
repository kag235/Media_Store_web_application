const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { verifyPasscode } = require("../passcode");

const router = express.Router();
const CONTENT_ROOT = path.join(__dirname, "..", "content");
const STREAM_SECRET = process.env.STREAM_SECRET || "supersecretkey";

/* ============================
   AUTH MIDDLEWARE
============================ */
function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.redirect(
      `/attendee/login?next=${encodeURIComponent(req.originalUrl)}`
    );
  }
  next();
}

/* ============================
   QUOTA HELPERS
============================ */
function checkQuota(userId) {
  return new Promise((resolve, reject) => {
    global.db.get(
      `SELECT user_quota_total_gb, used_quota_gb
       FROM user_quota WHERE user_id = ?`,
      [userId],
      (err, row) => {
        if (err || !row) return reject(err || new Error("Quota missing"));
        resolve({
          remainingGB: row.user_quota_total_gb - row.used_quota_gb,
          totalGB: row.user_quota_total_gb,
          usedGB: row.used_quota_gb
        });
      }
    );
  });
}

function deductQuota(userId, bytes) {
  const usedGB = bytes / (1024 ** 3);
  global.db.run(
    `UPDATE user_quota
     SET used_quota_gb = used_quota_gb + ?,
         user_quota_last_updated = CURRENT_TIMESTAMP
     WHERE user_id = ?`,
    [usedGB, userId]
  );
}

/* ============================
   STREAM TOKEN
============================ */
function generateStreamToken(userId, contentFileId) {
  const payload = `${userId}:${contentFileId}:${Date.now()}`;
  const sig = crypto
    .createHmac("sha256", STREAM_SECRET)
    .update(payload)
    .digest("hex");
  return Buffer.from(`${payload}:${sig}`).toString("base64");
}

function verifyStreamToken(token) {
  try {
    const decoded = Buffer.from(token, "base64").toString();
    const [userId, contentFileId, ts, sig] = decoded.split(":");

    const expected = crypto
      .createHmac("sha256", STREAM_SECRET)
      .update(`${userId}:${contentFileId}:${ts}`)
      .digest("hex");

    if (sig !== expected) return null;
    if (Date.now() - Number(ts) > 10 * 60 * 1000) return null;

    return { userId, contentFileId };
  } catch {
    return null;
  }
}

/* ============================
   LIST CONTENT BY TYPE
============================ */
router.get("/:type", requireLogin, async (req, res) => {
  const userId = req.session.user.user_id;
  const type = req.params.type;

  global.db.all(
    `
    SELECT
      c.content_id,
      c.content_title,
      c.content_kind,
      cf.content_file_id,
      cf.hls_path,
      cf.preview_path,
      cf.poster_path
    FROM content c
    JOIN content_types ct
      ON ct.content_type_id = c.content_type_id
    JOIN content_files cf
      ON cf.content_id = c.content_id
    WHERE ct.content_type_name = ?
      AND cf.processing_status = 'ready'
      AND cf.content_file_id = (
        SELECT MAX(content_file_id)
        FROM content_files
        WHERE content_id = c.content_id
      )
    ORDER BY c.content_title
    `,
    [type],
    async (err, rows) => {
      if (err) return res.status(500).send("DB error");

      const quota = await checkQuota(userId).catch(() => null);

      const items = rows.map(r => {
        const canUse = quota ? quota.remainingGB > 0 : false;
        return {
          contentId: r.content_id,
          title: r.content_title,
          contentKind: r.content_kind,
          poster: r.poster_path ? `/media/${r.poster_path}` : "/images/default-poster.png",
          preview: r.preview_path ? `/media/${r.preview_path}` : null,
          playerUrl: `/content/${type}/${r.content_id}`,
          downloadUrl: `/content/download/${r.content_id}`,
          canUse,
          reason: canUse ? null : "Quota exceeded"
        };
      });

      res.render("content_list", {
        contentTypeName: type,
        quota,
        items
      });
    }
  );
});

/* ============================
   PLAYER PAGE
============================ */
router.get("/:type/:contentId", requireLogin, async (req, res) => {
  const userId = req.session.user.user_id;
  const contentId = req.params.contentId;
  const type = req.params.type;

  global.db.get(
    `
    SELECT c.content_title, c.content_kind, c.content_type_id,
           cf.content_file_id, cf.hls_path, cf.original_path, cf.mime_type
    FROM content c
    JOIN content_files cf
      ON cf.content_id = c.content_id
    WHERE c.content_id = ?
      AND cf.processing_status = 'ready'
    ORDER BY cf.content_file_id DESC
    LIMIT 1
    `,
    [contentId],
    async (err, row) => {
      if (err || !row) return res.sendStatus(404);

      const quota = await checkQuota(userId).catch(() => null);

      res.render("content_player", {
        title: row.content_title,
        contentKind: row.content_kind,
        hlsUrl: row.hls_path
          ? `/content/hls/${row.content_file_id}/index.m3u8?token=${generateStreamToken(userId, row.content_file_id)}`
          : null,
        originalPath: row.original_path,
        mimeType: row.mime_type,
        contentTypeName: type,
        canUse: quota && quota.remainingGB > 0,
        reason: quota && quota.remainingGB <= 0 ? "Quota exceeded" : null
      });
    }
  );
});

/* ============================
   HLS SERVE (SECURE + QUOTA)
============================ */
router.get("/hls/:contentFileId/:file", requireLogin, async (req, res) => {
  const token = req.query.token;
  const auth = verifyStreamToken(token);

  if (!auth || auth.userId != req.session.user.user_id) return res.sendStatus(403);

  const row = await new Promise(resolve => {
    global.db.get(
      `SELECT hls_path FROM content_files WHERE content_file_id = ?`,
      [auth.contentFileId],
      (_, r) => resolve(r)
    );
  });

  if (!row || !row.hls_path) return res.sendStatus(404);

  const hlsDir = path.dirname(path.join(CONTENT_ROOT, row.hls_path));
  const absPath = path.join(hlsDir, req.params.file);

  if (!absPath.startsWith(hlsDir)) return res.sendStatus(403); // prevent path traversal
  if (!fs.existsSync(absPath)) return res.sendStatus(404);

  const sizeBytes = fs.statSync(absPath).size;
  const quota = await checkQuota(auth.userId);

  if (quota.remainingGB * 1024 ** 3 < sizeBytes) return res.status(403).send("Quota exceeded");

  deductQuota(auth.userId, sizeBytes);

  global.db.run(
    `INSERT INTO streaming_logs (user_id, content_file_id, data_used_mb, log_action)
     VALUES (?, ?, ?, 'stream')`,
    [auth.userId, auth.contentFileId, sizeBytes / (1024 * 1024)]
  );

  res.sendFile(absPath);
});

/* ============================
   DOWNLOAD ORIGINAL FILE
============================ */
router.get("/download/:contentId", requireLogin, async (req, res) => {
  const userId = req.session.user.user_id;

  global.db.get(
    `
    SELECT content_file_id, original_path, file_size_mb
    FROM content_files
    WHERE content_id = ?
    ORDER BY content_file_id DESC
    LIMIT 1
    `,
    [req.params.contentId],
    async (err, row) => {
      if (err || !row) return res.sendStatus(404);

      const absPath = path.join(CONTENT_ROOT, row.original_path);
      if (!fs.existsSync(absPath)) return res.sendStatus(404);

      const bytes = row.file_size_mb * 1024 * 1024;
      const quota = await checkQuota(userId);

      if (quota.remainingGB * 1024 ** 3 < bytes) return res.status(403).send("Quota exceeded");

      deductQuota(userId, bytes);

      global.db.run(
        `INSERT INTO streaming_logs (user_id, content_file_id, data_used_mb, log_action)
         VALUES (?, ?, ?, 'download')`,
        [userId, row.content_file_id, row.file_size_mb]
      );

      res.download(absPath);
    }
  );
});

module.exports = router;
