// Add this debug endpoint to server/index.js to check exclusion logic

app.post('/api/debug/test-exclusion', async (req, res) => {
  try {
    const { deviceId, ingredients } = req.body;
    
    // Step 1: Check what recipes this device has viewed
    const viewedRecipes = await pool.query(
      'SELECT DISTINCT recipe_id FROM recipe_views WHERE device_id = $1',
      [deviceId]
    );
    
    const viewedIds = viewedRecipes.rows.map(r => r.recipe_id);
    
    // Step 2: Get all matching recipes WITHOUT exclusion
    const allMatchesQuery = `
      WITH user_ingredients AS (
        SELECT LOWER(unnest($1::text[])) as ingredient
      ),
      recipe_matches AS (
        SELECT 
          r.id,
          r.title,
          COUNT(DISTINCT i.id) as matched_ingredients
        FROM recipes r
        JOIN recipe_ingredients ri ON r.id = ri.recipe_id
        JOIN ingredients i ON ri.ingredient_id = i.id
        JOIN user_ingredients ui ON LOWER(i.name) = ui.ingredient
        GROUP BY r.id, r.title
        HAVING COUNT(DISTINCT i.id) >= 1
      )
      SELECT * FROM recipe_matches
      ORDER BY matched_ingredients DESC;
    `;
    
    const allMatches = await pool.query(allMatchesQuery, [ingredients]);
    
    // Step 3: Test exclusion query
    let excludedMatches = { rows: [] };
    if (viewedIds.length > 0) {
      const excludedQuery = `
        WITH user_ingredients AS (
          SELECT LOWER(unnest($1::text[])) as ingredient
        ),
        recipe_matches AS (
          SELECT 
            r.id,
            r.title,
            COUNT(DISTINCT i.id) as matched_ingredients
          FROM recipes r
          JOIN recipe_ingredients ri ON r.id = ri.recipe_id
          JOIN ingredients i ON ri.ingredient_id = i.id
          JOIN user_ingredients ui ON LOWER(i.name) = ui.ingredient
          WHERE r.id NOT IN (SELECT unnest($2::int[]))
          GROUP BY r.id, r.title
          HAVING COUNT(DISTINCT i.id) >= 1
        )
        SELECT * FROM recipe_matches
        ORDER BY matched_ingredients DESC;
      `;
      
      excludedMatches = await pool.query(excludedQuery, [ingredients, viewedIds]);
    }
    
    res.json({
      deviceId,
      viewedRecipeIds: viewedIds,
      allMatchingRecipes: allMatches.rows,
      matchingRecipesAfterExclusion: excludedMatches.rows,
      debug: {
        totalMatches: allMatches.rows.length,
        afterExclusion: excludedMatches.rows.length,
        excluded: allMatches.rows.length - excludedMatches.rows.length
      }
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});