/**
 * index.js
 * Main app entry point
 */

const express = require('express');
const app = express();
const port = 3000;
const path = require('path');

const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const sqlite3 = require('sqlite3').verbose();
require('dotenv').config();

/* ============================
   MIDDLEWARE (ORDER MATTERS)
============================ */

// Body parsers
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Sessions
app.use(session({
    store: new SQLiteStore({ db: 'sessions.db' }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 2 }
}));

// Make session user available to EJS
app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    next();
});

// View engine & static files
app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));

/* ============================
   DATABASE
============================ */

global.db = new sqlite3.Database('./database.db', err => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log("Database connected");
    global.db.run("PRAGMA foreign_keys=ON");
});

/* ============================
   ROUTES
============================ */

app.get('/', (req, res) => {
    res.render('index');
});

app.use('/attendee', require('./routes/attendee'));
app.use('/content', require('./routes/content'));
app.use('/admin', require('./routes/admin'));
app.use('/admin', require('./routes/content-upload')); // ✅ FIXED

/* ============================
   SERVER
============================ */

app.listen(port, () => {
    console.log(`App listening on port ${port}`);
});
