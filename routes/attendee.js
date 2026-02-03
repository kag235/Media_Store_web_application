const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');

const DEFAULT_QUOTA_GB = 10;

// -------------------------
// Middleware: Require Login
// -------------------------
function requireLogin(req, res, next) {
    if (!req.session.user) return res.redirect('/attendee/login');
    next();
}

// -------------------------
// SIGNUP
// -------------------------
router.get('/signup', (req, res) => res.render('signup'));

router.post('/signup', async (req, res) => {
    const { user_name, user_email, password } = req.body;
    if (!user_name || !user_email || !password)
        return res.render('signup', { error: 'All fields are required' });

    try {
        const hash = await bcrypt.hash(password, 10);
        global.db.run(
            `INSERT INTO users (user_name, user_email, user_password_hash)
             VALUES (?, ?, ?)`,
            [user_name, user_email, hash],
            function(err) {
                if (err) return res.render('signup', { error: 'Email already exists' });

                const userId = this.lastID;
                global.db.run(
                    `INSERT INTO user_quota (user_id, user_quota_total_gb, used_quota_gb)
                     VALUES (?, ?, 0)`,
                    [userId, DEFAULT_QUOTA_GB],
                    (err) => { if (err) console.error(err); }
                );

                res.redirect('/attendee/login');
            }
        );
    } catch {
        res.render('signup', { error: 'Server error' });
    }
});

// -------------------------
// LOGIN & LOGOUT
// -------------------------
router.get('/login', (req, res) => res.render('login'));

router.post('/login', (req, res) => {
    const { user_email, password } = req.body;
    global.db.get(
        `SELECT user_id, user_name, user_password_hash, user_status FROM users WHERE user_email = ?`,
        [user_email],
        async (err, user) => {
            if (err || !user) return res.render('login', { error: 'Email or password is incorrect' });

            const match = await bcrypt.compare(password, user.user_password_hash);
            if (!match) return res.render('login', { error: 'Email or password is incorrect' });

            req.session.user = {
                user_id: user.user_id,
                user_name: user.user_name,
                user_status: user.user_status
            };
            res.redirect('/attendee/dashboard');
        }
    );
});

router.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/attendee/login'));
});

// -------------------------
// DASHBOARD
// -------------------------
router.get('/dashboard', requireLogin, (req, res) => {
    renderDashboard(req, res);
});

// -------------------------
// REDEEM PASSCODE
// -------------------------
router.post('/redeem-passcode', requireLogin, (req, res) => {
    const userId = req.session.user.user_id;
    const inputCode = req.body.passcode?.trim().toUpperCase();

    if (!inputCode) return renderDashboard(req, res, "Please enter a passcode", false);

    global.db.get(`SELECT * FROM access_passcodes WHERE access_passcode = ?`, [inputCode], (err, row) => {
        if (err || !row) return renderDashboard(req, res, "Invalid passcode", false);
        if (row.access_passcode_is_used) return renderDashboard(req, res, "Passcode already used", false);

        const quotaToAdd = row.access_passcode_quota_gb;

        // Update user quota
        global.db.run(
            `UPDATE user_quota SET user_quota_total_gb = user_quota_total_gb + ? WHERE user_id = ?`,
            [quotaToAdd, userId],
            (err) => {
                if (err) return renderDashboard(req, res, "Error updating quota", false);

                // Mark passcode as used
                global.db.run(
                    `UPDATE access_passcodes
                     SET access_passcode_is_used = 1, access_passcode_used_by = ?, access_passcode_used_at = CURRENT_TIMESTAMP
                     WHERE access_passcode_id = ?`,
                    [userId, row.access_passcode_id],
                    (err) => {
                        if (err) return renderDashboard(req, res, "Error redeeming passcode", false);
                        renderDashboard(req, res, `Quota increased by ${quotaToAdd} GB!`, true);
                    }
                );
            }
        );
    });
});

// -------------------------
// DASHBOARD RENDER HELPER
// -------------------------
function renderDashboard(req, res, message = null, success = false) {
    const userId = req.session.user.user_id;

    global.db.get(`SELECT user_quota_total_gb, used_quota_gb FROM user_quota WHERE user_id = ?`, [userId], (err, quota) => {
        global.db.all(
            `SELECT ct.content_type_name, COUNT(c.content_id) AS total
             FROM content_types ct
             LEFT JOIN content c ON c.content_type_id = ct.content_type_id
             GROUP BY ct.content_type_id ORDER BY ct.content_type_name`,
            [],
            (err, categories) => {
                categories = categories || [];
                const remainingGB = quota ? Math.max(0, quota.user_quota_total_gb - quota.used_quota_gb) : 0;
                const usedPercentage = quota ? Math.min(100, (quota.used_quota_gb / quota.user_quota_total_gb) * 100) : 0;

                res.render('dashboard', {
                    user: req.session.user,
                    quota: quota ? {
                        totalGB: quota.user_quota_total_gb,
                        usedGB: quota.used_quota_gb,
                        remainingGB,
                        usedPercentage
                    } : null,
                    categories,
                    redeemMessage: message,
                    redeemSuccess: success
                });
            }
        );
    });
}

module.exports = router;
