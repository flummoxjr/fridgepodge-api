// Improved endpoint for saving 5-star recipes with better ingredient parsing
// This version properly parses ingredients for efficient searching

// Helper function to parse ingredient strings
function parseIngredient(ingredientStr) {
  // Examples: "2 cups rice", "1 pound chicken breast", "3 tomatoes, chopped"
  
  // Common measurement patterns
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
  
  // Fallback for ingredients without measurements (like "Salt to taste")
  return {
    amount: null,
    unit: null,
    name: ingredientStr.trim(),
    preparation: null
  };
}

// Extract core ingredient name (remove descriptors)
function getCoreIngredient(ingredientName) {
  // Remove common descriptors
  const cleaned = ingredientName
    .toLowerCase()
    .replace(/\b(fresh|dried|frozen|canned|cooked|raw|whole|ground|minced|diced|chopped|sliced)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  
  // Common ingredient mappings
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

// Save favorite recipe endpoint (improved version)
app.post('/api/recipes/save-favorite', async (req, res) => {
  try {
    const { recipe, deviceId, rating } = req.body;
    
    // Validate input
    if (!recipe || !recipe.title || rating !== 5) {
      return res.status(400).json({ error: 'Invalid recipe data or rating' });
    }
    
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
        const hours = timeStr.match(/(\d+)\s*h/i);
        const minutes = timeStr.match(/(\d+)\s*m/i);
        let total = 0;
        if (hours) total += parseInt(hours[1]) * 60;
        if (minutes) total += parseInt(minutes[1]);
        return total || 30;
      };
      
      // Insert new recipe
      const recipeResult = await pool.query(
        `INSERT INTO recipes (
          title, cuisine, servings, prep_time, cook_time, 
          difficulty, source, average_rating, rating_count,
          description
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
          recipe.description || ''
        ]
      );
      
      const recipeId = recipeResult.rows[0].id;
      
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
          
          // Link ingredient to recipe with full details
          await pool.query(
            `INSERT INTO recipe_ingredients 
            (recipe_id, ingredient_id, amount, unit, is_required, full_text, preparation) 
            VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              recipeId, 
              ingredientId, 
              parsed.amount || 1, 
              parsed.unit || 'unit', 
              true,
              ingredientStr, // Store original text for display
              parsed.preparation
            ]
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
            recipe_id, calories, protein, carbs, fat, fiber, sugar, sodium
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            recipeId,
            parseNutritionValue(recipe.nutrition.calories),
            parseNutritionValue(recipe.nutrition.protein),
            parseNutritionValue(recipe.nutrition.carbs),
            parseNutritionValue(recipe.nutrition.fat),
            parseNutritionValue(recipe.nutrition.fiber),
            parseNutritionValue(recipe.nutrition.sugar),
            parseNutritionValue(recipe.nutrition.sodium)
          ]
        );
      }
      
      // Insert dietary tags if available
      if (recipe.dietary && Array.isArray(recipe.dietary)) {
        for (const diet of recipe.dietary) {
          await pool.query(
            'INSERT INTO recipe_dietary_tags (recipe_id, tag) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [recipeId, diet]
          );
        }
      }
      
      // Record device submission
      if (deviceId) {
        await pool.query(
          'INSERT INTO recipe_submissions (recipe_id, device_id, rating, submitted_at) VALUES ($1, $2, $3, NOW())',
          [recipeId, deviceId, rating]
        );
      }
      
      await pool.query('COMMIT');
      
      // Clear relevant cache entries
      cache.flushAll();
      
      console.log(`Recipe "${recipe.title}" saved successfully with ${recipe.ingredients.length} ingredients`);
      
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
    res.status(500).json({ error: 'Failed to save recipe' });
  }
});

// Enhanced recipe matching endpoint
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

    // Enhanced matching query that searches core ingredients
    const matchQuery = `
      WITH user_ingredients AS (
        SELECT LOWER(unnest($1::text[])) as ingredient
      ),
      recipe_matches AS (
        SELECT 
          r.id,
          r.title,
          r.description,
          r.cuisine,
          r.servings,
          r.prep_time,
          r.cook_time,
          r.difficulty,
          r.average_rating,
          r.rating_count,
          COUNT(DISTINCT CASE WHEN ri.is_required THEN i.id END) as required_count,
          COUNT(DISTINCT CASE WHEN ri.is_required AND ui.ingredient IS NOT NULL THEN i.id END) as required_matched,
          COUNT(DISTINCT ui.ingredient) as user_ingredient_count,
          ARRAY_AGG(DISTINCT i.name) as matched_ingredients
        FROM recipes r
        JOIN recipe_ingredients ri ON r.id = ri.recipe_id
        JOIN ingredients i ON ri.ingredient_id = i.id
        LEFT JOIN user_ingredients ui ON LOWER(i.name) = ui.ingredient
        WHERE ($2::text IS NULL OR r.cuisine = $2)
          AND r.id != ALL($3::int[])
          AND r.average_rating >= 4.0
        GROUP BY r.id, r.title, r.description, r.cuisine, r.servings, 
                 r.prep_time, r.cook_time, r.difficulty, r.average_rating, r.rating_count
      ),
      scored_recipes AS (
        SELECT 
          *,
          CASE 
            WHEN required_count = 0 THEN 100.0
            ELSE (required_matched::float / required_count::float) * 100
          END as match_score
        FROM recipe_matches
        WHERE required_count = 0 OR (required_matched::float / required_count::float) >= 0.7
      )
      SELECT 
        sr.*,
        (
          SELECT json_agg(json_build_object(
            'full_text', ri.full_text,
            'amount', ri.amount,
            'unit', ri.unit,
            'name', i.name,
            'preparation', ri.preparation
          ) ORDER BY ri.id)
          FROM recipe_ingredients ri
          JOIN ingredients i ON ri.ingredient_id = i.id
          WHERE ri.recipe_id = sr.id
        ) as ingredients,
        (
          SELECT json_agg(json_build_object(
            'step_number', step_number,
            'instruction', instruction
          ) ORDER BY step_number)
          FROM recipe_instructions
          WHERE recipe_id = sr.id
        ) as instructions,
        (
          SELECT row_to_json(n)
          FROM recipe_nutrition n
          WHERE n.recipe_id = sr.id
        ) as nutrition
      FROM scored_recipes sr
      ORDER BY match_score DESC, average_rating DESC
      LIMIT 1;
    `;

    const result = await pool.query(matchQuery, [
      coreIngredients,
      cuisine || null,
      usedRecipeIds
    ]);

    if (result.rows.length === 0) {
      return res.json({ found: false });
    }

    const recipe = result.rows[0];
    
    // Format recipe for response
    const formattedRecipe = {
      id: recipe.id,
      title: recipe.title,
      description: recipe.description,
      cuisine: recipe.cuisine,
      servings: recipe.servings,
      prepTime: `${recipe.prep_time} minutes`,
      cookTime: `${recipe.cook_time} minutes`,
      difficulty: recipe.difficulty,
      rating: recipe.average_rating,
      ratingCount: recipe.rating_count,
      matchScore: recipe.match_score,
      matchedIngredients: recipe.matched_ingredients,
      ingredients: recipe.ingredients.map(ing => ing.full_text),
      instructions: recipe.instructions.map(inst => inst.instruction),
      nutrition: recipe.nutrition
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
    
    console.log(`Found recipe match: "${recipe.title}" with ${recipe.match_score}% match`);
    res.json(response);
    
  } catch (error) {
    console.error('Error matching recipe:', error);
    res.status(500).json({ error: 'Failed to match recipe' });
  }
});