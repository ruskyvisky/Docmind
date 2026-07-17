// db.js - PostgreSQL Connection Pool
const { Pool } = require('pg');

const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    user: process.env.DB_USER || 'docmind',
    password: process.env.DB_PASSWORD || 'docmind_pass',
    database: process.env.DB_NAME || 'docmind_db',
});

pool.on('connect', () => {
    console.log(`[PostgreSQL] Connected to ${process.env.DB_HOST || 'localhost'} ✓`);
});

pool.on('error', (err) => {
    console.error('[PostgreSQL] Connection error:', err.message);
});

module.exports = pool;