const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const CONTENT_ROOT = path.join(__dirname, "..", "content");
const DB_PATH = path.join(__dirname, "..", "database.db");

const db = new sqlite3.Database(DB_PATH);

const ensureDir = d => fs.existsSync(d) || fs.mkdirSync(d, { recursive: true });
const all = (s,p=[]) => new Promise((r,j)=>db.all(s,p,(e,d)=>e?j(e):r(d)));

(async () => {
  console.log("📁 Syncing categories from DB");

  ensureDir(CONTENT_ROOT);

  const types = await all(
    `SELECT content_type_name FROM content_types`
  );

  for (const { content_type_name } of types) {
    ensureDir(path.join(CONTENT_ROOT, content_type_name));
    console.log(`✔ Category ensured: ${content_type_name}`);
  }

  db.close();
})();
