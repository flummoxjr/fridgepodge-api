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

// Test database connection and ensure tables exist on startup
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('Database connection failed:', err.message);
    console.error('Please check DATABASE_URL environment variable in Render dashboard');
  } else {
    console.log('Database connected successfully at:', res.rows[0].now);
    // Initialize required tables
    initializeDatabaseTables();
  }
});

// Function to ensure all required tables exist
async function initializeDatabaseTables() {
  try {
    console.log('Checking and creating required database tables...');
    
    // Create recipe_views table if it doesn't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS recipe_views (
        id SERIAL PRIMARY KEY,
        recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
        device_id VARCHAR(255) NOT NULL,
        viewed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(recipe_id, device_id)
      )
    `);
    console.log('✓ recipe_views table ready');
    
    // Create indexes for better performance
    await pool.query('CREATE INDEX IF NOT EXISTS idx_recipe_views_device ON recipe_views(device_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_recipe_views_recipe ON recipe_views(recipe_id)');
    console.log('✓ Indexes created');
    
    // Add submitted_by column to recipes if it doesn't exist
    await pool.query('ALTER TABLE recipes ADD COLUMN IF NOT EXISTS submitted_by VARCHAR(255)');
    console.log('✓ submitted_by column ready');
    
    // Add rating column to recipe_views if it doesn't exist
    await pool.query('ALTER TABLE recipe_views ADD COLUMN IF NOT EXISTS rating INTEGER CHECK (rating >= 1 AND rating <= 5)');
    console.log('✓ rating column ready in recipe_views');
    
    // Create premium_users table if it doesn't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS premium_users (
        id SERIAL PRIMARY KEY,
        device_id VARCHAR(255) UNIQUE NOT NULL,
        is_premium BOOLEAN DEFAULT false,
        purchase_date TIMESTAMP,
        purchase_token VARCHAR(500),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✓ premium_users table ready');
    
    // Create index for premium users
    await pool.query('CREATE INDEX IF NOT EXISTS idx_premium_users_device ON premium_users(device_id)');
    console.log('✓ premium_users index created');
    
    // Check current stats
    const stats = await pool.query(`
      SELECT 
        (SELECT COUNT(*) FROM recipe_views) as total_views,
        (SELECT COUNT(DISTINCT device_id) FROM recipe_views) as unique_devices,
        (SELECT COUNT(*) FROM recipes) as total_recipes,
        (SELECT COUNT(*) FROM premium_users WHERE is_premium = true) as premium_users
    `);
    
    console.log('Database stats:', stats.rows[0]);
    
  } catch (error) {
    console.error('Error initializing database tables:', error.message);
    // Don't crash the server, but log the error
  }
}

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
    version: '1.2.0',
    status: 'running',
    endpoints: {
      health: '/health',
      recipeMatch: 'POST /api/recipes/match',
      saveFavorite: 'POST /api/recipes/save-favorite',
      popular: 'GET /api/recipes/popular',
      mostSaved: 'GET /api/recipes/most-saved',
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

    // Create cache key that includes device ID to ensure personalized results
    const cacheKey = `match:${coreIngredients.sort().join(',')}:${dietary||''}:${cuisine||''}:${deviceId||'anon'}`;
    
    // Skip cache for now to ensure exclusion works properly
    // TODO: Re-enable cache after fixing exclusion logic
    // const cachedResult = cache.get(cacheKey);
    // if (cachedResult) {
    //   console.log('Cache hit:', cacheKey);
    //   return res.json(cachedResult);
    // }

    // Get previously viewed recipes and recipes submitted by this device (V6.7)
    let excludedRecipeIds = [];
    if (deviceId) {
      // Get recipes this device has already seen
      const viewedRecipes = await pool.query(
        'SELECT DISTINCT recipe_id FROM recipe_views WHERE device_id = $1',
        [deviceId]
      );
      
      console.log(`Device ${deviceId} has viewed ${viewedRecipes.rows.length} recipes:`, 
        viewedRecipes.rows.map(r => r.recipe_id).join(', '));
      
      // Get recipes submitted by this device
      const submittedRecipes = await pool.query(
        'SELECT DISTINCT id FROM recipes WHERE submitted_by = $1',
        [deviceId]
      );
      
      console.log(`Device ${deviceId} has submitted ${submittedRecipes.rows.length} recipes:`,
        submittedRecipes.rows.map(r => r.id).join(', '));
      
      excludedRecipeIds = [
        ...viewedRecipes.rows.map(r => parseInt(r.recipe_id)),
        ...submittedRecipes.rows.map(r => parseInt(r.id))
      ].filter(id => !isNaN(id)); // Ensure all are valid integers
      
      // Debug: Check data types
      console.log(`Raw viewed recipes:`, viewedRecipes.rows);
      console.log(`Excluded recipe IDs for device ${deviceId}:`, excludedRecipeIds);
      console.log(`Excluded IDs types:`, excludedRecipeIds.map(id => typeof id));
      console.log(`Excluded IDs as string:`, excludedRecipeIds.join(', ') || 'none');
    }

    // V7.5: Strict matching - only return recipes with EXACT same ingredients
    console.log(`V7.5: Looking for recipes with EXACT ingredients: ${coreIngredients.join(', ')}`);
    
    let matchQuery;
    let queryParams;
    
    // Build the exact match query
    if (excludedRecipeIds.length > 0) {
      console.log(`Excluding ${excludedRecipeIds.length} already viewed recipes`);
      
      matchQuery = `
        WITH recipe_ingredient_counts AS (
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
            r.saved_by_count,
            COUNT(DISTINCT i.id) as total_ingredients,
            COUNT(DISTINCT CASE WHEN LOWER(i.name) = ANY($1::text[]) THEN i.id END) as matched_ingredients,
            ARRAY_AGG(DISTINCT LOWER(i.name) ORDER BY LOWER(i.name)) as all_ingredients
          FROM recipes r
          JOIN recipe_ingredients ri ON r.id = ri.recipe_id
          JOIN ingredients i ON ri.ingredient_id = i.id
          WHERE NOT (r.id = ANY($2::int[]))
          GROUP BY r.id, r.title, r.cuisine, r.servings, r.prep_time, r.cook_time, r.difficulty, r.average_rating, r.rating_count, r.saved_by_count
        )
        SELECT * FROM recipe_ingredient_counts
        WHERE total_ingredients = $3
          AND matched_ingredients = $3
          AND total_ingredients = matched_ingredients
        ORDER BY average_rating DESC, rating_count DESC
        LIMIT 1;
      `;
      queryParams = [coreIngredients, excludedRecipeIds, coreIngredients.length];
    } else {
      console.log('No recipes to exclude, searching all recipes for exact match');
      matchQuery = `
        WITH recipe_ingredient_counts AS (
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
            r.saved_by_count,
            COUNT(DISTINCT i.id) as total_ingredients,
            COUNT(DISTINCT CASE WHEN LOWER(i.name) = ANY($1::text[]) THEN i.id END) as matched_ingredients,
            ARRAY_AGG(DISTINCT LOWER(i.name) ORDER BY LOWER(i.name)) as all_ingredients
          FROM recipes r
          JOIN recipe_ingredients ri ON r.id = ri.recipe_id
          JOIN ingredients i ON ri.ingredient_id = i.id
          GROUP BY r.id, r.title, r.cuisine, r.servings, r.prep_time, r.cook_time, r.difficulty, r.average_rating, r.rating_count, r.saved_by_count
        )
        SELECT * FROM recipe_ingredient_counts
        WHERE total_ingredients = $2
          AND matched_ingredients = $2
          AND total_ingredients = matched_ingredients
        ORDER BY average_rating DESC, rating_count DESC
        LIMIT 1;
      `;
      queryParams = [coreIngredients, coreIngredients.length];
    }

    const result = await pool.query(matchQuery, queryParams);

    if (result.rows.length === 0) {
      console.log(`V7.5: No recipes found with EXACT ingredients [${coreIngredients.join(', ')}] for device ${deviceId}`);
      return res.json({ 
        found: false,
        reason: 'no_exact_match',
        message: 'No recipes found with these exact ingredients. Generating a new recipe with AI.'
      });
    }

    const recipe = result.rows[0];
    console.log(`V7.5: Found EXACT match recipe: "${recipe.title}" (ID: ${recipe.id})`);
    console.log(`Recipe ingredients: [${recipe.all_ingredients ? recipe.all_ingredients.join(', ') : 'unknown'}]`);
    console.log(`User ingredients: [${coreIngredients.join(', ')}]`);
    
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
    // IMPORTANT: Record view BEFORE sending recipe to prevent duplicates
    if (deviceId) {
      try {
        const viewResult = await pool.query(
          'INSERT INTO recipe_views (recipe_id, device_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id',
          [recipe.id, deviceId]
        );
        
        if (viewResult.rows.length > 0) {
          console.log(`✓ Recorded new view: device ${deviceId} viewed recipe ${recipe.id}`);
        } else {
          console.log(`ℹ View already exists: device ${deviceId} already viewed recipe ${recipe.id}`);
        }
      } catch (viewError) {
        console.error('Failed to record recipe view:', viewError.message);
        console.error('Recipe ID:', recipe.id, 'Device ID:', deviceId);
        // Don't fail the request if view tracking fails
      }
    } else {
      console.log('⚠ No device ID provided, view not tracked');
    }
    
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
      savedByCount: recipe.saved_by_count || 0,
      ingredients: ingredientsResult.rows.map(ing => 
        `${ing.amount} ${ing.unit} ${ing.name}`.trim()
      ),
      instructions: instructionsResult.rows.map(inst => inst.instruction),
      nutrition: nutritionResult.rows[0] || null
    };
    
    // Build response
    const response = { found: true, recipe: formattedRecipe, fromDatabase: true };
    
    // Don't cache for now to ensure exclusion works
    // TODO: Re-enable caching with device-specific keys
    // cache.set(cacheKey, response);
    
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
      
      // Insert new recipe with submitted_by field
      const recipeResult = await pool.query(
        `INSERT INTO recipes (
          title, cuisine, servings, prep_time, cook_time, 
          difficulty, source, average_rating, rating_count, submitted_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) 
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
          1,
          deviceId || null
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
      
      // Record device submission in both tables
      if (deviceId) {
        // Record in recipe_usage for compatibility
        await pool.query(
          'INSERT INTO recipe_usage (recipe_id, device_id, rating) VALUES ($1, $2, $3)',
          [recipeId, deviceId, rating]
        );
        
        // Record in user_saved_recipes for tracking unique saves
        if (rating === 5) {
          await pool.query(
            `INSERT INTO user_saved_recipes (recipe_id, device_id, rating) 
             VALUES ($1, $2, $3) 
             ON CONFLICT (recipe_id, device_id) 
             DO UPDATE SET rating = $3, saved_at = CURRENT_TIMESTAMP`,
            [recipeId, deviceId, rating]
          );
        }
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
        r.rating_count,
        r.saved_by_count
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

// Get most-saved recipes endpoint
app.get('/api/recipes/most-saved', async (req, res) => {
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
        r.rating_count,
        r.saved_by_count,
        ARRAY_AGG(DISTINCT i.name) as ingredients
      FROM recipes r
      LEFT JOIN recipe_ingredients ri ON r.id = ri.recipe_id
      LEFT JOIN ingredients i ON ri.ingredient_id = i.id
      WHERE r.saved_by_count > 0
      GROUP BY r.id, r.title, r.cuisine, r.servings, r.prep_time, 
               r.cook_time, r.difficulty, r.average_rating, r.rating_count, r.saved_by_count
      ORDER BY r.saved_by_count DESC, r.average_rating DESC
      LIMIT 20
    `);
    
    res.json({
      success: true,
      recipes: result.rows.map(recipe => ({
        ...recipe,
        prepTime: `${recipe.prep_time} minutes`,
        cookTime: `${recipe.cook_time} minutes`
      }))
    });
  } catch (error) {
    console.error('Error fetching most-saved recipes:', error);
    res.status(500).json({ error: 'Failed to fetch most-saved recipes' });
  }
});

// Get top community recipes (most 5-starred)
app.get('/api/recipes/top-community', async (req, res) => {
  try {
    // Query to get top 10 recipes based on average rating and number of ratings
    // Only includes recipes that have been rated
    const topRecipesResult = await pool.query(`
      SELECT 
        r.id,
        r.title,
        r.servings,
        r.cuisine,
        r.prep_time,
        r.cook_time,
        COUNT(DISTINCT rv.device_id) as total_ratings,
        COUNT(DISTINCT rv.device_id) FILTER (WHERE rv.rating = 5) as five_star_count,
        ROUND(AVG(rv.rating)::numeric, 1) as average_rating,
        r.created_at
      FROM recipes r
      INNER JOIN recipe_views rv ON r.id = rv.recipe_id
      WHERE r.submitted_by IS NOT NULL  -- Only community-submitted recipes
        AND rv.rating IS NOT NULL      -- Only include rated recipes
      GROUP BY r.id, r.title, r.servings, r.cuisine, r.prep_time, r.cook_time, r.created_at
      HAVING COUNT(DISTINCT rv.device_id) > 0  -- Must have at least one rating
      ORDER BY 
        average_rating DESC,           -- Sort by average rating first
        five_star_count DESC,          -- Then by number of 5-star ratings
        total_ratings DESC,            -- Then by total number of ratings
        r.created_at DESC              -- Finally by creation date
      LIMIT 10
    `);
    
    if (topRecipesResult.rows.length === 0) {
      // If no rated community recipes exist, return empty array
      return res.json([]);
    }
    
    // Format the response to include rating information
    const formattedRecipes = topRecipesResult.rows.map(recipe => ({
      id: recipe.id,
      title: recipe.title,
      servings: recipe.servings,
      cuisine: recipe.cuisine,
      prep_time: recipe.prep_time,
      cook_time: recipe.cook_time,
      rating_count: parseInt(recipe.total_ratings),
      average_rating: parseFloat(recipe.average_rating),
      five_star_count: parseInt(recipe.five_star_count)
    }));
    
    res.json(formattedRecipes);
  } catch (error) {
    console.error('Get top community recipes error:', error);
    res.status(500).json({ error: 'Internal server error' });
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
    
    // Format the recipe to match frontend expectations
    const formattedRecipe = {
      id: recipe.id,
      title: recipe.title,
      description: recipe.description || `A delicious ${recipe.cuisine || 'homemade'} dish`,
      ingredients: ingredientsResult.rows.map(ing => 
        ing.amount ? `${ing.amount} ${ing.unit || ''} ${ing.name}`.trim() : ing.name
      ),
      instructions: instructionsResult.rows.map(i => i.instruction),
      prepTime: recipe.prep_time ? `${recipe.prep_time} minutes` : '30 minutes',
      cookTime: recipe.cook_time ? `${recipe.cook_time} minutes` : '30 minutes',
      servings: recipe.servings || 4,
      nutrition: nutritionResult.rows[0] || {
        calories: 450,
        protein: 25,
        carbs: 50,
        fat: 20,
        fiber: 5
      },
      cuisine: recipe.cuisine || 'american',
      difficulty: recipe.difficulty || 'medium',
      rating: recipe.average_rating || 0,
      ratingCount: recipe.rating_count || 0
    };
    
    res.json(formattedRecipe);
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
    
    if (!deviceId) {
      return res.status(400).json({ error: 'Device ID is required' });
    }
    
    console.log(`Rating recipe ${id} with ${rating} stars from device ${deviceId}`);
    
    // Update or insert rating in recipe_views
    await pool.query(
      `INSERT INTO recipe_views (recipe_id, device_id, rating) 
       VALUES ($1, $2, $3) 
       ON CONFLICT (recipe_id, device_id) 
       DO UPDATE SET rating = $3, viewed_at = CURRENT_TIMESTAMP`,
      [id, deviceId, rating]
    );
    
    // Update average rating in recipes table
    const ratingStats = await pool.query(
      `SELECT 
        COUNT(DISTINCT device_id) as total_ratings,
        AVG(rating) as avg_rating
       FROM recipe_views 
       WHERE recipe_id = $1 AND rating IS NOT NULL`,
      [id]
    );
    
    if (ratingStats.rows.length > 0) {
      const { total_ratings, avg_rating } = ratingStats.rows[0];
      await pool.query(
        'UPDATE recipes SET rating_count = $1, average_rating = $2 WHERE id = $3',
        [total_ratings, avg_rating, id]
      );
    }
    
    // If it's a 5-star rating and not already submitted, mark as community recipe
    if (rating === 5) {
      await pool.query(
        'UPDATE recipes SET submitted_by = $1 WHERE id = $2 AND submitted_by IS NULL',
        [deviceId, id]
      );
    }

    res.json({ success: true, message: `Recipe rated ${rating} stars` });
  } catch (error) {
    console.error('Rate recipe error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Premium status endpoints
app.get('/api/premium/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;
    
    // Check if device exists in premium_users table
    const result = await pool.query(
      'SELECT is_premium, purchase_date FROM premium_users WHERE device_id = $1',
      [deviceId]
    );
    
    if (result.rows.length > 0) {
      res.json({
        isPremium: result.rows[0].is_premium,
        purchaseDate: result.rows[0].purchase_date
      });
    } else {
      // Device not found, not premium
      res.json({
        isPremium: false
      });
    }
  } catch (error) {
    console.error('Error checking premium status:', error);
    res.status(500).json({ error: 'Failed to check premium status' });
  }
});

app.post('/api/premium', async (req, res) => {
  try {
    const { deviceId, isPremium, purchaseToken } = req.body;
    
    if (!deviceId) {
      return res.status(400).json({ error: 'Device ID is required' });
    }
    
    // Insert or update premium status
    const result = await pool.query(
      `INSERT INTO premium_users (device_id, is_premium, purchase_date, purchase_token)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (device_id) 
       DO UPDATE SET 
         is_premium = EXCLUDED.is_premium,
         purchase_date = CASE 
           WHEN EXCLUDED.is_premium = true THEN CURRENT_TIMESTAMP 
           ELSE premium_users.purchase_date 
         END,
         purchase_token = EXCLUDED.purchase_token,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [deviceId, isPremium || false, isPremium ? new Date() : null, purchaseToken || null]
    );
    
    res.json({
      success: true,
      isPremium: result.rows[0].is_premium,
      message: isPremium ? 'Premium status activated' : 'Premium status updated'
    });
  } catch (error) {
    console.error('Error updating premium status:', error);
    res.status(500).json({ error: 'Failed to update premium status' });
  }
});

// Debug endpoint to check recipe views tracking
app.get('/api/debug/recipe-views', async (req, res) => {
  try {
    // Check if table exists
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'recipe_views'
      );
    `);
    
    if (!tableCheck.rows[0].exists) {
      return res.json({
        error: 'recipe_views table does not exist!',
        message: 'The table will be created on next server restart'
      });
    }
    
    // Get stats
    const stats = await pool.query(`
      SELECT 
        COUNT(*) as total_views,
        COUNT(DISTINCT device_id) as unique_devices,
        COUNT(DISTINCT recipe_id) as unique_recipes
      FROM recipe_views
    `);
    
    // Get recent views
    const recentViews = await pool.query(`
      SELECT 
        rv.device_id,
        rv.recipe_id,
        r.title,
        rv.viewed_at
      FROM recipe_views rv
      LEFT JOIN recipes r ON rv.recipe_id = r.id
      ORDER BY rv.viewed_at DESC
      LIMIT 10
    `);
    
    res.json({
      status: 'success',
      tableExists: true,
      stats: stats.rows[0],
      recentViews: recentViews.rows,
      message: 'Recipe view tracking is active'
    });
    
  } catch (error) {
    res.status(500).json({ 
      error: error.message,
      hint: 'The table will be created automatically on next server restart'
    });
  }
});

// TEMPORARY DEBUG ENDPOINT - Check recipe matching
app.post('/api/debug/check-matches', async (req, res) => {
  try {
    const { ingredients, deviceId } = req.body;
    
    // Get all recipes that match ANY of the ingredients
    const anyMatch = await pool.query(`
      SELECT DISTINCT r.id, r.title, 
        array_agg(DISTINCT i.name) as matching_ingredients
      FROM recipes r
      JOIN recipe_ingredients ri ON r.id = ri.recipe_id
      JOIN ingredients i ON ri.ingredient_id = i.id
      WHERE LOWER(i.name) = ANY($1::text[])
      GROUP BY r.id, r.title
      ORDER BY r.id
    `, [ingredients.map(i => i.toLowerCase())]);
    
    // Get viewed recipes for this device
    const viewed = await pool.query(
      'SELECT recipe_id FROM recipe_views WHERE device_id = $1',
      [deviceId]
    );
    const viewedIds = viewed.rows.map(r => r.recipe_id);
    
    // Get recipes that match ALL ingredients (more strict)
    const allMatch = await pool.query(`
      SELECT r.id, r.title, COUNT(DISTINCT i.name) as match_count
      FROM recipes r
      JOIN recipe_ingredients ri ON r.id = ri.recipe_id
      JOIN ingredients i ON ri.ingredient_id = i.id
      WHERE LOWER(i.name) = ANY($1::text[])
      GROUP BY r.id, r.title
      HAVING COUNT(DISTINCT i.name) = $2
      ORDER BY r.id
    `, [ingredients.map(i => i.toLowerCase()), ingredients.length]);
    
    res.json({
      requestedIngredients: ingredients,
      recipesMatchingAnyIngredient: anyMatch.rows,
      recipesMatchingAllIngredients: allMatch.rows,
      viewedByThisDevice: viewedIds,
      availableAfterExclusion: anyMatch.rows.filter(r => !viewedIds.includes(r.id)),
      summary: {
        totalRecipesInDB: anyMatch.rows.length,
        matchingAll: allMatch.rows.length,
        alreadyViewed: viewedIds.length,
        stillAvailable: anyMatch.rows.filter(r => !viewedIds.includes(r.id)).length
      }
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start server
app.listen(port, () => {
  console.log(`FridgePodge API server running on port ${port}`);
});