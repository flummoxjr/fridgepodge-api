const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const NodeCache = require('node-cache');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// In-memory cache (can be replaced with Redis)
const cache = new NodeCache({ stdTTL: process.env.CACHE_TTL || 3600 });

// Trust proxy for Render deployment
app.set('trust proxy', true);

// Middleware
app.use(helmet());
app.use(compression());
app.use(cors());
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use('/api/', limiter);

// Root route
app.get('/', (req, res) => {
  res.json({ 
    service: 'FridgePodge Recipe API',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      health: '/health',
      recipeMatch: 'POST /api/recipes/match',
      recipeById: 'GET /api/recipes/:id',
      rateRecipe: 'POST /api/recipes/:id/rate'
    }
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Recipe matching endpoint
app.post('/api/recipes/match', async (req, res) => {
  try {
    const { ingredients, dietary, cuisine, deviceId } = req.body;
    
    if (!ingredients || !Array.isArray(ingredients) || ingredients.length === 0) {
      return res.status(400).json({ error: 'Ingredients array required' });
    }

    // Create cache key
    const cacheKey = `match:${ingredients.sort().join(',')}:${dietary||''}:${cuisine||''}`;
    
    // Check cache first
    const cachedResult = cache.get(cacheKey);
    if (cachedResult) {
      console.log('Cache hit:', cacheKey);
      return res.json(cachedResult);
    }

    // Get previously used recipes for this device
    let usedRecipeIds = [];
    if (deviceId) {
      const usedRecipes = await pool.query(
        'SELECT DISTINCT recipe_id FROM recipe_usage WHERE device_id = $1 AND used_at > NOW() - INTERVAL \'7 days\'',
        [deviceId]
      );
      usedRecipeIds = usedRecipes.rows.map(r => r.recipe_id);
    }

    // Build the matching query
    const matchQuery = `
      WITH user_ingredients AS (
        SELECT LOWER(unnest($1::text[])) as ingredient
      ),
      recipe_matches AS (
        SELECT 
          r.id,
          r.title,
          r.cuisine,
          r.servings,
          r.prep_time,
          r.cook_time,
          r.difficulty,
          COUNT(DISTINCT CASE WHEN ri.is_required THEN i.id END) as required_count,
          COUNT(DISTINCT CASE WHEN ri.is_required AND ui.ingredient IS NOT NULL THEN i.id END) as required_matched,
          COUNT(DISTINCT CASE WHEN NOT ri.is_required AND ui.ingredient IS NOT NULL THEN i.id END) as optional_matched,
          ARRAY_AGG(DISTINCT i.name) FILTER (WHERE ri.is_required) as required_ingredients,
          COUNT(DISTINCT ui.ingredient) as user_ingredient_count
        FROM recipes r
        JOIN recipe_ingredients ri ON r.id = ri.recipe_id
        JOIN ingredients i ON ri.ingredient_id = i.id
        LEFT JOIN ingredient_aliases ia ON i.id = ia.ingredient_id
        LEFT JOIN user_ingredients ui ON (
          LOWER(i.name) LIKE '%' || ui.ingredient || '%' OR
          ui.ingredient LIKE '%' || LOWER(i.name) || '%' OR
          LOWER(ia.alias) LIKE '%' || ui.ingredient || '%' OR
          ui.ingredient LIKE '%' || LOWER(ia.alias) || '%'
        )
        WHERE ($2::text IS NULL OR r.cuisine = $2)
          AND r.id != ALL($3::int[])
        GROUP BY r.id, r.title, r.cuisine, r.servings, r.prep_time, r.cook_time, r.difficulty
      ),
      scored_recipes AS (
        SELECT 
          *,
          CASE 
            WHEN required_count = 0 THEN 100.0
            ELSE (required_matched::float / required_count::float) * 70
          END +
          (optional_matched::float * 5) +
          CASE 
            WHEN user_ingredient_count > 0 
            THEN (required_matched + optional_matched)::float / user_ingredient_count::float * 30
            ELSE 0
          END as match_score
        FROM recipe_matches
        WHERE required_count = 0 OR (required_matched::float / required_count::float) >= 0.6
      )
      SELECT * FROM scored_recipes
      ORDER BY match_score DESC
      LIMIT 1;
    `;

    const result = await pool.query(matchQuery, [
      ingredients.map(i => i.toLowerCase()),
      cuisine || null,
      usedRecipeIds
    ]);

    if (result.rows.length === 0) {
      return res.json({ found: false });
    }

    const recipe = result.rows[0];

    // Get full recipe details
    const [ingredientsResult, instructionsResult, nutritionResult, tagsResult] = await Promise.all([
      pool.query(`
        SELECT i.name, ri.amount, ri.unit, ri.is_required, ri.notes
        FROM recipe_ingredients ri
        JOIN ingredients i ON ri.ingredient_id = i.id
        WHERE ri.recipe_id = $1
        ORDER BY ri.is_required DESC, i.name
      `, [recipe.id]),
      
      pool.query(`
        SELECT step_number, instruction
        FROM recipe_instructions
        WHERE recipe_id = $1
        ORDER BY step_number
      `, [recipe.id]),
      
      pool.query(`
        SELECT calories, protein, carbs, fat, fiber, sugar, sodium
        FROM recipe_nutrition
        WHERE recipe_id = $1
      `, [recipe.id]),
      
      pool.query(`
        SELECT dt.name
        FROM recipe_dietary_tags rdt
        JOIN dietary_tags dt ON rdt.dietary_tag_id = dt.id
        WHERE rdt.recipe_id = $1
      `, [recipe.id])
    ]);

    const fullRecipe = {
      found: true,
      recipe: {
        id: recipe.id,
        title: recipe.title,
        cuisine: recipe.cuisine,
        servings: recipe.servings,
        prepTime: recipe.prep_time,
        cookTime: recipe.cook_time,
        difficulty: recipe.difficulty,
        matchScore: recipe.match_score,
        ingredients: ingredientsResult.rows.map(i => ({
          name: i.name,
          amount: i.amount,
          unit: i.unit,
          required: i.is_required,
          notes: i.notes
        })),
        instructions: instructionsResult.rows.map(i => i.instruction),
        nutrition: nutritionResult.rows[0] || null,
        dietaryTags: tagsResult.rows.map(t => t.name)
      }
    };

    // Cache the result
    cache.set(cacheKey, fullRecipe);

    // Log usage
    if (deviceId) {
      pool.query(
        'INSERT INTO recipe_usage (recipe_id, device_id) VALUES ($1, $2)',
        [recipe.id, deviceId]
      ).catch(err => console.error('Failed to log usage:', err));
    }

    res.json(fullRecipe);

  } catch (error) {
    console.error('Recipe matching error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get recipe by ID
app.get('/api/recipes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Similar to above, get full recipe details
    // ... (implementation similar to match endpoint)
    
    res.json({ recipe: fullRecipe });
  } catch (error) {
    console.error('Get recipe error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Rate a recipe
app.post('/api/recipes/:id/rate', async (req, res) => {
  try {
    const { id } = req.params;
    const { rating, deviceId } = req.body;
    
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be between 1 and 5' });
    }

    await pool.query(
      'UPDATE recipe_usage SET rating = $1 WHERE recipe_id = $2 AND device_id = $3 AND used_at = (SELECT MAX(used_at) FROM recipe_usage WHERE recipe_id = $2 AND device_id = $3)',
      [rating, id, deviceId]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Rate recipe error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start server
app.listen(port, () => {
  console.log(`FridgePodge API server running on port ${port}`);
});