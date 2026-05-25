const express = require('express');
const pg = require('pg');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3001;
const API_PORT = process.env.API_PORT || 3000;

// Create a connection pool
const pool = new pg.Pool({
  user: process.env.PGUSER || 'postgres',
  host: process.env.PGHOST || 'localhost',
  database: process.env.PGDATABASE || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
  port: process.env.PGPORT || 5432,
});

// Middleware
app.use(express.json());

// API route
app.get('/api/quote', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT quote FROM quotes ORDER BY RANDOM() LIMIT 1');
    if (rows.length > 0) {
      res.json({ quote: rows[0].quote });
    } else {
      res.json({ quote: 'No quotes available' });
    }
  } catch (error) {
    console.error('Error fetching quote:', error);
    res.status(500).json({ error: 'Failed to fetch quote' });
  }
});

// Serve static assets from the client build directory
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, 'client/build')));
  
  // Handle React routing, return all requests to React app
  app.get('*', (req, res) => {
    res.sendFile(path.resolve(__dirname, 'client/build', 'index.html'));
  });
}

// Start API server
app.listen(API_PORT, () => {
  console.log(`API server running on port ${API_PORT}`);
});

// Export app for docker-compose
module.exports = { app, pool };
