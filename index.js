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

// Fix DATABASE_URL if it contains newlines or spaces
let DATABASE_URL = process.env.DATABASE_URL || '';

// Remove ALL whitespace including newlines from the URL
DATABASE_URL = DATABASE_URL.replace(/[\s\n\r]+/g, '');

// If still broken or empty, use hardcoded URL
if (!DATABASE_URL || DATABASE_URL.includes('dpg-d1dgr1umcj7s73f9019') && !DATABASE_URL.includes('dpg-d1dgr1umcj7s73f90190')) {
  console.log('Using hardcoded DATABASE_URL due to corruption');
  DATABASE_URL = 'postgresql://fridge_podge_sql_user:PXisVbka1KQlP7n1MhAXJk6XwgTNL9xg@dpg-d1dgr1umcj7s73f90190-a.oregon-postgres.render.com/fridge_podge_sql';
}

console.log('Database URL first 50 chars:', DATABASE_URL.substring(0, 50));
console.log('Database URL last 50 chars:', DATABASE_URL.substring(DATABASE_URL.length - 50));
console.log('Database URL length:', DATABASE_URL.length); // Should be 162 characters

// PostgreSQL connection
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// In-memory cache (can be replaced with Redis)
const cache = new NodeCache({ stdTTL: process.env.CACHE_TTL || 3600 });

// Test database connection on startup
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('Database connection failed:', err.message);
    console.error('Please check DATABASE_URL environment variable in Render dashboard');
  } else {
    console.log('Database connected successfully at:', res.rows[0].now);
  }
});

// Trust proxy for Render deployment - specific to Render's proxy
app.set('trust proxy', 1); // Trust first proxy only

// Middleware
app.use(helmet());
app.use(compression());
app.use(cors());
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many requests, please try again later.'
    });
  }
});
app.use('/api/', limiter);

// Helper function to parse ingredient strings
function parseIngredient(ingredientStr) {
  const measurementPattern = /^(\d+(?:\/\d+)?(?:\.\d+)?)\s*(cup|cups|tablespoon|tablespoons|tbsp|teaspoon|teaspoons|tsp|pound|pounds|lb|lbs|ounce|ounces|oz|gram|grams|g|kilogram|kilograms|kg|liter|liters|l|milliliter|milliliters|ml|piece|pieces|clove|cloves|can|cans|package|packages|bunch|bunches)?\s*(.+?)(?:,\s*(.+))?$/i;
  
  const match = ingredientStr.match(measurementPattern);
  
  if (match) {
    return {
      amount: parseFloat(match[1]),
      unit: match[2] || 'unit',
      name: match[3].trim(),
      preparation: match[4] || null
    };
  }
  
  return {
    amount: null,
    unit: null,
    name: ingredientStr.trim(),
    preparation: null
  };
}

// Extract core ingredient name (remove descriptors)
function getCoreIngredient(ingredientName) {
  const cleaned = ingredientName
    .toLowerCase()
    .replace(/\b(fresh|dried|frozen|canned|cooked|raw|whole|ground|minced|diced|chopped|sliced)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  
  const mappings = {
    'chicken breast': 'chicken',
    'chicken thighs': 'chicken',
    'chicken wings': 'chicken',
    'ground beef': 'beef',
    'beef steak': 'beef',
    'white rice': 'rice',
    'brown rice': 'rice',
    'jasmine rice': 'rice',
    'basmati rice': 'rice'
  };
  
  return mappings[cleaned] || cleaned;
}

// Root route
app.get('/', (req, res) => {
  res.json({ 
    service: 'FridgePodge Recipe API',
    version: '1.1.0',
    status: 'running',
    endpoints: {
      health: '/health',
      recipeMatch: 'POST /api/recipes/match',
      saveFavorite: 'POST /api/recipes/save-favorite',
      popular: 'GET /api/recipes/popular',
      recipeById: 'GET /api/recipes/:id',
      rateRecipe: 'POST /api/recipes/:id/rate'
    }
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Database health check
app.get('/db-health', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW() as time, COUNT(*) as tables FROM information_schema.tables WHERE table_schema = \'public\'');
    res.json({ 
      status: 'connected',
      time: result.rows[0].time,
      tables: result.rows[0].tables,
      url_length: DATABASE_URL.length,
      url_preview: DATABASE_URL.substring(0, 30) + '...' + DATABASE_URL.substring(DATABASE_URL.length - 30)
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'error',
      message: error.message,
      hostname: error.hostname || 'unknown',
      env_set: !!process.env.DATABASE_URL,
      using_fallback: !process.env.DATABASE_URL || process.env.DATABASE_URL.includes('dpg-d1dgr1umcj7s73f9019')
    });
  }
});

// Recipe matching endpoint
app.post('/api/recipes/match', async (req, res) => {
  try {
    const { ingredients, dietary, cuisine, deviceId } = req.body;
    
    if (!ingredients || !Array.isArray(ingredients) || ingredients.length === 0) {
      return res.status(400).json({ error: 'Ingredients array required' });
    }

    // Extract core ingredients from user input
    const coreIngredients = ingredients.map(ing => getCoreIngredient(ing.toLowerCase()));

    // Create cache key
    const cacheKey = `match:${coreIngredients.sort().join(',')}:${dietary||''}:${cuisine||''}`;
    
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

    // Simple matching query
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
          r.average_rating,
          r.rating_count,
          COUNT(DISTINCT i.id) as matched_ingredients,
          COUNT(DISTINCT ri.ingredient_id) as total_ingredients
        FROM recipes r
        JOIN recipe_ingredients ri ON r.id = ri.recipe_id
        JOIN ingredients i ON ri.ingredient_id = i.id
        JOIN user_ingredients ui ON LOWER(i.name) = ui.ingredient
        WHERE r.id != ALL($2::int[])
        GROUP BY r.id, r.title, r.cuisine, r.servings, r.prep_time, r.cook_time, r.difficulty, r.average_rating, r.rating_count
        HAVING COUNT(DISTINCT i.id) >= GREATEST(1, COUNT(DISTINCT ri.ingredient_id) * 0.5)
      )
      SELECT * FROM recipe_matches
      ORDER BY matched_ingredients DESC, average_rating DESC
      LIMIT 1;
    `;

    const result = await pool.query(matchQuery, [
      coreIngredients,
      usedRecipeIds
    ]);

    if (result.rows.length === 0) {
      return res.json({ found: false });
    }

    const recipe = result.rows[0];
    
    // Get full recipe details
    const ingredientsResult = await pool.query(
      'SELECT i.name, ri.amount, ri.unit FROM recipe_ingredients ri JOIN ingredients i ON ri.ingredient_id = i.id WHERE ri.recipe_id = $1',
      [recipe.id]
    );
    
    const instructionsResult = await pool.query(
      'SELECT instruction FROM recipe_instructions WHERE recipe_id = $1 ORDER BY step_number',
      [recipe.id]
    );
    
    const nutritionResult = await pool.query(
      'SELECT * FROM recipe_nutrition WHERE recipe_id = $1',
      [recipe.id]
    );

    // Format recipe for response
    const formattedRecipe = {
      id: recipe.id,
      title: recipe.title,
      cuisine: recipe.cuisine,
      servings: recipe.servings,
      prepTime: `${recipe.prep_time} minutes`,
      cookTime: `${recipe.cook_time} minutes`,
      difficulty: recipe.difficulty,
      rating: recipe.average_rating,
      ratingCount: recipe.rating_count,
      ingredients: ingredientsResult.rows.map(ing => 
        `${ing.amount} ${ing.unit} ${ing.name}`.trim()
      ),
      instructions: instructionsResult.rows.map(inst => inst.instruction),
      nutrition: nutritionResult.rows[0] || null
    };
    
    // Record usage
    if (deviceId) {
      await pool.query(
        'INSERT INTO recipe_usage (recipe_id, device_id) VALUES ($1, $2)',
        [recipe.id, deviceId]
      );
    }
    
    // Cache the result
    const response = { found: true, recipe: formattedRecipe };
    cache.set(cacheKey, response);
    
    res.json(response);
    
  } catch (error) {
    console.error('Error matching recipe:', error);
    res.status(500).json({ error: 'Failed to match recipe' });
  }
});

// Save favorite recipe endpoint (5-star recipes)
app.post('/api/recipes/save-favorite', async (req, res) => {
  try {
    const { recipe, deviceId, rating } = req.body;
    
    // Validate input
    if (!recipe || !recipe.title) {
      return res.status(400).json({ error: 'Recipe title is required' });
    }
    
    if (rating !== 5) {
      return res.status(400).json({ error: 'Only 5-star recipes can be saved as favorites' });
    }
    
    console.log(`Saving 5-star recipe: ${recipe.title}`);
    
    // Start transaction
    await pool.query('BEGIN');
    
    try {
      // Check if recipe already exists
      const existingRecipe = await pool.query(
        'SELECT id FROM recipes WHERE title = $1',
        [recipe.title]
      );
      
      if (existingRecipe.rows.length > 0) {
        // Recipe exists, just update rating count
        await pool.query(
          'UPDATE recipes SET rating_count = rating_count + 1, average_rating = ((average_rating * rating_count) + $1) / (rating_count + 1) WHERE id = $2',
          [rating, existingRecipe.rows[0].id]
        );
        
        await pool.query('COMMIT');
        return res.json({ 
          success: true, 
          message: 'Recipe rating updated',
          recipeId: existingRecipe.rows[0].id 
        });
      }
      
      // Parse prep and cook times to minutes
      const parseTime = (timeStr) => {
        if (!timeStr) return 30;
        
        // If it's already a number, just return it
        if (typeof timeStr === 'number') return timeStr;
        
        // Convert to string to ensure we can use match
        const str = String(timeStr);
        
        // If it's just a number as string, return it
        const num = parseInt(str);
        if (!isNaN(num) && str.trim() === num.toString()) return num;
        
        // Parse time strings like "30 minutes", "1 hour", etc.
        const hours = str.match(/(\d+)\s*h/i);
        const minutes = str.match(/(\d+)\s*m/i);
        let total = 0;
        if (hours) total += parseInt(hours[1]) * 60;
        if (minutes) total += parseInt(minutes[1]);
        return total || 30;
      };
      
      // Insert new recipe
      const recipeResult = await pool.query(
        `INSERT INTO recipes (
          title, cuisine, servings, prep_time, cook_time, 
          difficulty, source, average_rating, rating_count
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) 
        RETURNING id`,
        [
          recipe.title,
          recipe.cuisine || 'american',
          parseInt(recipe.servings) || 4,
          parseTime(recipe.prepTime),
          parseTime(recipe.cookTime),
          recipe.difficulty || 'medium',
          'user_generated',
          5.0,
          1
        ]
      );
      
      const recipeId = recipeResult.rows[0].id;
      console.log(`Created recipe with ID: ${recipeId}`);
      
      // Insert parsed ingredients
      if (recipe.ingredients && Array.isArray(recipe.ingredients)) {
        for (const ingredientStr of recipe.ingredients) {
          const parsed = parseIngredient(ingredientStr);
          const coreIngredient = getCoreIngredient(parsed.name);
          
          // First, ensure core ingredient exists in ingredients table
          let ingredientId;
          const existingIngredient = await pool.query(
            'SELECT id FROM ingredients WHERE LOWER(name) = LOWER($1)',
            [coreIngredient]
          );
          
          if (existingIngredient.rows.length > 0) {
            ingredientId = existingIngredient.rows[0].id;
          } else {
            // Insert new ingredient
            const newIngredient = await pool.query(
              'INSERT INTO ingredients (name, category) VALUES ($1, $2) RETURNING id',
              [coreIngredient, 'other']
            );
            ingredientId = newIngredient.rows[0].id;
          }
          
          // Link ingredient to recipe
          await pool.query(
            'INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit, is_required) VALUES ($1, $2, $3, $4, $5)',
            [recipeId, ingredientId, parsed.amount || 1, parsed.unit || 'unit', true]
          );
        }
      }
      
      // Insert instructions
      if (recipe.instructions) {
        if (Array.isArray(recipe.instructions)) {
          for (let i = 0; i < recipe.instructions.length; i++) {
            await pool.query(
              'INSERT INTO recipe_instructions (recipe_id, step_number, instruction) VALUES ($1, $2, $3)',
              [recipeId, i + 1, recipe.instructions[i]]
            );
          }
        } else {
          await pool.query(
            'INSERT INTO recipe_instructions (recipe_id, step_number, instruction) VALUES ($1, $2, $3)',
            [recipeId, 1, recipe.instructions]
          );
        }
      }
      
      // Insert nutrition info if available
      if (recipe.nutrition) {
        const parseNutritionValue = (val) => {
          if (!val) return 0;
          const num = parseFloat(val.toString().replace(/[^\d.]/g, ''));
          return isNaN(num) ? 0 : num;
        };
        
        await pool.query(
          `INSERT INTO recipe_nutrition (
            recipe_id, calories, protein, carbs, fat, fiber
          ) VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            recipeId,
            parseNutritionValue(recipe.nutrition.calories),
            parseNutritionValue(recipe.nutrition.protein),
            parseNutritionValue(recipe.nutrition.carbs),
            parseNutritionValue(recipe.nutrition.fat),
            parseNutritionValue(recipe.nutrition.fiber)
          ]
        );
      }
      
      // Record device submission
      if (deviceId) {
        await pool.query(
          'INSERT INTO recipe_usage (recipe_id, device_id, rating) VALUES ($1, $2, $3)',
          [recipeId, deviceId, rating]
        );
      }
      
      await pool.query('COMMIT');
      
      // Clear cache
      cache.flushAll();
      
      console.log(`Recipe "${recipe.title}" saved successfully`);
      
      res.json({ 
        success: true, 
        message: 'Recipe saved and shared with community!',
        recipeId: recipeId 
      });
      
    } catch (error) {
      await pool.query('ROLLBACK');
      throw error;
    }
    
  } catch (error) {
    console.error('Error saving recipe:', error);
    res.status(500).json({ error: 'Failed to save recipe: ' + error.message });
  }
});

// Get popular recipes endpoint
app.get('/api/recipes/popular', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        r.id,
        r.title,
        r.cuisine,
        r.servings,
        r.prep_time,
        r.cook_time,
        r.difficulty,
        r.average_rating,
        r.rating_count
      FROM recipes r
      WHERE r.source = 'user_generated' 
        AND r.average_rating >= 4.5
        AND r.rating_count >= 1
      ORDER BY r.average_rating DESC, r.rating_count DESC
      LIMIT 20
    `);
    
    res.json({
      success: true,
      recipes: result.rows
    });
  } catch (error) {
    console.error('Error fetching popular recipes:', error);
    res.status(500).json({ error: 'Failed to fetch popular recipes' });
  }
});

// Get recipe by ID
app.get('/api/recipes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const recipeResult = await pool.query(
      'SELECT * FROM recipes WHERE id = $1',
      [id]
    );
    
    if (recipeResult.rows.length === 0) {
      return res.status(404).json({ error: 'Recipe not found' });
    }
    
    const recipe = recipeResult.rows[0];
    
    // Get ingredients
    const ingredientsResult = await pool.query(
      'SELECT i.name, ri.amount, ri.unit FROM recipe_ingredients ri JOIN ingredients i ON ri.ingredient_id = i.id WHERE ri.recipe_id = $1',
      [id]
    );
    
    // Get instructions
    const instructionsResult = await pool.query(
      'SELECT instruction FROM recipe_instructions WHERE recipe_id = $1 ORDER BY step_number',
      [id]
    );
    
    // Get nutrition
    const nutritionResult = await pool.query(
      'SELECT * FROM recipe_nutrition WHERE recipe_id = $1',
      [id]
    );
    
    res.json({
      recipe: {
        ...recipe,
        ingredients: ingredientsResult.rows,
        instructions: instructionsResult.rows.map(i => i.instruction),
        nutrition: nutritionResult.rows[0] || null
      }
    });
  } catch (error) {
    console.error('Get recipe error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Rate recipe
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