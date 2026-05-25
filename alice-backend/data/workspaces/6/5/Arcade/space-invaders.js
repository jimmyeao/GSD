class SpaceInvadersGame {
    constructor() {
        this.canvas = document.getElementById('space-invaders-canvas');
        this.ctx = this.canvas.getContext('2d');
        this.width = this.canvas.width;
        this.height = this.canvas.height;
        
        this.score = 0;
        this.lives = 3;
        this.level = 1;
        this.gameActive = false;
        this.paused = false;
        
        this.player = null;
        this.playerBullets = [];
        this.enemyBullets = [];
        this.invaders = [];
        this.particles = [];
        this.invaderDirection = 1;
        this.invaderSpeed = 0.5;
        this.lastInvaderMove = 0;
        this.invaderMoveInterval = 1000;
        
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
        document.getElementById('back-btn').addEventListener('click', () => {
            window.location.href = 'index.html';
        });
        
        document.getElementById('restart-btn')?.addEventListener('click', () => {
            this.startGame();
        });
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
            width: 40,
            height: 20,
            speed: 5,
            cooldown: 0,
            invulnerable: 0
        };
        
        this.playerBullets = [];
        this.enemyBullets = [];
        this.invaders = [];
        this.particles = [];
        this.invaderDirection = 1;
        this.invaderSpeed = 0.5;
        this.lastInvaderMove = 0;
        this.invaderMoveInterval = 1000;
        
        this.createInvaders();
        this.updateUI();
        this.gameLoop();
    }
    
    createInvaders() {
        this.invaders = [];
        const rows = 3 + Math.min(this.level, 2); // Max 5 rows
        const cols = 8 + Math.min(this.level, 2); // Max 10 cols
        
        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < cols; col++) {
                this.invaders.push({
                    x: 50 + col * 60,
                    y: 50 + row * 50,
                    width: 30,
                    height: 30,
                    type: row,
                    active: true
                });
            }
        }
    }
    
    playerShoot() {
        if (this.player.cooldown <= 0 && this.player.invulnerable <= 0) {
            this.playerBullets.push({
                x: this.player.x,
                y: this.player.y - 10,
                width: 4,
                height: 10,
                speed: 8
            });
            this.player.cooldown = 20; // Slightly slower fire rate
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
        this.playerBullets.forEach(bullet => {
            bullet.y -= bullet.speed;
        });
        
        // Remove off-screen bullets
        this.playerBullets = this.playerBullets.filter(bullet => bullet.y > -20);
        
        // Update enemy bullets
        this.enemyBullets.forEach(bullet => {
            bullet.y += bullet.speed;
        });
        
        // Remove off-screen bullets
        this.enemyBullets = this.enemyBullets.filter(bullet => bullet.y < this.height + 20);
        
        // Move invaders
        if (now - this.lastInvaderMove > this.invaderMoveInterval) {
            this.lastInvaderMove = now;
            
            let hitEdge = false;
            this.invaders.forEach(invader => {
                if (!invader.active) return;
                
                invader.x += this.invaderSpeed * this.invaderDirection;
                
                if (invader.x + invader.width > this.width - 20 || invader.x < 20) {
                    hitEdge = true;
                }
            });
            
            if (hitEdge) {
                this.invaderDirection *= -1;
                this.invaders.forEach(invader => {
                    if (!invader.active) return;
                    invader.y += 20;
                });
            }
            
            // Adjust move interval based on level
            this.invaderMoveInterval = Math.max(200, 1000 - (this.level * 80));
        }
        
        // Enemy shooting
        // Reduced fire rate significantly
        this.invaders.forEach(invader => {
            if (!invader.active) return;
            
            // Chance to fire is much lower now
            const fireChance = 0.001 + (this.level * 0.0003); 
            if (Math.random() < fireChance) {
                this.enemyBullets.push({
                    x: invader.x + invader.width / 2,
                    y: invader.y + invader.height,
                    width: 4,
                    height: 10,
                    speed: 2 + (this.level * 0.15) // Reduced speed increase
                });
            }
        });
        
        // Check collisions
        this.checkCollisions();
        
        // Check if level complete
        if (this.invaders.filter(e => e.active).length === 0) {
            this.level++;
            this.invaderSpeed += 0.1;
            this.createInvaders();
        }
        
        // Check if invaders reached bottom
        this.invaders.forEach(invader => {
            if (invader.active && invader.y + invader.height > this.player.y - 20) {
                this.gameOver();
            }
        });
        
        this.updateUI();
    }
    
    checkCollisions() {
        // Player bullets vs invaders
        for (let i = this.playerBullets.length - 1; i >= 0; i--) {
            const bullet = this.playerBullets[i];
            
            for (let j = 0; j < this.invaders.length; j++) {
                const invader = this.invaders[j];
                
                if (invader.active && this.rectIntersect(bullet.x, bullet.y, bullet.width, bullet.height,
                                                        invader.x, invader.y, invader.width, invader.height)) {
                    invader.active = false;
                    this.playerBullets.splice(i, 1);
                    this.score += 10 * (this.invaders.length - this.invaders.filter(e => e.active).length + 1);
                    this.createExplosion(invader.x + invader.width/2, invader.y + invader.height/2);
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
        
        // Invaders vs player
        if (this.player.invulnerable <= 0) {
            this.invaders.forEach(invader => {
                if (invader.active && this.rectIntersect(this.player.x - this.player.width/2, this.player.y - this.player.height/2,
                                                        this.player.width, this.player.height,
                                                        invader.x, invader.y, invader.width, invader.height)) {
                    
                    invader.active = false;
                    this.lives--;
                    this.player.invulnerable = 180;
                    this.createExplosion(invader.x + invader.width/2, invader.y + invader.height/2);
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
    
    createExplosion(x, y) {
        const particleCount = 8;
        for (let i = 0; i < particleCount; i++) {
            this.particles.push({
                x: x,
                y: y,
                vx: (Math.random() - 0.5) * 3,
                vy: (Math.random() - 0.5) * 3,
                life: 15,
                color: ['#ff0000', '#ffaa00', '#ffff00'][Math.floor(Math.random() * 3)],
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
            particle.alpha = particle.life / 15;
            
            this.ctx.fillStyle = particle.color;
            this.ctx.globalAlpha = particle.alpha;
            this.ctx.beginPath();
            this.ctx.arc(particle.x, particle.y, 2, 0, Math.PI * 2);
            this.ctx.fill();
            this.ctx.globalAlpha = 1.0;
            
            if (particle.life <= 0) {
                this.particles.splice(index, 1);
            }
        });
        
        // Draw invaders
        this.invaders.forEach(invader => {
            if (invader.active) {
                this.drawInvader(invader);
            }
        });
        
        // Draw player
        if (this.player.invulnerable <= 0 || Math.floor(Date.now() / 100) % 2 === 0) {
            this.drawPlayer();
        }
        
        // Draw player bullets
        this.ctx.fillStyle = '#00ff00';
        this.playerBullets.forEach(bullet => {
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
        
        this.ctx.fillStyle = '#00ff00';
        this.ctx.fillRect(x - w/2, y - h/2, w, h);
        this.ctx.fillStyle = '#00cc00';
        this.ctx.fillRect(x - w/4, y - h/2 - 5, w/2, 5);
    }
    
    drawInvader(invader) {
        const x = invader.x;
        const y = invader.y;
        const w = invader.width;
        const h = invader.height;
        
        const colors = ['#ff00ff', '#00ffff', '#ffff00', '#00ff00', '#ff0000'];
        this.ctx.fillStyle = colors[invader.type % colors.length];
        
        // Simple invader shape
        this.ctx.fillRect(x + w/4, y, w/2, h/2);
        this.ctx.fillRect(x, y + h/4, w, h/2);
        this.ctx.fillRect(x + w/4, y + h/2, w/2, h/2);
        
        // Eyes
        this.ctx.fillStyle = '#000000';
        this.ctx.fillRect(x + w/4, y + h/4, w/6, h/6);
        this.ctx.fillRect(x + w/2, y + h/4, w/6, h/6);
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
        this.ctx.fillText('SPACE INVADERS', this.width / 2, this.height / 2 - 60);
        
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
    new SpaceInvadersGame();
});
