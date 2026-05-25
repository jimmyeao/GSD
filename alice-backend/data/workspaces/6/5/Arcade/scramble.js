class ScrambleGame {
    constructor() {
        console.log('ScrambleGame constructor called');
        this.canvas = document.getElementById('scramble-canvas');
        
        if (!this.canvas) {
            console.error('Canvas not found!');
            return;
        }

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
        this.particles = [];
        this.platforms = [];
        this.backgroundOffset = 0;
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
        console.log('Starting game...');
        this.score = 0;
        this.lives = 3;
        this.level = 1;
        this.gameActive = true;
        this.paused = false;
        
        this.player = {
            x: 100,
            y: this.height - 100,
            width: 40,
            height: 20,
            speed: 4,
            cooldown: 0,
            invulnerable: 0
        };
        
        this.bullets = [];
        this.enemies = [];
        this.particles = [];
        this.platforms = [];
        this.backgroundOffset = 0;
        
        this.createLevel();
        this.updateUI();
        this.gameLoop();
    }
    
    createLevel() {
        // Create platforms
        this.platforms = [];
        const platformCount = 5 + this.level;
        
        for (let i = 0; i < platformCount; i++) {
            this.platforms.push({
                x: i * 150 + Math.random() * 100,
                y: this.height - 50 - Math.random() * 150,
                width: 100 + Math.random() * 100,
                height: 20
            });
        }
        
        // Create enemies
        this.enemies = [];
        const enemyCount = 3 + this.level;
        
        for (let i = 0; i < enemyCount; i++) {
            const type = Math.floor(Math.random() * 3);
            this.enemies.push({
                x: 400 + i * 150 + Math.random() * 100,
                y: 50 + Math.random() * (this.height - 150),
                width: 30,
                height: 30,
                speed: 1 + Math.random() * 2,
                direction: -1,
                type: type, // 0: plane, 1: tank, 2: submarine
                active: true
            });
        }
    }
    
    playerShoot() {
        if (this.player.cooldown <= 0 && this.player.invulnerable <= 0) {
            this.bullets.push({
                x: this.player.x + this.player.width,
                y: this.player.y + this.player.height / 2,
                width: 8,
                height: 4,
                speed: 8
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
        
        // Player movement
        if (this.keys['ArrowUp'] && this.player.y > 50) {
            this.player.y -= this.player.speed;
        }
        if (this.keys['ArrowDown'] && this.player.y < this.height - 50) {
            this.player.y += this.player.speed;
        }
        if (this.keys['ArrowLeft'] && this.player.x > 50) {
            this.player.x -= this.player.speed;
        }
        if (this.keys['ArrowRight'] && this.player.x < this.width - 100) {
            this.player.x += this.player.speed;
        }
        
        // Player cooldown and invulnerability
        if (this.player.cooldown > 0) this.player.cooldown--;
        if (this.player.invulnerable > 0) this.player.invulnerable--;
        
        // Update bullets
        this.bullets.forEach(bullet => {
            bullet.x += bullet.speed;
        });
        
        // Remove off-screen bullets
        this.bullets = this.bullets.filter(bullet => bullet.x < this.width + 20);
        
        // Update enemies
        this.enemies.forEach(enemy => {
            if (!enemy.active) return;
            
            enemy.x += enemy.speed * enemy.direction;
            
            // Reverse direction at edges
            if (enemy.x <= 300 || enemy.x >= this.width - 30) {
                enemy.direction *= -1;
            }
        });
        
        // Update particles
        this.particles.forEach((particle, index) => {
            particle.x += particle.vx;
            particle.y += particle.vy;
            particle.life--;
            particle.alpha = particle.life / 30;
            
            if (particle.life <= 0) {
                this.particles.splice(index, 1);
            }
        });
        
        // Background scroll
        this.backgroundOffset += 0.5;
        
        // Check collisions
        this.checkCollisions();
        
        // Check if level complete
        if (this.enemies.filter(e => e.active).length === 0) {
            this.level++;
            this.createLevel();
        }
        
        this.updateUI();
    }
    
    checkCollisions() {
        // Player bullets vs enemies
        for (let i = this.bullets.length - 1; i >= 0; i--) {
            const bullet = this.bullets[i];
            
            for (let j = 0; j < this.enemies.length; j++) {
                const enemy = this.enemies[j];
                
                if (enemy.active && this.rectIntersect(bullet.x, bullet.y, bullet.width, bullet.height,
                                                     enemy.x, enemy.y, enemy.width, enemy.height)) {
                    // Mark enemy as inactive
                    enemy.active = false;
                    
                    // Remove bullet
                    this.bullets.splice(i, 1);
                    
                    // Add score
                    this.score += 20 * this.level;
                    
                    // Create explosion effect
                    this.createExplosion(enemy.x + enemy.width/2, enemy.y + enemy.height/2);
                    
                    break;
                }
            }
        }
        
        // Player vs enemies
        this.enemies.forEach(enemy => {
            if (enemy.active && this.player.invulnerable <= 0 && 
                this.rectIntersect(this.player.x, this.player.y, this.player.width, this.player.height,
                                 enemy.x, enemy.y, enemy.width, enemy.height)) {
                
                this.lives--;
                this.player.invulnerable = 300; // 5 seconds invulnerability
                this.createExplosion(this.player.x + this.player.width/2, this.player.y + this.player.height/2);
                
                if (this.lives <= 0) {
                    this.gameOver();
                }
            }
        });
    }
    
    rectIntersect(x1, y1, w1, h1, x2, y2, w2, h2) {
        return x2 < x1 + w1 && x2 + w2 > x1 && y2 < y1 + h1 && y2 + h2 > y1;
    }
    
    createExplosion(x, y) {
        for (let i = 0; i < 15; i++) {
            this.particles.push({
                x: x,
                y: y,
                vx: (Math.random() - 0.5) * 5,
                vy: (Math.random() - 0.5) * 5,
                life: 25,
                color: ['#ff0000', '#ffaa00', '#ffff00', '#ffffff'][Math.floor(Math.random() * 4)],
                alpha: 1.0
            });
        }
    }
    
    draw() {
        // Clear canvas
        this.ctx.fillStyle = '#000080'; // Dark blue sky
        this.ctx.fillRect(0, 0, this.width, this.height);
        
        // Draw stars background
        this.ctx.fillStyle = '#ffffff';
        for (let i = 0; i < 50; i++) {
            const x = (i * 137 + this.backgroundOffset) % this.width;
            const y = (i * 241) % this.height;
            this.ctx.fillRect(x, y, 2, 2);
        }
        
        // Draw platforms
        this.ctx.fillStyle = '#8B4513';
        this.platforms.forEach(platform => {
            this.ctx.fillRect(platform.x, platform.y, platform.width, platform.height);
        });
        
        if (!this.gameActive) return;
        
        // Draw particles
        this.particles.forEach(particle => {
            this.ctx.fillStyle = particle.color;
            this.ctx.globalAlpha = particle.alpha;
            this.ctx.beginPath();
            this.ctx.arc(particle.x, particle.y, 3, 0, Math.PI * 2);
            this.ctx.fill();
            this.ctx.globalAlpha = 1.0;
        });
        
        // Draw player
        if (this.player.invulnerable <= 0 || Math.floor(Date.now() / 100) % 2 === 0) {
            this.drawPlayer();
        }
        
        // Draw enemies
        this.enemies.forEach(enemy => {
            if (enemy.active) {
                this.drawEnemy(enemy);
            }
        });
        
        // Draw bullets
        this.ctx.fillStyle = '#ffff00';
        this.bullets.forEach(bullet => {
            this.ctx.fillRect(bullet.x, bullet.y, bullet.width, bullet.height);
        });
    }
    
    drawPlayer() {
        this.ctx.fillStyle = '#ff0000';
        const x = this.player.x;
        const y = this.player.y;
        
        // Draw jet shape
        this.ctx.beginPath();
        this.ctx.moveTo(x + this.player.width, y + this.player.height/2);
        this.ctx.lineTo(x, y);
        this.ctx.lineTo(x + 5, y + this.player.height/2);
        this.ctx.lineTo(x, y + this.player.height);
        this.ctx.closePath();
        this.ctx.fill();
        
        // Draw engine flame
        this.ctx.fillStyle = '#ffaa00';
        this.ctx.beginPath();
        this.ctx.moveTo(x - 5, y + 5);
        this.ctx.lineTo(x - 10 - Math.random() * 5, y + this.player.height/2);
        this.ctx.lineTo(x - 5, y + this.player.height - 5);
        this.ctx.closePath();
        this.ctx.fill();
    }
    
    drawEnemy(enemy) {
        const colors = ['#00ff00', '#0000ff', '#800080']; // Green, Blue, Purple
        
        this.ctx.fillStyle = colors[enemy.type];
        const x = enemy.x;
        const y = enemy.y;
        const w = enemy.width;
        const h = enemy.height;
        
        // Draw enemy shape based on type
        if (enemy.type === 0) { // Plane
            this.ctx.fillRect(x, y, w, h/2);
            this.ctx.fillRect(x + w/2, y + h/2, w/4, h/2);
        } else if (enemy.type === 1) { // Tank
            this.ctx.fillRect(x, y + h/2, w, h/2);
            this.ctx.fillRect(x + w/2, y, w/4, h/2);
        } else { // Submarine
            this.ctx.beginPath();
            this.ctx.ellipse(x + w/2, y + h/2, w/2, h/3, 0, 0, Math.PI * 2);
            this.ctx.fill();
        }
    }
    
    updateUI() {
        const scoreEl = document.getElementById('score');
        const livesEl = document.getElementById('lives');
        const levelEl = document.getElementById('level');
        
        if (scoreEl) scoreEl.textContent = this.score;
        if (livesEl) livesEl.textContent = this.lives;
        if (levelEl) levelEl.textContent = this.level;
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
        
        // Save reference to the button so we can remove it later
        this.restartBtn = restartBtn;
    }
    
    drawMenu() {
        this.ctx.fillStyle = '#000080';
        this.ctx.fillRect(0, 0, this.width, this.height);
        
        this.ctx.fillStyle = '#ff0000';
        this.ctx.font = '48px Arial';
        this.ctx.textAlign = 'center';
        this.ctx.fillText('SCRAMBLE', this.width / 2, this.height / 2 - 60);
        
        this.ctx.fillStyle = '#ffffff';
        this.ctx.font = '24px Arial';
        this.ctx.fillText('Press any key to start', this.width / 2, this.height / 2 + 20);
        
        // Start game on any key press
        const startHandler = (e) => {
            console.log('Key pressed:', e.code);
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

// Initialize game when page loads
window.addEventListener('load', () => {
    console.log('Window loaded, initializing ScrambleGame');
    new ScrambleGame();
});
