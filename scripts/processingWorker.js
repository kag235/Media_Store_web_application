const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const sqlite3 = require("sqlite3").verbose();

const CONTENT_ROOT = path.join(__dirname, "..", "content");
const DB_PATH = path.join(__dirname, "..", "database.db");

const db = new sqlite3.Database(DB_PATH);

const get = (s,p=[]) => new Promise((r,j)=>db.get(s,p,(e,d)=>e?j(e):r(d)));
const run = (s,p=[]) => new Promise((r,j)=>db.run(s,p,function(e){e?j(e):r(this)}));

const ensureDir = d => fs.existsSync(d) || fs.mkdirSync(d,{recursive:true});
const exec = c => execSync(c,{stdio:"inherit"});

(async () => {
  console.log("⚙ Episode-level processing worker started");

  while (true) {
    const row = await get(`
      SELECT *
      FROM content_files
      WHERE processing_status IN ('pending','failed')
      ORDER BY created_at
      LIMIT 1
    `);

    if (!row) break;

    try {
      await run(
        `UPDATE content_files
         SET processing_status='processing'
         WHERE content_file_id=?`,
        [row.content_file_id]
      );

      const src = path.join(CONTENT_ROOT, row.original_path);
      if (!fs.existsSync(src)) throw new Error("Original file missing");

      const episodeDir = path.resolve(src, "..", ".."); // <episode>
      const base = path.basename(src, path.extname(src));

      const hlsDir = path.join(episodeDir, "hls");
      const previewDir = path.join(episodeDir, "preview");
      const posterDir = path.join(episodeDir, "poster");

      ensureDir(hlsDir);
      ensureDir(previewDir);
      ensureDir(posterDir);

      const hlsOut = path.join(hlsDir, `${base}.m3u8`);
      const previewOut = path.join(previewDir, `${base}.mp4`);
      const posterOut = path.join(posterDir, `${base}.jpg`);

      if (fs.existsSync(hlsOut) && fs.existsSync(previewOut) && fs.existsSync(posterOut)) {
        await run(
          `UPDATE content_files
           SET hls_path=?, preview_path=?, poster_path=?, processing_status='ready'
           WHERE content_file_id=?`,
          [
            path.relative(CONTENT_ROOT, hlsOut),
            path.relative(CONTENT_ROOT, previewOut),
            path.relative(CONTENT_ROOT, posterOut),
            row.content_file_id
          ]
        );
        continue;
      }

      exec(`ffmpeg -y -i "${src}" -map 0:v -map 0:a -f hls "${hlsOut}"`);
      exec(`ffmpeg -y -i "${src}" -t 30 "${previewOut}"`);
      exec(`ffmpeg -y -ss 5 -i "${src}" -frames:v 1 "${posterOut}"`);

      await run(
        `UPDATE content_files SET
          hls_path=?,
          preview_path=?,
          poster_path=?,
          processing_status='ready'
         WHERE content_file_id=?`,
        [
          path.relative(CONTENT_ROOT, hlsOut),
          path.relative(CONTENT_ROOT, previewOut),
          path.relative(CONTENT_ROOT, posterOut),
          row.content_file_id
        ]
      );

      console.log(`✔ Processed ${row.original_path}`);
    } catch (e) {
      await run(
        `UPDATE content_files SET processing_status='failed'
         WHERE content_file_id=?`,
        [row.content_file_id]
      );
      console.error("✖ Worker error:", e.message);
    }
  }

  console.log("✅ Worker finished");
  db.close();
})();
