// Add this to the top of your index.js file to fix broken DATABASE_URL

// Fix DATABASE_URL if it contains newlines
if (process.env.DATABASE_URL) {
  process.env.DATABASE_URL = process.env.DATABASE_URL.replace(/\s+/g, '');
  console.log('DATABASE_URL cleaned');
}

// Or use a hardcoded backup
const DATABASE_URL = process.env.DATABASE_URL?.replace(/\s+/g, '') || 
  'postgresql://fridge_podge_sql_user:PXisVbka1KQlP7n1MhAXJk6XwgTNL9xg@dpg-d1dgr1umcj7s73f90190-a.oregon-postgres.render.com/fridge_podge_sql';

// Update your Pool configuration
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});