const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const multer = require("multer");

const CONTENT_ROOT = path.join(__dirname, "..", "content");

// -------------------------
// Middleware: Require Admin
// -------------------------
function requireAdmin(req, res, next) {
    if (!req.session.adminId) return res.redirect("/admin/login");
    next();
}

// -------------------------
// Multer config
// -------------------------
const upload = multer({ dest: path.join(CONTENT_ROOT, "temp_uploads") });
fs.mkdirSync(path.join(CONTENT_ROOT, "temp_uploads"), { recursive: true });

// -------------------------
// Helpers
// -------------------------
function ensureCategoryFolders(category) {
    const originalsDir = path.join(CONTENT_ROOT, category, "originals");
    if (!fs.existsSync(originalsDir)) fs.mkdirSync(originalsDir, { recursive: true });
    return originalsDir;
}

// -------------------------
// POST Upload
// -------------------------
router.post("/content-upload", requireAdmin, upload.single("file"), (req, res) => {
    const { title, description, category } = req.body;
    const file = req.file;

    if (!title || !category || !file) {
        return res.status(400).send("All fields are required");
    }

    try {
        // Ensure originals folder exists
        const originalsDir = ensureCategoryFolders(category);

        // Move file to originals folder
        const destPath = path.join(originalsDir, file.originalname);
        fs.renameSync(file.path, destPath);

        // Get content type ID from DB
        global.db.get(
            "SELECT content_type_id FROM content_types WHERE content_type_name = ?",
            [category],
            (err, row) => {
                if (err || !row) return res.status(400).send("Invalid category");

                const contentTypeId = row.content_type_id;
                const sizeMB = fs.statSync(destPath).size / (1024 * 1024);

                // Insert into content table
                global.db.run(
                    `INSERT INTO content 
                     (content_title, content_description, content_type_id, content_file_size_mb) 
                     VALUES (?, ?, ?, ?)`,
                    [title, description, contentTypeId, sizeMB],
                    function (err) {
                        if (err) return res.status(500).send("DB insert failed");

                        const contentId = this.lastID;

                        // Insert initial content_files record as pending
                        global.db.run(
                            `INSERT INTO content_files
                             (content_id, original_path, processing_status, file_size_mb)
                             VALUES (?, ?, 'pending', ?)`,
                            [contentId, path.relative(CONTENT_ROOT, destPath), sizeMB],
                            (err) => {
                                if (err) return res.status(500).send("DB insert failed for content_files");
                                res.send(`✅ Upload successful! Content ID: ${contentId}. Processing will be handled in background.`);
                            }
                        );
                    }
                );
            }
        );
    } catch (err) {
        console.error(err);
        res.status(500).send(`❌ Upload failed: ${err.message}`);
    }
});
router.get('/content-upload', requireAdmin, (req, res) => {
    global.db.all(
        `SELECT content_type_name FROM content_types ORDER BY content_type_name`,
        [],
        (err, categories) => {
            if (err) categories = [];
            res.render('admin-upload', { categories });
        }
    );
});

module.exports = router;
