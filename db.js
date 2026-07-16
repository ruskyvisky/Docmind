const { Pool } = require('pg');

const pool = new Pool({
    host: 'localhost',
    port: 5432,
    user: 'docmind',
    password: 'docmind_pass',
    database: 'docmind_db',
});

module.exports = pool;