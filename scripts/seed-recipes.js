const { Pool } = require('pg');
require('dotenv').config({ path: __dirname + '/../.env' });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function seedRecipes() {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Sample recipes to seed
    const recipes = [
      {
        title: "Classic Chicken Fried Rice",
        cuisine: "chinese",
        servings: 4,
        prepTime: 15,
        cookTime: 20,
        difficulty: "easy",
        ingredients: [
          { name: "chicken", amount: "1", unit: "lb", required: true },
          { name: "rice", amount: "3", unit: "cups", required: true },
          { name: "soy sauce", amount: "3", unit: "tbsp", required: true },
          { name: "eggs", amount: "2", unit: "whole", required: false },
          { name: "green onions", amount: "3", unit: "stalks", required: false },
          { name: "garlic", amount: "3", unit: "cloves", required: false },
          { name: "vegetable oil", amount: "2", unit: "tbsp", required: true }
        ],
        instructions: [
          "Cook rice according to package directions and let cool",
          "Cut chicken into small bite-sized pieces",
          "Heat oil in a large wok or skillet over high heat",
          "Add chicken and cook until golden brown",
          "Push chicken to the side, scramble eggs in the pan",
          "Add rice, breaking up any clumps",
          "Stir in soy sauce and mix everything together",
          "Garnish with sliced green onions and serve hot"
        ],
        nutrition: {
          calories: 420,
          protein: "28g",
          carbs: "45g",
          fat: "12g",
          fiber: "2g",
          sugar: "3g",
          sodium: "890mg"
        },
        dietary: ["gluten-free-adaptable", "dairy-free"]
      },
      {
        title: "One-Pot Pasta Primavera",
        cuisine: "italian",
        servings: 6,
        prepTime: 10,
        cookTime: 25,
        difficulty: "easy",
        ingredients: [
          { name: "pasta", amount: "1", unit: "lb", required: true },
          { name: "tomatoes", amount: "2", unit: "cups", required: true },
          { name: "garlic", amount: "4", unit: "cloves", required: true },
          { name: "olive oil", amount: "3", unit: "tbsp", required: true },
          { name: "vegetables", amount: "3", unit: "cups", required: false },
          { name: "basil", amount: "1/4", unit: "cup", required: false },
          { name: "parmesan", amount: "1/2", unit: "cup", required: false }
        ],
        instructions: [
          "Place pasta, tomatoes, garlic, and olive oil in a large pot",
          "Add 4 cups of water and bring to a boil",
          "Stir frequently as pasta cooks",
          "Add vegetables in the last 5 minutes of cooking",
          "Season with salt and pepper",
          "Top with fresh basil and parmesan before serving"
        ],
        nutrition: {
          calories: 380,
          protein: "14g",
          carbs: "68g",
          fat: "8g",
          fiber: "5g",
          sugar: "8g",
          sodium: "340mg"
        },
        dietary: ["vegetarian", "vegan-adaptable"]
      },
      {
        title: "Simple Beef Tacos",
        cuisine: "mexican",
        servings: 4,
        prepTime: 10,
        cookTime: 15,
        difficulty: "easy",
        ingredients: [
          { name: "ground beef", amount: "1", unit: "lb", required: true },
          { name: "taco seasoning", amount: "2", unit: "tbsp", required: true },
          { name: "tortillas", amount: "8", unit: "small", required: true },
          { name: "cheese", amount: "1", unit: "cup", required: false },
          { name: "lettuce", amount: "2", unit: "cups", required: false },
          { name: "tomatoes", amount: "1", unit: "cup", required: false },
          { name: "sour cream", amount: "1/2", unit: "cup", required: false }
        ],
        instructions: [
          "Brown ground beef in a large skillet",
          "Drain excess fat",
          "Add taco seasoning and 1/4 cup water",
          "Simmer for 5 minutes",
          "Warm tortillas in microwave or on stovetop",
          "Fill tortillas with beef and desired toppings",
          "Serve immediately"
        ],
        nutrition: {
          calories: 450,
          protein: "25g",
          carbs: "32g",
          fat: "24g",
          fiber: "4g",
          sugar: "4g",
          sodium: "780mg"
        },
        dietary: ["gluten-free-adaptable"]
      }
    ];
    
    for (const recipe of recipes) {
      // Insert recipe
      const recipeResult = await client.query(
        `INSERT INTO recipes (title, cuisine, servings, prep_time, cook_time, difficulty, source_type)
         VALUES ($1, $2, $3, $4, $5, $6, 'database')
         RETURNING id`,
        [recipe.title, recipe.cuisine, recipe.servings, recipe.prepTime, recipe.cookTime, recipe.difficulty]
      );
      
      const recipeId = recipeResult.rows[0].id;
      console.log(`Created recipe: ${recipe.title} (ID: ${recipeId})`);
      
      // Insert ingredients
      for (const ing of recipe.ingredients) {
        // First, ensure ingredient exists
        const ingResult = await client.query(
          `INSERT INTO ingredients (name) 
           VALUES ($1) 
           ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
           RETURNING id`,
          [ing.name.toLowerCase()]
        );
        
        // Link to recipe
        await client.query(
          `INSERT INTO recipe_ingredients (recipe_id, ingredient_id, amount, unit, is_required)
           VALUES ($1, $2, $3, $4, $5)`,
          [recipeId, ingResult.rows[0].id, ing.amount, ing.unit, ing.required]
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
      
      // Insert nutrition
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
      if (recipe.dietary) {
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
    }
    
    // Add some ingredient aliases for better matching
    const aliases = [
      { ingredient: 'chicken', alias: 'chicken breast' },
      { ingredient: 'chicken', alias: 'chicken thighs' },
      { ingredient: 'pasta', alias: 'spaghetti' },
      { ingredient: 'pasta', alias: 'penne' },
      { ingredient: 'vegetables', alias: 'mixed vegetables' },
      { ingredient: 'vegetables', alias: 'veggies' },
      { ingredient: 'ground beef', alias: 'beef' },
      { ingredient: 'ground beef', alias: 'hamburger' }
    ];
    
    for (const alias of aliases) {
      const ingResult = await client.query(
        'SELECT id FROM ingredients WHERE name = $1',
        [alias.ingredient]
      );
      
      if (ingResult.rows.length > 0) {
        await client.query(
          `INSERT INTO ingredient_aliases (ingredient_id, alias) 
           VALUES ($1, $2) 
           ON CONFLICT DO NOTHING`,
          [ingResult.rows[0].id, alias.alias]
        );
      }
    }
    
    await client.query('COMMIT');
    console.log('\nSeeding complete! Added', recipes.length, 'recipes to the database.');
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Seeding failed:', error);
    throw error;
  } finally {
    client.release();
    pool.end();
  }
}

seedRecipes().catch(console.error);