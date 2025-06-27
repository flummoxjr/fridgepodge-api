// Endpoint for saving 5-star recipes to database
// Add this to your server/index.js file

// Save favorite recipe endpoint
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
          recipe.servings || 4,
          recipe.prepTime || 30,
          recipe.cookTime || 30,
          recipe.difficulty || 'medium',
          'user_generated',
          5.0,
          1
        ]
      );
      
      const recipeId = recipeResult.rows[0].id;
      
      // Insert ingredients
      if (recipe.ingredients && Array.isArray(recipe.ingredients)) {
        for (const ingredient of recipe.ingredients) {
          // First, ensure ingredient exists in ingredients table
          let ingredientId;
          const existingIngredient = await pool.query(
            'SELECT id FROM ingredients WHERE LOWER(name) = LOWER($1)',
            [ingredient]
          );
          
          if (existingIngredient.rows.length > 0) {
            ingredientId = existingIngredient.rows[0].id;
          } else {
            // Insert new ingredient
            const newIngredient = await pool.query(
              'INSERT INTO ingredients (name, category) VALUES ($1, $2) RETURNING id',
              [ingredient, 'other']
            );
            ingredientId = newIngredient.rows[0].id;
          }
          
          // Link ingredient to recipe
          await pool.query(
            'INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit, is_required) VALUES ($1, $2, $3, $4, $5)',
            [recipeId, ingredientId, '1', 'unit', true]
          );
        }
      }
      
      // Insert instructions
      if (recipe.instructions) {
        const instructionText = Array.isArray(recipe.instructions) 
          ? recipe.instructions.join('\n') 
          : recipe.instructions;
          
        await pool.query(
          'INSERT INTO recipe_instructions (recipe_id, step_number, instruction) VALUES ($1, $2, $3)',
          [recipeId, 1, instructionText]
        );
      }
      
      // Insert nutrition info if available
      if (recipe.nutrition) {
        await pool.query(
          `INSERT INTO recipe_nutrition (
            recipe_id, calories, protein, carbs, fat, fiber, sugar, sodium
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            recipeId,
            recipe.nutrition.calories || 0,
            recipe.nutrition.protein || 0,
            recipe.nutrition.carbs || 0,
            recipe.nutrition.fat || 0,
            recipe.nutrition.fiber || 0,
            recipe.nutrition.sugar || 0,
            recipe.nutrition.sodium || 0
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
          'INSERT INTO recipe_submissions (recipe_id, device_id, rating) VALUES ($1, $2, $3)',
          [recipeId, deviceId, rating]
        );
      }
      
      await pool.query('COMMIT');
      
      // Clear relevant cache entries
      cache.flushAll();
      
      res.json({ 
        success: true, 
        message: 'Recipe saved successfully',
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
        COUNT(DISTINCT ri.ingredient_id) as ingredient_count
      FROM recipes r
      LEFT JOIN recipe_ingredients ri ON r.id = ri.recipe_id
      WHERE r.source = 'user_generated' 
        AND r.average_rating >= 4.5
        AND r.rating_count >= 3
      GROUP BY r.id
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