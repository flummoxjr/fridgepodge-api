-- V6.7 Recipe Views Tracking
-- Track which users have seen which recipes to ensure users:
-- 1. Don't get their own submitted recipes back
-- 2. Only see each database recipe once

-- Create table to track recipe views
CREATE TABLE IF NOT EXISTS recipe_views (
    id SERIAL PRIMARY KEY,
    recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    device_id VARCHAR(255) NOT NULL,
    viewed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(recipe_id, device_id)
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_recipe_views_device ON recipe_views(device_id);
CREATE INDEX IF NOT EXISTS idx_recipe_views_recipe ON recipe_views(recipe_id);

-- Add submitted_by column to recipes table to track who submitted each recipe
ALTER TABLE recipes ADD COLUMN IF NOT EXISTS submitted_by VARCHAR(255);

-- Update existing recipes to have a submitted_by value if they don't have one
-- (using the first device_id that saved it from user_saved_recipes)
UPDATE recipes r
SET submitted_by = (
    SELECT device_id 
    FROM user_saved_recipes usr 
    WHERE usr.recipe_id = r.id 
    ORDER BY usr.saved_at 
    LIMIT 1
)
WHERE r.submitted_by IS NULL 
AND EXISTS (
    SELECT 1 
    FROM user_saved_recipes usr 
    WHERE usr.recipe_id = r.id
);