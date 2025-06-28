// Debug endpoints to add to server/index.js

// Add this endpoint to check recipe_views table
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
        action: 'Run the migration: add-recipe-views-tracking.sql'
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
    
    // Get device view counts
    const deviceStats = await pool.query(`
      SELECT 
        device_id,
        COUNT(*) as recipes_viewed,
        MAX(viewed_at) as last_view
      FROM recipe_views
      GROUP BY device_id
      ORDER BY last_view DESC
      LIMIT 10
    `);
    
    res.json({
      tableExists: true,
      stats: stats.rows[0],
      recentViews: recentViews.rows,
      topDevices: deviceStats.rows
    });
    
  } catch (error) {
    res.status(500).json({ 
      error: error.message,
      hint: 'Table might not exist or have correct structure'
    });
  }
});

// Add this endpoint to manually check what a device has viewed
app.get('/api/debug/device-views/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;
    
    const views = await pool.query(`
      SELECT 
        rv.recipe_id,
        r.title,
        rv.viewed_at
      FROM recipe_views rv
      LEFT JOIN recipes r ON rv.recipe_id = r.id
      WHERE rv.device_id = $1
      ORDER BY rv.viewed_at DESC
    `, [deviceId]);
    
    res.json({
      deviceId,
      viewCount: views.rows.length,
      views: views.rows
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add this to the match endpoint for debugging
// Right after the excludedRecipeIds are set:
console.log(`Device ${deviceId} has viewed recipes:`, excludedRecipeIds);

// Right before returning the recipe:
console.log(`Sending recipe ${recipe.id} to device ${deviceId}`);

// Right after the INSERT INTO recipe_views:
console.log(`Recorded view: device ${deviceId} viewed recipe ${recipe.id}`);