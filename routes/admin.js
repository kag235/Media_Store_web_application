const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { issuePasscode } = require('../passcode');

const SALT_ROUNDS = 12;

// -------------------------
// Middleware: Require Admin
// -------------------------
function requireAdmin(req, res, next) {
    if (req.session.adminId) return next();
    res.redirect('/admin/login');
}

// -------------------------
// ADMIN REGISTRATION
// -------------------------
router.get('/register', (req, res) => {
    res.render('admin-register');
});

router.post('/register', async (req, res) => {
    const { username, password, secret } = req.body;
    if (!username || !password || !secret)
        return res.render('admin-register', { error: 'All fields are required' });

    if (secret !== process.env.ADMIN_SECRET)
        return res.render('admin-register', { error: 'Invalid admin secret code' });

    try {
        const hash = await bcrypt.hash(password, SALT_ROUNDS);
        global.db.run(
            `INSERT INTO admin_users (admin_user_name, admin_user_password_hash) VALUES (?, ?)`,
            [username, hash],
            function(err) {
                if (err) {
                    if (err.message.includes('UNIQUE')) return res.render('admin-register', { error: 'Username already exists' });
                    return res.render('admin-register', { error: 'Database error' });
                }
                res.redirect('/admin/login');
            }
        );
    } catch (err) {
        console.error(err);
        res.render('admin-register', { error: 'Server error' });
    }
});

// -------------------------
// ADMIN LOGIN & LOGOUT
// -------------------------
router.get('/login', (req, res) => res.render('admin-login'));

router.post('/login', (req, res) => {
    const { username, password } = req.body;
    global.db.get(
        `SELECT admin_id, admin_user_password_hash FROM admin_users WHERE admin_user_name = ?`,
        [username],
        async (err, row) => {
            if (err || !row) return res.render('admin-login', { error: 'Invalid username or password' });

            const match = await bcrypt.compare(password, row.admin_user_password_hash);
            if (!match) return res.render('admin-login', { error: 'Invalid username or password' });

            req.session.adminId = row.admin_id;
            res.redirect('/admin/passcodes');
        }
    );
});

router.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/admin/login'));
});

// -------------------------
// PASSCODES DASHBOARD
// -------------------------
router.get('/passcodes', requireAdmin, (req, res) => {
    global.db.all(
        `SELECT access_passcode, access_passcode_quota_gb, access_passcode_is_used,
                access_passcode_issued_at, access_passcode_expires_at
         FROM access_passcodes
         ORDER BY access_passcode_issued_at DESC
         LIMIT 50`,
        [],
        (err, rows) => {
            if (err) return res.status(500).send('DB error');
            res.render('admin-passcodes', { passcodes: rows });
        }
    );
});

// -------------------------
// GENERATE NEW PASSCODE
// -------------------------
router.post('/passcodes/generate', requireAdmin, async (req, res) => {
    try {
        const adminId = req.session.adminId;
        const quotaGb = parseFloat(req.body.quota_gb) || 5;
        const expiresDays = parseInt(req.body.expires_days) || 30;

        const newCode = await issuePasscode(adminId, quotaGb, expiresDays);

        res.json({ success: true, passcode: newCode });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Error generating passcode' });
    }
});

// -------------------------
// PASSCODES JSON API
// -------------------------
router.get('/passcodes/json', requireAdmin, (req, res) => {
    global.db.all(
        `SELECT access_passcode, access_passcode_quota_gb, access_passcode_is_used,
                access_passcode_issued_at, access_passcode_expires_at
         FROM access_passcodes
         ORDER BY access_passcode_issued_at DESC
         LIMIT 50`,
        [],
        (err, rows) => {
            if (err) return res.status(500).json([]);
            res.json(rows);
        }
    );
});

module.exports = router;
