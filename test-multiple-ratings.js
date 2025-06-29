// Test script to verify multiple 5-star ratings are counted correctly
const axios = require('axios');

const API_BASE = 'https://fridgepodge-api.onrender.com';
// const API_BASE = 'http://localhost:3000'; // Use this for local testing

async function testMultipleRatings() {
  console.log('Testing Multiple 5-Star Ratings Functionality\n');
  
  try {
    // Step 1: Create a test recipe by saving a 5-star recipe
    console.log('1. Creating test recipe...');
    const testRecipe = {
      recipe: {
        title: `Test Recipe ${Date.now()}`,
        ingredients: ['test ingredient 1', 'test ingredient 2'],
        instructions: ['Step 1: Test', 'Step 2: Complete'],
        cuisine: 'test',
        servings: 4,
        prepTime: 15,
        cookTime: 30,
        difficulty: 'easy',
        nutrition: {
          calories: 300,
          protein: 20,
          carbs: 30,
          fat: 15,
          fiber: 5
        }
      },
      deviceId: 'test-device-1',
      rating: 5
    };
    
    const createResponse = await axios.post(`${API_BASE}/api/recipes/save-favorite`, testRecipe);
    const recipeId = createResponse.data.recipeId;
    console.log(`✓ Created recipe with ID: ${recipeId}\n`);
    
    // Step 2: Rate the recipe with 5 stars from multiple devices
    console.log('2. Rating recipe with 5 stars from multiple devices...');
    const devices = ['device-A', 'device-B', 'device-C', 'device-D', 'device-E'];
    
    for (const deviceId of devices) {
      console.log(`   Rating from ${deviceId}...`);
      await axios.post(`${API_BASE}/api/recipes/${recipeId}/rate`, {
        rating: 5,
        deviceId: deviceId
      });
      console.log(`   ✓ Rated successfully`);
    }
    console.log(`\n✓ Rated by ${devices.length} different devices\n`);
    
    // Step 3: Check the recipe details
    console.log('3. Fetching recipe details...');
    const recipeDetails = await axios.get(`${API_BASE}/api/recipes/${recipeId}`);
    console.log(`Recipe Rating Count: ${recipeDetails.data.ratingCount}`);
    console.log(`Recipe Average Rating: ${recipeDetails.data.rating}\n`);
    
    // Step 4: Check top community recipes
    console.log('4. Fetching top community recipes...');
    const topRecipes = await axios.get(`${API_BASE}/api/recipes/top-community`);
    
    const ourRecipe = topRecipes.data.find(r => r.id === recipeId);
    if (ourRecipe) {
      console.log('Found our test recipe in top community recipes:');
      console.log(`- Title: ${ourRecipe.title}`);
      console.log(`- Average Rating: ${ourRecipe.average_rating}/5.0`);
      console.log(`- Total Ratings: ${ourRecipe.rating_count}`);
      console.log(`- Five Star Count: ${ourRecipe.five_star_count}`);
      
      if (ourRecipe.rating_count === devices.length) {
        console.log('\n✅ SUCCESS: Multiple ratings are counted correctly!');
      } else {
        console.log(`\n❌ ERROR: Expected ${devices.length} ratings but got ${ourRecipe.rating_count}`);
      }
    } else {
      console.log('\n❌ ERROR: Test recipe not found in top community recipes');
    }
    
    // Step 5: Direct database check (debug endpoint)
    console.log('\n5. Checking database directly...');
    try {
      const debugResponse = await axios.get(`${API_BASE}/api/debug/recipe-views`);
      console.log('Recipe views table stats:', debugResponse.data.stats);
    } catch (error) {
      console.log('Debug endpoint not accessible');
    }
    
  } catch (error) {
    console.error('\n❌ Test failed with error:');
    console.error(error.response ? error.response.data : error.message);
  }
}

// Run the test
testMultipleRatings();