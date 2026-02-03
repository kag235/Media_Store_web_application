const sqlite3 = require('sqlite3').verbose();

// -------------------------
// CONFIG
// -------------------------
const PASSCODE_LENGTH_PART = 4;
const PASSCODE_SEPARATOR = '-';

// -------------------------
// GENERATE RANDOM PART
// -------------------------
function randomPart(length = 4) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

// -------------------------
// GENERATE FULL PASSCODE
// -------------------------
function generatePasscode() {
    return `${randomPart(PASSCODE_LENGTH_PART)}${PASSCODE_SEPARATOR}${randomPart(PASSCODE_LENGTH_PART)}`;
}

// -------------------------
// CHECK IF PASSCODE EXISTS
// -------------------------
function passcodeExists(db, code) {
    return new Promise((resolve, reject) => {
        db.get('SELECT 1 FROM access_passcodes WHERE access_passcode = ?', [code], (err, row) => {
            if (err) reject(err);
            resolve(!!row);
        });
    });
}

// -------------------------
// GENERATE UNIQUE PASSCODE
// -------------------------
async function generateUniquePasscode(db) {
    const MAX_ATTEMPTS = 1000;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
        const code = generatePasscode();
        const exists = await passcodeExists(db, code);
        if (!exists) return code;
    }
    throw new Error('Could not generate unique passcode');
}

// -------------------------
// ISSUE PASSCODE
// -------------------------
async function issuePasscode(adminId, quotaGb, expiresDays = null) {
    const db = new sqlite3.Database('./database.db'); // your SQLite DB
    const code = await generateUniquePasscode(db);

    let expiresAt = null;
    if (expiresDays) {
        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + expiresDays);
        expiresAt = expiryDate.toISOString();
    }

    return new Promise((resolve, reject) => {
        db.run(
            `INSERT INTO access_passcodes 
            (access_passcode, access_passcode_quota_gb, access_passcode_issued_by, access_passcode_expires_at) 
            VALUES (?, ?, ?, ?)`,
            [code, quotaGb, adminId, expiresAt],
            function (err) {
                db.close();
                if (err) return reject(err);
                resolve(code);
            }
        );
    });
}

module.exports = { issuePasscode };
