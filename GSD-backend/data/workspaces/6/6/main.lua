-- main.lua
local Config = require("config")

-- Game State
local gameState = {
    width = 0,
    height = 0,
    camera = { x = 0, y = 0 },
    player = nil,
    enemies = {},
    bullets = {},
    particles = {},
    levelWidth = 4000,
    score = 0,
    timeSinceLastSpawn = 0
}

function love.load()
    -- Load assets
    love.graphics.setNewFont(14)
    
    -- Initialize game state
    gameState.width = love.graphics.getWidth()
    gameState.height = love.graphics.getHeight()
    
    -- Create Player
    gameState.player = {
        x = gameState.levelWidth / 2,
        y = 100,
        width = 30,
        height = 15,
        speed = 200,
        fuel = 100,
        alive = true,
        invulnerable = 0,
        angle = 0
    }
    
    -- Initialize Camera
    gameState.camera.x = gameState.player.x - gameState.width / 2
    gameState.camera.y = gameState.player.y - gameState.height / 2
    
    gameState.score = 0
    gameState.timeSinceLastSpawn = 0
    
    print("Defender Remake Loaded")
end

function love.update(dt)
    if not gameState.player.alive then return end
    
    -- Update Camera to follow player
    gameState.camera.x = gameState.player.x - gameState.width / 2
    gameState.camera.y = gameState.player.y - gameState.height / 2
    
    -- Keep camera within bounds
    gameState.camera.x = math.max(0, math.min(gameState.camera.x, gameState.levelWidth - gameState.width))
    gameState.camera.y = math.max(0, math.min(gameState.camera.y, gameState.height - gameState.height))
    
    -- Update Player
    updatePlayer(dt)
    
    -- Update Entities
    updateBullets(dt)
    updateEnemies(dt)
    updateParticles(dt)
    
    -- Update invulnerability timer
    if gameState.player.invulnerable > 0 then
        gameState.player.invulnerable = gameState.player.invulnerable - dt
    end
end

function updatePlayer(dt)
    local p = gameState.player
    
    -- Movement
    if love.keyboard.isDown("left") then
        p.x = p.x - p.speed * dt
        p.fuel = math.max(0, p.fuel - 10 * dt)
        p.angle = -math.pi / 4
    elseif love.keyboard.isDown("right") then
        p.x = p.x + p.speed * dt
        p.fuel = math.max(0, p.fuel - 10 * dt)
        p.angle = math.pi / 4
    else
        p.angle = 0
    end
    
    if love.keyboard.isDown("up") then
        p.y = p.y - p.speed * 0.5 * dt
    end
    if love.keyboard.isDown("down") then
        p.y = p.y + p.speed * 0.5 * dt
    end
    
    -- Boundaries
    p.x = math.max(0, math.min(p.x, gameState.levelWidth))
    p.y = math.max(0, math.min(p.y, 768))
    
    -- Shooting
    if love.keyboard.isDown("space") then
        if not p.lastShot or (love.timer.getTime() - p.lastShot) > Config.PLAYER_SHOT_INTERVAL then
            table.insert(gameState.bullets, {
                x = p.x + p.width/2,
                y = p.y,
                vx = 400,
                vy = 0,
                life = Config.BULLET_LIFE
            })
            p.lastShot = love.timer.getTime()
        end
    end
end

function updateBullets(dt)
    for i = #gameState.bullets, 1, -1 do
        local b = gameState.bullets[i]
        b.x = b.x + b.vx * dt
        b.y = b.y + b.vy * dt
        b.life = b.life - dt
        
        if b.life <= 0 then
            table.remove(gameState.bullets, i)
        end
    end
end

function updateEnemies(dt)
    -- Enemy spawning
    gameState.timeSinceLastSpawn = gameState.timeSinceLastSpawn + dt
    if gameState.timeSinceLastSpawn >= Config.ENEMY_SPAWN_INTERVAL then
        gameState.timeSinceLastSpawn = 0
        spawnEnemy()
    end
    
    for i = #gameState.enemies, 1, -1 do
        local e = gameState.enemies[i]
        
        -- Move towards player
        local dx = gameState.player.x - e.x
        local dy = gameState.player.y - e.y
        local dist = math.sqrt(dx*dx + dy*dy)
        
        if dist > 0 then
            e.x = e.x + (dx / dist) * e.speed * dt
            e.y = e.y + (dy / dist) * e.speed * dt
        end
        
        -- Collision with player
        if checkCollision(gameState.player, e) and gameState.player.invulnerable <= 0 then
            gameState.player.alive = false
            gameState.player.invulnerable = 0
            print("Game Over!")
            createExplosion(gameState.player.x, gameState.player.y, 15, {1, 1, 0})
        end
        
        -- Collision with bullets
        for j = #gameState.bullets, 1, -1 do
            local b = gameState.bullets[j]
            if b.x > e.x - e.width/2 and b.x < e.x + e.width/2 and
               b.y > e.y - e.height/2 and b.y < e.y + e.height/2 then
                table.remove(gameState.enemies, i)
                table.remove(gameState.bullets, j)
                gameState.score = gameState.score + Config.SCORE_PER_ENEMY
                
                -- Create explosion
                createExplosion(e.x, e.y, Config.EXPLOSION_PARTICLES, {1, 0, 0})
                
                -- Chance to drop fuel
                if math.random() < Config.FUEL_DROP_CHANCE then
                    table.insert(gameState.particles, {
                        x = e.x,
                        y = e.y,
                        vx = 0,
                        vy = -50,
                        life = 5,
                        type = "fuel"
                    })
                end
                break
            end
        end
    end
end

function createExplosion(x, y, count, color)
    for i = 1, count do
        local angle = math.random() * math.pi * 2
        local speed = math.random() * 100 + 50
        table.insert(gameState.particles, {
            x = x,
            y = y,
            vx = math.cos(angle) * speed,
            vy = math.sin(angle) * speed,
            life = Config.EXPLOSION_LIFE,
            color = color
        })
    end
end

function updateParticles(dt)
    for i = #gameState.particles, 1, -1 do
        local p = gameState.particles[i]
        p.x = p.x + p.vx * dt
        p.y = p.y + p.vy * dt
        p.life = p.life - dt
        
        if p.life <= 0 then
            table.remove(gameState.particles, i)
        end
    end
end

function checkCollision(a, b)
    return a.x < b.x + b.width and
           a.x + a.width > b.x and
           a.y < b.y + b.height and
           a.y + a.height > b.y
end

function spawnEnemy()
    local spawnX = gameState.camera.x + gameState.width + 50
    local spawnY = math.random(50, 700)
    
    table.insert(gameState.enemies, {
        x = spawnX,
        y = spawnY,
        width = 20,
        height = 20,
        speed = Config.ENEMY_SPEED,
        health = 1
    })
end

function love.draw()
    -- Clear Screen
    love.graphics.clear(0.1, 0.1, 0.2)
    
    love.graphics.push()
    
    -- Apply Camera
    love.graphics.translate(-gameState.camera.x, -gameState.camera.y)
    
    -- Draw Ground
    love.graphics.setColor(0.2, 0.5, 0.2)
    love.graphics.rectangle("fill", 0, 750, gameState.levelWidth, 18)
    
    -- Draw Player
    if gameState.player.alive then
        love.graphics.setColor(1, 1, 1)
        love.graphics.print("FUEL: " .. math.floor(gameState.player.fuel), gameState.player.x - 20, gameState.player.y - 30)
        love.graphics.print("SCORE: " .. gameState.score, gameState.player.x - 20, gameState.player.y - 15)
        
        -- Draw Ship
        love.graphics.setColor(0, 1, 1)
        love.graphics.polygon("fill", {
            gameState.player.x, gameState.player.y - gameState.player.height/2,
            gameState.player.x + gameState.player.width, gameState.player.y,
            gameState.player.x, gameState.player.y + gameState.player.height/2,
            gameState.player.x - gameState.player.width/2, gameState.player.y
        })
    end
    
    -- Draw Enemies
    love.graphics.setColor(1, 0, 0)
    for _, e in ipairs(gameState.enemies) do
        love.graphics.rectangle("fill", e.x - e.width/2, e.y - e.height/2, e.width, e.height)
    end
    
    -- Draw Bullets
    love.graphics.setColor(1, 1, 0)
    for _, b in ipairs(gameState.bullets) do
        love.graphics.circle("fill", b.x, b.y, Config.BULLET_RADIUS)
    end
    
    -- Draw Particles
    for _, p in ipairs(gameState.particles) do
        if p.type == "fuel" then
            love.graphics.setColor(0, 1, 0)
            love.graphics.print("F", p.x, p.y)
        else
            love.graphics.setColor(p.color[1], p.color[2], p.color[3])
            love.graphics.circle("fill", p.x, p.y, 2)
        end
    end
    
    love.graphics.pop()
    
    -- Draw UI
    love.graphics.setColor(1, 1, 1)
    love.graphics.print("Defender Remake", 10, 10)
    love.graphics.print("Use Arrow Keys to Move, Space to Shoot", 10, 30)
    
    if not gameState.player.alive then
        love.graphics.setColor(1, 0, 0)
        love.graphics.print("GAME OVER - Press R to Restart", gameState.width/2 - 100, gameState.height/2)
    end
end

function love.keypressed(key)
    if key == "r" and not gameState.player.alive then
        love.load()
    end
end