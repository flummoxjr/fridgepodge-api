// Add this code to your server/index.js file BEFORE the "Start server" section

// Helper function to parse ingredient strings
function parseIngredient(ingredientStr) {
  // Examples: "2 cups rice", "1 pound chicken breast", "3 tomatoes, chopped"
  
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