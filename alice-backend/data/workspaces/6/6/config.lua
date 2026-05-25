-- config.lua
return {
    -- Game Constants
    GRAVITY = 0,
    LEVEL_WIDTH = 4000,
    GROUND_HEIGHT = 750,
    TERRAIN_SEGMENTS = 40,
    
    -- Player Constants
    PLAYER_SPEED = 200,
    PLAYER_TURN_RATE = 2.5,
    PLAYER_MAX_FUEL = 100,
    PLAYER_SHOT_INTERVAL = 0.15,
    PLAYER_RADIUS = 15,
    
    -- Bullet Constants
    BULLET_SPEED = 400,
    BULLET_LIFE = 2,
    BULLET_RADIUS = 3,
    
    -- Enemy Constants
    ENEMY_SPEED = 100,
    ENEMY_SPAWN_INTERVAL = 2,
    ENEMY_RADIUS = 15,
    
    -- Explosion Constants
    EXPLOSION_LIFE = 0.5,
    EXPLOSION_PARTICLES = 15,
    
    -- Background
    STAR_COUNT = 100,
    
    -- Game Constants
    PLAYER_INVULNERABLE_TIME = 2,
    SCORE_PER_ENEMY = 100,
    FUEL_DROP_CHANCE = 0.3,
    FUEL_AMOUNT = 25
}
