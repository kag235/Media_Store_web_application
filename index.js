const express = require('express');
const app = express();
const morgan = require('morgan');
const session = require('express-session');
const { Pool } = require('pg');
const dotenv = require('dotenv');

// Load environment variables from .env file
dotenv.config();

// Environment Variable Validation
const REQUIRED_ENV_VARS = ['DB_USER', 'DB_PASSWORD', 'DB_NAME', 'SESSION_SECRET'];
for (const varName of REQUIRED_ENV_VARS) {
    if (!process.env[varName]) {
        console.error(`Environment variable ${varName} is not defined`);
        process.exit(1);
    }
}

// Database Connection Pooling
const pool = new Pool({
    user: process.env.DB_USER,
    host: 'localhost',
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: 5432,
});

// Middleware Setup
app.use(morgan('dev')); // Request logging
app.use(express.json()); // Parse JSON requests

// Session security
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: { secure: true }, // Use secure cookies
}));

// Error Handling Middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send('Something went wrong!');
});

// Graceful Shutdown
const shutdown = () => {
    console.log('Shutting down gracefully...');
    pool.end(() => {
        console.log('Database pool closed.');
        process.exit(0);
    });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Health Check Endpoint
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Error Pages
app.use((req, res) => {
    res.status(404).send('Sorry, page not found!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});