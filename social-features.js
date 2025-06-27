// Additional endpoints for social features

// Add to your main server index.js:

// Like/Dislike a recipe
app.post('/api/recipes/:id/react', async (req, res) => {
  try {
    const { id } = req.params;
    const { reaction, deviceId } = req.body;
    
    if (!['like', 'dislike', 'remove'].includes(reaction)) {
      return res.status(400).json({ error: 'Invalid reaction type' });
    }

    if (!deviceId) {
      return res.status(400).json({ error: 'Device ID required' });
    }

    if (reaction === 'remove') {
      // Remove reaction
      await pool.query(
        'DELETE FROM recipe_reactions WHERE recipe_id = $1 AND device_id = $2',
        [id, deviceId]
      );
    } else {
      // Add or update reaction
      await pool.query(
        `INSERT INTO recipe_reactions (recipe_id, device_id, reaction) 
         VALUES ($1, $2, $3) 
         ON CONFLICT (recipe_id, device_id) 
         DO UPDATE SET reaction = $3, created_at = CURRENT_TIMESTAMP`,
        [id, deviceId, reaction]
      );
    }

    // Get updated counts
    const stats = await pool.query(
      'SELECT likes, dislikes FROM recipe_ratings WHERE recipe_id = $1',
      [id]
    );

    res.json({
      success: true,
      stats: stats.rows[0] || { likes: 0, dislikes: 0 }
    });

  } catch (error) {
    console.error('React to recipe error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Save favorite recipe from Gemini
app.post('/api/recipes/save-favorite', async (req, res) => {
  try {
    const { recipe, deviceId, geminiResponse } = req.body;
    
    if (!recipe || !deviceId) {
      return res.status(400).json({ error: 'Recipe and device ID required' });
    }

    // Start transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Insert recipe
      const recipeResult = await client.query(
        `INSERT INTO recipes (title, cuisine, servings, prep_time, cook_time, source_type)
         VALUES ($1, $2, $3, $4, $5, 'user_favorite')
         RETURNING id`,
        [recipe.title, recipe.cuisine, recipe.servings, recipe.prepTime, recipe.cookTime]
      );
      
      const recipeId = recipeResult.rows[0].id;

      // Insert ingredients
      for (const ing of recipe.ingredients) {
        // First, ensure ingredient exists
        const ingResult = await client.query(
          `INSERT INTO ingredients (name, category) 
           VALUES ($1, $2) 
           ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
           RETURNING id`,
          [ing.name.toLowerCase(), ing.category || 'other']
        );
        
        // Link to recipe
        await client.query(
          `INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit, is_required)
           VALUES ($1, $2, $3, $4, $5)`,
          [recipeId, ingResult.rows[0].id, ing.amount, ing.unit, true]
        );
      }

      // Insert instructions
      for (let i = 0; i < recipe.instructions.length; i++) {
        await client.query(
          `INSERT INTO recipe_instructions (recipe_id, step_number, instruction)
           VALUES ($1, $2, $3)`,
          [recipeId, i + 1, recipe.instructions[i]]
        );
      }

      // Insert nutrition if provided
      if (recipe.nutrition) {
        await client.query(
          `INSERT INTO recipe_nutrition (recipe_id, calories, protein, carbs, fat, fiber, sugar, sodium)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [recipeId, recipe.nutrition.calories, recipe.nutrition.protein, 
           recipe.nutrition.carbs, recipe.nutrition.fat, recipe.nutrition.fiber,
           recipe.nutrition.sugar, recipe.nutrition.sodium]
        );
      }

      // Insert dietary tags
      if (recipe.dietary && recipe.dietary.length > 0) {
        for (const diet of recipe.dietary) {
          const tagResult = await client.query(
            `INSERT INTO dietary_tags (name) VALUES ($1) 
             ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
             RETURNING id`,
            [diet]
          );
          
          await client.query(
            `INSERT INTO recipe_dietary_tags (recipe_id, dietary_tag_id) VALUES ($1, $2)`,
            [recipeId, tagResult.rows[0].id]
          );
        }
      }

      // Add to favorites
      await client.query(
        `INSERT INTO user_favorites (recipe_id, device_id, gemini_response)
         VALUES ($1, $2, $3)`,
        [recipeId, deviceId, geminiResponse || null]
      );

      await client.query('COMMIT');

      res.json({
        success: true,
        recipeId: recipeId,
        message: 'Recipe saved to your favorites and added to database'
      });

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

  } catch (error) {
    console.error('Save favorite recipe error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get popular recipes
app.get('/api/recipes/popular', async (req, res) => {
  try {
    const { limit = 10, offset = 0 } = req.query;
    
    const result = await pool.query(
      `SELECT 
        id, title, cuisine, avg_rating, total_ratings, likes, dislikes, 
        net_likes, favorite_count, servings, prep_time, cook_time
       FROM popular_recipes
       WHERE total_ratings >= 5 OR favorite_count >= 3
       ORDER BY net_likes DESC, avg_rating DESC, favorite_count DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    res.json({
      recipes: result.rows,
      hasMore: result.rows.length === parseInt(limit)
    });

  } catch (error) {
    console.error('Get popular recipes error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get trending recipes
app.get('/api/recipes/trending', async (req, res) => {
  try {
    const { limit = 10 } = req.query;
    
    const result = await pool.query(
      `SELECT * FROM trending_recipes LIMIT $1`,
      [limit]
    );

    res.json({
      recipes: result.rows
    });

  } catch (error) {
    console.error('Get trending recipes error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user's reaction to a recipe
app.get('/api/recipes/:id/my-reaction', async (req, res) => {
  try {
    const { id } = req.params;
    const { deviceId } = req.query;
    
    if (!deviceId) {
      return res.status(400).json({ error: 'Device ID required' });
    }

    const result = await pool.query(
      'SELECT reaction FROM recipe_reactions WHERE recipe_id = $1 AND device_id = $2',
      [id, deviceId]
    );

    res.json({
      reaction: result.rows[0]?.reaction || null
    });

  } catch (error) {
    console.error('Get user reaction error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});