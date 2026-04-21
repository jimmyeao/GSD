class GalagaGame {
    constructor() {
        this.canvas = document.getElementById('galaga-canvas');
        this.ctx = this.canvas.getContext('2d');
        this.width = this.canvas.width;
        this.height = this.canvas.height;
        
        this.score = 0;
        this.lives = 3;
        this.level = 1;
        this.gameActive = false;
        this.paused = false;
        
        this.player = null;
        this.bullets = [];
        this.enemies = [];
        this.enemyBullets = [];
        this.particles = [];
        this.enemyDirection = 1;
        this.enemySpeed = 0.3;
        this.lastEnemyMove = 0;
        this.enemyMoveInterval = 1200;
        
        this.keys = {};
        
        this.setupInput();
        this.setupButtons();
        this.drawMenu();
    }
    
    setupInput() {
        window.addEventListener('keydown', (e) => {
            this.keys[e.code] = true;
            
            if (e.code === 'Space' && this.gameActive && !this.paused) {
                this.playerShoot();
            }
            
            if (e.code === 'KeyP' && this.gameActive) {
                this.togglePause();
            }
        });
        
        window.addEventListener('keyup', (e) => {
            this.keys[e.code] = false;
        });
    }
    
    setupButtons() {
        const backBtn = document.getElementById('back-btn');
        if (backBtn) {
            backBtn.addEventListener('click', () => {
                window.location.href = 'index.html';
            });
        }
        
        const restartBtn = document.getElementById('restart-btn');
        if (restartBtn) {
            restartBtn.addEventListener('click', () => {
                this.startGame();
            });
        }
    }
    
    startGame() {
        this.score = 0;
        this.lives = 3;
        this.level = 1;
        this.gameActive = true;
        this.paused = false;
        
        this.player = {
            x: this.width / 2,
            y: this.height - 50,
            width: 30,
            height: 30,
            speed: 5,
            cooldown: 0,
            invulnerable: 0
        };
        
        this.bullets = [];
        this.enemyBullets = [];
        this.enemies = [];
        this.particles = [];
        this.enemyDirection = 1;
        this.enemySpeed = 0.3;
        this.lastEnemyMove = 0;
        this.enemyMoveInterval = 1200;
        
        this.createEnemies();
        this.updateUI();
        this.gameLoop();
    }
    
    createEnemies() {
        this.enemies = [];
        const rows = 4 + Math.min(this.level, 2); // Max 6 rows
        const cols = 6 + Math.min(this.level, 2); // Max 8 cols
        
        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < cols; col++) {
                this.enemies.push({
                    x: 100 + col * 70,
                    y: 50 + row * 60,
                    width: 40,
                    height: 40,
                    type: row < 2 ? 'fighter' : 'boss',
                    health: row < 2 ? 1 : 3,
                    active: true,
                    shootTimer: Math.random() * 2000 + 1000, // Random initial delay
                    // Swoop state
                    swoopTimer: 0,
                    swoopDuration: 0,
                    swoopStartX: 0,
                    swoopStartY: 0,
                    isSwooping: false,
                    swoopPhase: 0 // 0: start, 1: down, 2: up, 3: return
                });
            }
        }
    }
    
    playerShoot() {
        if (this.player.cooldown <= 0 && this.player.invulnerable <= 0) {
            this.bullets.push({
                x: this.player.x,
                y: this.player.y - 15,
                width: 4,
                height: 10,
                speed: 10
            });
            this.player.cooldown = 15;
        }
    }
    
    togglePause() {
        this.paused = !this.paused;
        if (!this.paused) {
            this.gameLoop();
        }
    }
    
    update() {
        if (!this.gameActive || this.paused) return;
        
        const now = Date.now();
        
        // Player movement
        if (this.keys['ArrowLeft'] && this.player.x > this.player.width/2) {
            this.player.x -= this.player.speed;
        }
        if (this.keys['ArrowRight'] && this.player.x < this.width - this.player.width/2) {
            this.player.x += this.player.speed;
        }
        
        // Player cooldown and invulnerability
        if (this.player.cooldown > 0) this.player.cooldown--;
        if (this.player.invulnerable > 0) this.player.invulnerable--;
        
        // Update player bullets
        this.bullets.forEach(bullet => {
            bullet.y -= bullet.speed;
        });
        
        // Remove off-screen bullets
        this.bullets = this.bullets.filter(bullet => bullet.y > -20);
        
        // Update enemy bullets
        this.enemyBullets.forEach(bullet => {
            bullet.y += bullet.speed;
        });
        
        // Remove off-screen bullets
        this.enemyBullets = this.enemyBullets.filter(bullet => bullet.y < this.height + 20);
        
        // Move enemies (Formation Movement)
        if (now - this.lastEnemyMove > this.enemyMoveInterval) {
            this.lastEnemyMove = now;
            
            let hitEdge = false;
            this.enemies.forEach(enemy => {
                if (!enemy.active || enemy.isSwooping) return;
                
                enemy.x += this.enemySpeed * this.enemyDirection;
                
                if (enemy.x + enemy.width > this.width - 20 || enemy.x < 20) {
                    hitEdge = true;
                }
            });
            
            if (hitEdge) {
                this.enemyDirection *= -1;
                this.enemies.forEach(enemy => {
                    if (!enemy.active || enemy.isSwooping) return;
                    enemy.y += 20;
                });
            }
            
            // Adjust move interval based on level
            this.enemyMoveInterval = Math.max(400, 1200 - (this.level * 100));
        }
        
        // Handle Swooping Enemies
        this.enemies.forEach(enemy => {
            if (!enemy.active) return;
            
            if (enemy.isSwooping) {
                this.updateSwoop(enemy);
            } else {
                // Chance to start swooping
                enemy.swoopTimer += 16; // approx 60fps
                if (enemy.swoopTimer > 3000 + Math.random() * 5000) { // Random interval 3-8 seconds
                    if (Math.random() < 0.1 + (this.level * 0.05)) { // Chance increases with level
                        enemy.isSwooping = true;
                        enemy.swoopTimer = 0;
                        enemy.swoopStartX = enemy.x;
                        enemy.swoopStartY = enemy.y;
                        enemy.swoopPhase = 0;
                        enemy.swoopDuration = 0;
                    }
                }
            }
        });
        
        // Enemy shooting
        this.enemies.forEach(enemy => {
            if (!enemy.active) return;
            
            enemy.shootTimer -= 16; // Approx 60fps
            
            if (enemy.shootTimer <= 0) {
                // Reduced fire rate
                const fireChance = 0.002 + (this.level * 0.0005); // Much lower base chance
                if (Math.random() < fireChance) {
                    this.enemyBullets.push({
                        x: enemy.x + enemy.width / 2,
                        y: enemy.y + enemy.height,
                        width: 4,
                        height: 10,
                        speed: 2 + (this.level * 0.2) // Reduced speed increase
                    });
                    // Reset timer with longer delay
                    enemy.shootTimer = 1000 + Math.random() * 2000;
                }
            }
        });
        
        // Check collisions
        this.checkCollisions();
        
        // Check if level complete
        if (this.enemies.filter(e => e.active).length === 0) {
            this.level++;
            this.enemySpeed += 0.1;
            this.createEnemies();
        }
        
        this.updateUI();
    }
    
    updateSwoop(enemy) {
        enemy.swoopDuration += 16;
        
        if (enemy.swoopPhase === 0) {
            // Start swoop: move down
            enemy.y += 3;
            enemy.x += Math.sin(enemy.swoopDuration * 0.05) * 2; // Wavy motion
            if (enemy.y > this.height - 100) {
                enemy.swoopPhase = 1;
            }
        } else if (enemy.swoopPhase === 1) {
            // Move back up
            enemy.y -= 3;
            enemy.x += Math.sin(enemy.swoopDuration * 0.05) * 2;
            if (enemy.y <= enemy.swoopStartY + 20) {
                enemy.swoopPhase = 2;
            }
        } else if (enemy.swoopPhase === 2) {
            // Return to formation position
            const targetEnemy = this.enemies.find(e => 
                e.active && !e.isSwooping && 
                Math.abs(e.x - (enemy.swoopStartX + (enemy.swoopStartY - enemy.y) * 0)) < 50 &&
                Math.abs(e.y - enemy.swoopStartY) < 50
            );
            
            if (targetEnemy) {
                // Just find an empty spot in formation
                let foundSpot = false;
                for (let e of this.enemies) {
                    if (e === enemy) continue;
                    if (!e.active || e.isSwooping) continue;
                    
                    // Check if this spot is empty
                    let spotOccupied = false;
                    for (let other of this.enemies) {
                        if (other === e) continue;
                        if (Math.abs(other.x - e.x) < 10 && Math.abs(other.y - e.y) < 10) {
                            spotOccupied = true;
                            break;
                        }
                    }
                    
                    if (!spotOccupied && Math.abs(e.x - enemy.swoopStartX) < 100 && Math.abs(e.y - enemy.swoopStartY) < 100) {
                        // Move towards this spot
                        const dx = e.x - enemy.x;
                        const dy = e.y - enemy.y;
                        const dist = Math.sqrt(dx*dx + dy*dy);
                        if (dist > 1) {
                            enemy.x += (dx / dist) * 4;
                            enemy.y += (dy / dist) * 4;
                        } else {
                            enemy.x = e.x;
                            enemy.y = e.y;
                            enemy.isSwooping = false;
                            foundSpot = true;
                            break;
                        }
                    }
                }
                if (!foundSpot && enemy.y < enemy.swoopStartY) {
                    enemy.y += 2;
                    if (enemy.y >= enemy.swoopStartY) {
                        enemy.y = enemy.swoopStartY;
                        enemy.x = enemy.swoopStartX;
                        enemy.isSwooping = false;
                    }
                }
            } else {
                // No spot found, just return to start
                const dx = enemy.swoopStartX - enemy.x;
                const dy = enemy.swoopStartY - enemy.y;
                const dist = Math.sqrt(dx*dx + dy*dy);
                if (dist > 1) {
                    enemy.x += (dx / dist) * 4;
                    enemy.y += (dy / dist) * 4;
                } else {
                    enemy.isSwooping = false;
                }
            }
        }
    }
    
    checkCollisions() {
        // Player bullets vs enemies
        for (let i = this.bullets.length - 1; i >= 0; i--) {
            const bullet = this.bullets[i];
            
            for (let j = 0; j < this.enemies.length; j++) {
                const enemy = this.enemies[j];
                
                if (enemy.active && this.rectIntersect(bullet.x, bullet.y, bullet.width, bullet.height,
                                                     enemy.x, enemy.y, enemy.width, enemy.height)) {
                    enemy.health--;
                    this.bullets.splice(i, 1);
                    
                    if (enemy.health <= 0) {
                        enemy.active = false;
                        this.score += enemy.type === 'boss' ? 100 : 50;
                        this.createExplosion(enemy.x + enemy.width/2, enemy.y + enemy.height/2);
                    } else {
                        this.createExplosion(enemy.x + enemy.width/2, enemy.y + enemy.height/2, '#ffffff');
                    }
                    
                    break;
                }
            }
        }
        
        // Enemy bullets vs player
        if (this.player.invulnerable <= 0) {
            for (let i = this.enemyBullets.length - 1; i >= 0; i--) {
                const bullet = this.enemyBullets[i];
                
                if (this.rectIntersect(bullet.x, bullet.y, bullet.width, bullet.height,
                                     this.player.x - this.player.width/2, this.player.y - this.player.height/2,
                                     this.player.width, this.player.height)) {
                    
                    this.enemyBullets.splice(i, 1);
                    this.lives--;
                    this.player.invulnerable = 180; // 3 seconds invulnerability
                    this.createExplosion(this.player.x, this.player.y);
                    
                    if (this.lives <= 0) {
                        this.gameOver();
                    }
                    
                    break;
                }
            }
        }
        
        // Player vs enemies
        if (this.player.invulnerable <= 0) {
            this.enemies.forEach(enemy => {
                if (enemy.active && this.rectIntersect(this.player.x - this.player.width/2, this.player.y - this.player.height/2,
                                                      this.player.width, this.player.height,
                                                      enemy.x, enemy.y, enemy.width, enemy.height)) {
                    
                    enemy.active = false;
                    this.lives--;
                    this.player.invulnerable = 180;
                    this.createExplosion(enemy.x + enemy.width/2, enemy.y + enemy.height/2);
                    this.createExplosion(this.player.x, this.player.y);
                    
                    if (this.lives <= 0) {
                        this.gameOver();
                    }
                }
            });
        }
    }
    
    rectIntersect(x1, y1, w1, h1, x2, y2, w2, h2) {
        return x2 < x1 + w1 && x2 + w2 > x1 && y2 < y1 + h1 && y2 + h2 > y1;
    }
    
    createExplosion(x, y, color = null) {
        const particleCount = 10;
        for (let i = 0; i < particleCount; i++) {
            this.particles.push({
                x: x,
                y: y,
                vx: (Math.random() - 0.5) * 4,
                vy: (Math.random() - 0.5) * 4,
                life: 20,
                color: color || ['#ff0000', '#ffaa00', '#ffff00'][Math.floor(Math.random() * 3)],
                alpha: 1.0
            });
        }
    }
    
    draw() {
        // Clear canvas
        this.ctx.fillStyle = '#000000';
        this.ctx.fillRect(0, 0, this.width, this.height);
        
        // Draw stars background
        this.ctx.fillStyle = '#ffffff';
        for (let i = 0; i < 50; i++) {
            const x = (i * 137) % this.width;
            const y = (i * 241) % this.height;
            this.ctx.fillRect(x, y, 2, 2);
        }
        
        if (!this.gameActive) return;
        
        // Draw particles
        this.particles.forEach((particle, index) => {
            particle.x += particle.vx;
            particle.y += particle.vy;
            particle.life--;
            particle.alpha = particle.life / 20;
            
            this.ctx.fillStyle = particle.color;
            this.ctx.globalAlpha = particle.alpha;
            this.ctx.beginPath();
            this.ctx.arc(particle.x, particle.y, 3, 0, Math.PI * 2);
            this.ctx.fill();
            this.ctx.globalAlpha = 1.0;
            
            if (particle.life <= 0) {
                this.particles.splice(index, 1);
            }
        });
        
        // Draw enemies
        this.enemies.forEach(enemy => {
            if (enemy.active) {
                this.drawEnemy(enemy);
            }
        });
        
        // Draw player
        if (this.player.invulnerable <= 0 || Math.floor(Date.now() / 100) % 2 === 0) {
            this.drawPlayer();
        }
        
        // Draw player bullets
        this.ctx.fillStyle = '#00ff00';
        this.bullets.forEach(bullet => {
            this.ctx.fillRect(bullet.x, bullet.y, bullet.width, bullet.height);
        });
        
        // Draw enemy bullets
        this.ctx.fillStyle = '#ff0000';
        this.enemyBullets.forEach(bullet => {
            this.ctx.fillRect(bullet.x, bullet.y, bullet.width, bullet.height);
        });
    }
    
    drawPlayer() {
        const x = this.player.x;
        const y = this.player.y;
        const w = this.player.width;
        const h = this.player.height;
        
        // Draw a more detailed fighter jet
        this.ctx.fillStyle = '#00ffff';
        
        // Main body (fuselage)
        this.ctx.fillRect(x - 3, y - h/2, 6, h);
        
        // Wings
        this.ctx.fillRect(x - w/2, y + h/4, w, h/4);
        
        // Wing tips
        this.ctx.fillStyle = '#00cccc';
        this.ctx.fillRect(x - w/2, y + h/4, 8, h/4);
        this.ctx.fillRect(x + w/2 - 8, y + h/4, 8, h/4);
        
        // Cockpit
        this.ctx.fillStyle = '#ffffff';
        this.ctx.fillRect(x - 2, y - h/2 + 5, 4, 6);
        
        // Engine glow
        this.ctx.fillStyle = '#ffaa00';
        this.ctx.fillRect(x - 2, y + h/2, 4, 4 + Math.random() * 4);
    }
    
    drawEnemy(enemy) {
        const x = enemy.x;
        const y = enemy.y;
        const w = enemy.width;
        const h = enemy.height;
        
        if (enemy.type === 'fighter') {
            // Draw a bug-like alien (Galaga style)
            this.ctx.fillStyle = '#ff00ff';
            
            // Body
            this.ctx.fillRect(x + w/2 - 6, y + h/4, 12, h/2);
            
            // Head
            this.ctx.fillStyle = '#ff66ff';
            this.ctx.fillRect(x + w/2 - 8, y, 16, h/4);
            
            // Eyes
            this.ctx.fillStyle = '#ffffff';
            this.ctx.fillRect(x + w/2 - 6, y + 4, 4, 4);
            this.ctx.fillRect(x + w/2 + 2, y + 4, 4, 4);
            this.ctx.fillStyle = '#000000';
            this.ctx.fillRect(x + w/2 - 5, y + 5, 2, 2);
            this.ctx.fillRect(x + w/2 + 3, y + 5, 2, 2);
            
            // Antennae
            this.ctx.fillStyle = '#ff00ff';
            this.ctx.fillRect(x + w/2 - 8, y - 6, 2, 6);
            this.ctx.fillRect(x + w/2 + 6, y - 6, 2, 6);
            
            // Legs (left)
            this.ctx.fillRect(x, y + h/2 - 2, 6, 2);
            this.ctx.fillRect(x + 2, y + h/2 + 4, 4, 2);
            
            // Legs (right)
            this.ctx.fillRect(x + w - 6, y + h/2 - 2, 6, 2);
            this.ctx.fillRect(x + w - 6, y + h/2 + 4, 4, 2);
            
            // Wings
            this.ctx.fillStyle = '#cc00cc';
            this.ctx.fillRect(x - 4, y + h/4, 8, h/4);
            this.ctx.fillRect(x + w - 4, y + h/4, 8, h/4);
        } else {
            // Draw a bird-like alien (Galaga boss style)
            this.ctx.fillStyle = '#ffff00';
            
            // Body
            this.ctx.fillRect(x + w/2 - 8, y + h/4, 16, h/2);
            
            // Head
            this.ctx.fillStyle = '#ffcc00';
            this.ctx.fillRect(x + w/2 - 10, y, 20, h/3);
            
            // Beak
            this.ctx.fillStyle = '#ff6600';
            this.ctx.fillRect(x + w/2 - 2, y + h/3, 4, 6);
            
            // Eyes
            this.ctx.fillStyle = '#000000';
            this.ctx.fillRect(x + w/2 - 6, y + 6, 4, 4);
            this.ctx.fillRect(x + w/2 + 2, y + 6, 4, 4);
            
            // Wings
            this.ctx.fillStyle = '#ffcc00';
            // Left wing
            this.ctx.fillRect(x - 10, y + h/4, 12, h/3);
            this.ctx.fillRect(x - 14, y + h/3, 8, h/6);
            // Right wing
            this.ctx.fillRect(x + w - 2, y + h/4, 12, h/3);
            this.ctx.fillRect(x + w + 6, y + h/3, 8, h/6);
            
            // Tail
            this.ctx.fillStyle = '#ffaa00';
            this.ctx.fillRect(x + w/2 - 6, y + h*2/3, 12, h/3);
        }
    }
    
    updateUI() {
        document.getElementById('score').textContent = this.score;
        document.getElementById('lives').textContent = this.lives;
        document.getElementById('level').textContent = this.level;
    }
    
    gameOver() {
        this.gameActive = false;
        this.ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        this.ctx.fillRect(0, 0, this.width, this.height);
        
        this.ctx.fillStyle = '#ff0000';
        this.ctx.font = '48px Arial';
        this.ctx.textAlign = 'center';
        this.ctx.fillText('GAME OVER', this.width / 2, this.height / 2 - 30);
        
        this.ctx.fillStyle = '#ffffff';
        this.ctx.font = '24px Arial';
        this.ctx.fillText('Final Score: ' + this.score, this.width / 2, this.height / 2 + 20);
        
        const restartBtn = document.createElement('button');
        restartBtn.textContent = 'Restart Game';
        restartBtn.className = 'game-btn';
        restartBtn.style.marginTop = '20px';
        restartBtn.onclick = () => this.startGame();
        
        const container = document.querySelector('.game-container');
        if (this.restartBtn) container.removeChild(this.restartBtn);
        container.appendChild(restartBtn);
        
        this.restartBtn = restartBtn;
    }
    
    drawMenu() {
        this.ctx.fillStyle = '#000000';
        this.ctx.fillRect(0, 0, this.width, this.height);
        
        this.ctx.fillStyle = '#00ff00';
        this.ctx.font = '48px Arial';
        this.ctx.textAlign = 'center';
        this.ctx.fillText('GALAGA', this.width / 2, this.height / 2 - 60);
        
        this.ctx.fillStyle = '#ffffff';
        this.ctx.font = '24px Arial';
        this.ctx.fillText('Press any key to start', this.width / 2, this.height / 2 + 20);
        
        const startHandler = (e) => {
            window.removeEventListener('keydown', startHandler);
            this.startGame();
        };
        window.addEventListener('keydown', startHandler);
    }
    
    gameLoop() {
        if (!this.gameActive || this.paused) return;
        
        this.update();
        this.draw();
        
        requestAnimationFrame(() => this.gameLoop());
    }
}

window.addEventListener('load', () => {
    new GalagaGame();
});
