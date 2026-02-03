const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const ROOT = path.join(__dirname, "..", "content");
const DB = path.join(__dirname, "..", "database.db");

const db = new sqlite3.Database(DB);

const run = (s,p=[]) => new Promise((r,j)=>db.run(s,p,function(e){e?j(e):r(this)}));
const get = (s,p=[]) => new Promise((r,j)=>db.get(s,p,(e,d)=>e?j(e):r(d)));
const all = (s,p=[]) => new Promise((r,j)=>db.all(s,p,(e,d)=>e?j(e):r(d)));

const ensureDir = d => fs.existsSync(d) || fs.mkdirSync(d,{recursive:true});
const sizeMB = f => +(fs.statSync(f).size / 1048576).toFixed(2);

/* ============================
   NORMAL CONTENT
============================ */
async function ingestCategory(typeName, typeId) {
  const base = path.join(ROOT, typeName);
  if (!fs.existsSync(base)) return;

  for (const f of fs.readdirSync(base)) {
    const src = path.join(base, f);
    if (!fs.statSync(src).isFile()) continue;

    const title = path.parse(f).name;
    const dest = path.join(base, title, "original", f);
    const rel = path.relative(ROOT, dest);

    const exists = await get(
      `SELECT 1 FROM content_files WHERE original_path=?`,
      [rel]
    );
    if (exists) continue;

    ensureDir(path.dirname(dest));
    fs.renameSync(src, dest);

    const c = await run(
      `INSERT INTO content (content_title, content_type_id, content_kind)
       VALUES (?, ?, 'video')`,
      [title, typeId]
    );

    await run(
      `INSERT INTO content_files
       (content_id, original_path, file_size_mb, processing_status)
       VALUES (?, ?, ?, 'pending')`,
      [c.lastID, rel, sizeMB(dest)]
    );

    console.log(`✔ Ingested ${typeName}: ${title}`);
  }
}

/* ============================
   SERIES (MANUAL SEASONS)
============================ */
async function ingestSeries(typeId) {
  const root = path.join(ROOT, "series");
  if (!fs.existsSync(root)) return;

  for (const seriesTitle of fs.readdirSync(root)) {
    const seriesPath = path.join(root, seriesTitle);
    if (!fs.statSync(seriesPath).isDirectory()) continue;

    await run(
      `INSERT OR IGNORE INTO series (series_title, content_type_id)
       VALUES (?, ?)`,
      [seriesTitle, typeId]
    );

    const { series_id } = await get(
      `SELECT series_id FROM series WHERE series_title=?`,
      [seriesTitle]
    );

    for (const season of fs.readdirSync(seriesPath)) {
      if (!/^s\d+$/i.test(season)) continue;

      const seasonNumber = Number(season.slice(1));
      const seasonPath = path.join(seriesPath, season);
      const originalDir = path.join(seasonPath, "original");
      ensureDir(originalDir);

      let ep = 1;

      for (const file of fs.readdirSync(seasonPath)) {
        const src = path.join(seasonPath, file);
        if (!fs.statSync(src).isFile()) continue;

        const dest = path.join(originalDir, file);
        const rel = path.relative(ROOT, dest);

        const exists = await get(
          `SELECT 1 FROM content_files WHERE original_path=?`,
          [rel]
        );
        if (exists) { ep++; continue; }

        fs.renameSync(src, dest);

        const c = await run(
          `INSERT INTO content (content_title, content_type_id, content_kind)
           VALUES (?, ?, 'video')`,
          [`${seriesTitle} S${seasonNumber}E${ep}`, typeId]
        );

        const cf = await run(
          `INSERT INTO content_files
           (content_id, original_path, file_size_mb, processing_status)
           VALUES (?, ?, ?, 'pending')`,
          [c.lastID, rel, sizeMB(dest)]
        );

        await run(
          `INSERT INTO series_episodes
           (series_id, season_number, episode_number, content_file_id)
           VALUES (?, ?, ?, ?)`,
          [series_id, seasonNumber, ep++, cf.lastID]
        );

        console.log(`✔ ${seriesTitle} S${seasonNumber}E${ep - 1}`);
      }
    }
  }
}

/* ============================
   MAIN
============================ */
(async () => {
  console.log("📥 Ingestion started");

  const types = await all(
    `SELECT content_type_id, content_type_name FROM content_types`
  );

  for (const t of types) {
    t.content_type_name === "series"
      ? await ingestSeries(t.content_type_id)
      : await ingestCategory(t.content_type_name, t.content_type_id);
  }

  console.log("✅ Ingestion complete");
  db.close();
})();
