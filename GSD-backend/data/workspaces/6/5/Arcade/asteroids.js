class Game {
    constructor() {
        this.canvas = document.getElementById('asteroids-canvas');
        this.ctx = this.canvas.getContext('2d');
        this.width = this.canvas.width;
        this.height = this.canvas.height;
        
        this.score = 0;
        this.lives = 3;
        this.level = 1;
        this.gameActive = false;
        this.paused = false;
        
        this.ship = null;
        this.asteroids = [];
        this.bullets = [];
        this.keys = {};
        
        this.setupInput();
        this.setupButtons();
        this.drawMenu();
    }
    
    setupInput() {
        window.addEventListener('keydown', (e) => {
            this.keys[e.code] = true;
            
            if (e.code === 'Space' && this.gameActive && !this.paused) {
                this.shoot();
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
        
        this.ship = {
            x: this.width / 2,
            y: this.height / 2,
            angle: -Math.PI / 2,
            velocity: { x: 0, y: 0 },
            radius: 15,
            thrusting: false,
            invulnerable: 180 // 3 seconds of invulnerability on respawn
        };
        
        this.bullets = [];
        this.asteroids = [];
        this.createAsteroids(2); // Reduced from 3 for easier start
        this.updateUI();
        this.gameLoop();
    }
    
    createAsteroids(count) {
        for (let i = 0; i < count; i++) {
            this.createAsteroid();
        }
    }
    
    createAsteroid() {
        let x, y;
        do {
            x = Math.random() * this.width;
            y = Math.random() * this.height;
        } while (this.distance(x, y, this.ship.x, this.ship.y) < 150);
        
        this.asteroids.push({
            x: x,
            y: y,
            size: 30 + Math.random() * 20,
            angle: Math.random() * Math.PI * 2,
            rotationSpeed: (Math.random() - 0.5) * 0.02,
            velocity: {
                x: Math.cos(Math.random() * Math.PI * 2) * (0.3 + Math.random() * 0.3), // Reduced speed
                y: Math.sin(Math.random() * Math.PI * 2) * (0.3 + Math.random() * 0.3)  // Reduced speed
            },
            points: this.generateAsteroidPoints(8 + Math.floor(Math.random() * 4))
        });
    }
    
    generateAsteroidPoints(numPoints) {
        const points = [];
        for (let i = 0; i < numPoints; i++) {
            const angle = (i / numPoints) * Math.PI * 2;
            const radius = 15 + Math.random() * 15;
            points.push({
                x: Math.cos(angle) * radius,
                y: Math.sin(angle) * radius
            });
        }
        return points;
    }
    
    shoot() {
        if (this.bullets.length < 5) {
            this.bullets.push({
                x: this.ship.x + Math.cos(this.ship.angle) * this.ship.radius,
                y: this.ship.y + Math.sin(this.ship.angle) * this.ship.radius,
                angle: this.ship.angle,
                speed: 8,
                life: 100
            });
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
        
        // Decrease invulnerability timer
        if (this.ship.invulnerable > 0) {
            this.ship.invulnerable--;
        }
        
        if (this.keys['ArrowUp']) {
            this.ship.velocity.x += Math.cos(this.ship.angle) * 0.1;
            this.ship.velocity.y += Math.sin(this.ship.angle) * 0.1;
            this.ship.thrusting = true;
        } else {
            this.ship.thrusting = false;
        }
        
        if (this.keys['ArrowLeft']) {
            this.ship.angle -= 0.05;
        }
        if (this.keys['ArrowRight']) {
            this.ship.angle += 0.05;
        }
        
        this.ship.velocity.x *= 0.98;
        this.ship.velocity.y *= 0.98;
        this.ship.x += this.ship.velocity.x;
        this.ship.y += this.ship.velocity.y;
        
        this.ship.x = this.wrap(this.ship.x, this.width);
        this.ship.y = this.wrap(this.ship.y, this.height);
        
        this.bullets.forEach(bullet => {
            bullet.x += Math.cos(bullet.angle) * bullet.speed;
            bullet.y += Math.sin(bullet.angle) * bullet.speed;
            bullet.life--;
            
            bullet.x = this.wrap(bullet.x, this.width);
            bullet.y = this.wrap(bullet.y, this.height);
        });
        
        this.bullets = this.bullets.filter(bullet => bullet.life > 0);
        
        this.asteroids.forEach(asteroid => {
            asteroid.x += asteroid.velocity.x;
            asteroid.y += asteroid.velocity.y;
            asteroid.angle += asteroid.rotationSpeed;
            
            asteroid.x = this.wrap(asteroid.x, this.width);
            asteroid.y = this.wrap(asteroid.y, this.height);
        });
        
        this.checkCollisions();
        
        if (this.asteroids.length === 0) {
            this.level++;
            this.createAsteroids(2 + Math.floor(this.level / 3)); // Reduced asteroid count per level
        }
        
        this.updateUI();
    }
    
    checkCollisions() {
        for (let i = this.bullets.length - 1; i >= 0; i--) {
            for (let j = this.asteroids.length - 1; j >= 0; j--) {
                const bullet = this.bullets[i];
                const asteroid = this.asteroids[j];
                
                if (this.distance(bullet.x, bullet.y, asteroid.x, asteroid.y) < asteroid.size) {
                    this.bullets.splice(i, 1);
                    this.asteroids.splice(j, 1);
                    
                    this.score += Math.floor(asteroid.size);
                    
                    if (asteroid.size > 25) {
                        const newSize = asteroid.size / 2;
                        for (let k = 0; k < 1; k++) {
                            this.asteroids.push({
                                x: asteroid.x,
                                y: asteroid.y,
                                size: newSize,
                                angle: Math.random() * Math.PI * 2,
                                rotationSpeed: (Math.random() - 0.5) * 0.02,
                                velocity: {
                                    x: Math.cos(asteroid.angle + (k === 0 ? 0.5 : -0.5)) * 1.0,
                                    y: Math.sin(asteroid.angle + (k === 0 ? 0.5 : -0.5)) * 1.0
                                },
                                points: this.generateAsteroidPoints(6 + Math.floor(Math.random() * 3))
                            });
                        }
                    }
                    
                    break;
                }
            }
        }
        
        for (let asteroid of this.asteroids) {
            if (this.distance(this.ship.x, this.ship.y, asteroid.x, asteroid.y) < asteroid.size + this.ship.radius) {
                // Only take damage if not invulnerable
                if (this.ship.invulnerable <= 0) {
                    this.lives--;
                    this.createExplosion(this.ship.x, this.ship.y);
                    
                    if (this.lives <= 0) {
                        this.gameOver();
                    } else {
                        // Respawn with invulnerability
                        this.ship.x = this.width / 2;
                        this.ship.y = this.height / 2;
                        this.ship.velocity = { x: 0, y: 0 };
                        this.ship.angle = -Math.PI / 2;
                        this.ship.invulnerable = 180; // 3 seconds of invulnerability
                    }
                }
                break;
            }
        }
    }
    
    createExplosion(x, y) {
        for (let i = 0; i < 10; i++) {
            this.ctx.fillStyle = '#ffaa00';
            this.ctx.beginPath();
            this.ctx.arc(
                x + (Math.random() - 0.5) * 30,
                y + (Math.random() - 0.5) * 30,
                Math.random() * 5, 0, Math.PI * 2
            );
            this.ctx.fill();
        }
    }
    
    wrap(value, max) {
        if (value < 0) return max;
        if (value > max) return 0;
        return value;
    }
    
    distance(x1, y1, x2, y2) {
        const dx = x2 - x1;
        const dy = y2 - y1;
        return Math.sqrt(dx * dx + dy * dy);
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
        container.appendChild(restartBtn);
        
        this.restartBtn = restartBtn;
    }
    
    drawMenu() {
        this.ctx.fillStyle = '#000000';
        this.ctx.fillRect(0, 0, this.width, this.height);
        
        this.ctx.fillStyle = '#00ff00';
        this.ctx.font = '48px Arial';
        this.ctx.textAlign = 'center';
        this.ctx.fillText('ASTEROIDS', this.width / 2, this.height / 2 - 60);
        
        this.ctx.fillStyle = '#ffffff';
        this.ctx.font = '24px Arial';
        this.ctx.fillText('Press any key to start', this.width / 2, this.height / 2 + 20);
        
        const startHandler = (e) => {
            window.removeEventListener('keydown', startHandler);
            this.startGame();
        };
        window.addEventListener('keydown', startHandler);
    }
    
    drawAsteroid(asteroid) {
        this.ctx.save();
        this.ctx.translate(asteroid.x, asteroid.y);
        this.ctx.rotate(asteroid.angle);
        
        this.ctx.beginPath();
        if (asteroid.points && asteroid.points.length > 0) {
            this.ctx.moveTo(asteroid.points[0].x, asteroid.points[0].y);
            for (let i = 1; i < asteroid.points.length; i++) {
                this.ctx.lineTo(asteroid.points[i].x, asteroid.points[i].y);
            }
        }
        this.ctx.closePath();
        this.ctx.stroke();
        
        this.ctx.restore();
    }
    
    drawShip() {
        // If invulnerable, flash the ship
        if (this.ship.invulnerable > 0 && Math.floor(Date.now() / 100) % 2 === 0) {
            return;
        }
        
        this.ctx.strokeStyle = '#00ff00';
        this.ctx.lineWidth = 2;
        this.ctx.beginPath();
        
        const tipX = this.ship.x + Math.cos(this.ship.angle) * this.ship.radius;
        const tipY = this.ship.y + Math.sin(this.ship.angle) * this.ship.radius;
        const leftX = this.ship.x + Math.cos(this.ship.angle + 2.5) * this.ship.radius;
        const leftY = this.ship.y + Math.sin(this.ship.angle + 2.5) * this.ship.radius;
        const rightX = this.ship.x + Math.cos(this.ship.angle - 2.5) * this.ship.radius;
        const rightY = this.ship.y + Math.sin(this.ship.angle - 2.5) * this.ship.radius;
        
        this.ctx.moveTo(tipX, tipY);
        this.ctx.lineTo(rightX, rightY);
        this.ctx.lineTo(leftX, leftY);
        this.ctx.closePath();
        this.ctx.stroke();
        
        if (this.ship.thrusting) {
            this.ctx.strokeStyle = '#ffaa00';
            this.ctx.beginPath();
            const flameX = this.ship.x - Math.cos(this.ship.angle) * this.ship.radius;
            const flameY = this.ship.y - Math.sin(this.ship.angle) * this.ship.radius;
            const flameTipX = this.ship.x - Math.cos(this.ship.angle) * (this.ship.radius + 10);
            const flameTipY = this.ship.y - Math.sin(this.ship.angle) * (this.ship.radius + 10);
            
            this.ctx.moveTo(flameX, flameY);
            this.ctx.lineTo(flameTipX, flameTipY);
            this.ctx.stroke();
        }
    }
    
    gameLoop() {
        if (!this.gameActive || this.paused) return;
        
        this.update();
        this.draw();
        
        requestAnimationFrame(() => this.gameLoop());
    }
    
    draw() {
        this.ctx.fillStyle = '#000000';
        this.ctx.fillRect(0, 0, this.width, this.height);
        
        this.ctx.fillStyle = '#ffffff';
        for (let i = 0; i < 50; i++) {
            const x = (i * 137) % this.width;
            const y = (i * 241) % this.height;
            this.ctx.fillRect(x, y, 2, 2);
        }
        
        if (!this.gameActive) return;
        
        this.asteroids.forEach(a => this.drawAsteroid(a));
        this.drawShip();
        
        this.ctx.strokeStyle = '#00ffff';
        this.ctx.lineWidth = 2;
        this.bullets.forEach(bullet => {
            this.ctx.beginPath();
            this.ctx.arc(bullet.x, bullet.y, 2, 0, Math.PI * 2);
            this.ctx.stroke();
        });
    }
}

window.addEventListener('load', () => {
    new Game();
});
