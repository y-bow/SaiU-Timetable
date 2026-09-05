// ============================================================
// Breakout � canvas, game loop, physics, collision detection,
// controls and game state for game.html. Loaded as a plain
// (classic) script and fully isolated from the timetable app.
// ============================================================

        // --- Game constants ---
        const LOGICAL_WIDTH = 600;
        const LOGICAL_HEIGHT = 400;
        const BRICK_ROWS = 5;
        const BRICK_COLS = 8;
        const BALL_SPEED_START = 220; // Slower initial speed
        const BALL_SPEED_MAX = 460;
        const PADDLE_SPEED = 450; // px per second
        const PADDLE_WIDTH = 90;
        const PADDLE_HEIGHT = 12;
        const PADDLE_MARGIN = 10; // Keep rounded edges completely inside canvas borders

        // --- DOM Elements ---
        const canvas = document.getElementById('game-canvas');
        const ctx = canvas.getContext('2d');
        const scoreVal = document.querySelector('#score-display span');
        const highScoreVal = document.querySelector('#high-score-display span');
        const levelVal = document.querySelector('#level-display span');
        const livesVal = document.querySelector('#lives-display span');
        
        const startOverlay = document.getElementById('start-overlay');
        const gameoverOverlay = document.getElementById('gameover-overlay');
        
        const startBtn = document.getElementById('start-button');
        const restartBtn = document.getElementById('restart-button');
        const resetGameBtn = document.getElementById('reset-game-btn');

        // --- Game State ---
        let score = 0;
        let highScore = parseInt(localStorage.getItem('breakout_highscore') || '0', 10);
        let level = 1;
        let lives = 3;
        let state = 'start'; // 'start' | 'playing' | 'gameover'
        let animationFrameId = null;
        let lastTime = 0;

        // Level Transition Notification
        let levelUpTimer = 0; // Display level up text for 2 seconds

        // Keyboard tracking
        const keys = {
            ArrowLeft: false,
            ArrowRight: false,
            a: false,
            d: false,
            A: false,
            D: false
        };

        // Entities
        const paddle = {
            x: (LOGICAL_WIDTH - PADDLE_WIDTH) / 2,
            y: LOGICAL_HEIGHT - 30,
            width: PADDLE_WIDTH,
            height: PADDLE_HEIGHT
        };

        // Dynamic entities arrays
        let balls = [];
        let powerups = [];
        let particles = [];
        let bricks = [];

        // Colors derived from the app theme tokens (js/core/theme.js) so the
        // game follows the user's chosen background + accent. Read once at
        // load — the head bootstrap sets data-bg/data-accent before this
        // module executes, so every var already resolves to the saved theme.
        function cssVar(name, fallback) {
            const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
            return v || fallback;
        }
        const colors = {
            bg: cssVar('--surface-2', '#18181B'), // Canvas background
            border: cssVar('--border', '#262626'),
            paddle: cssVar('--primary-hover', '#E86868'), // Primary accent
            ball: cssVar('--text', '#F5F5F5'),
            // Colors of rows from top to bottom
            bricks: [
                cssVar('--primary', '#d85757'),        // Row 0: Primary accent
                cssVar('--text', '#F5F5F5'),           // Row 1: primary text color
                cssVar('--text-secondary', '#A1A1AA'), // Row 2: text-secondary
                cssVar('--border-strong', '#333333'),  // Row 3: border-strong
                cssVar('--border', '#262626')          // Row 4: border
            ]
        };

        // Pointer tracking state
        let isPointerDown = false;

        // --- Setup & Listeners ---
        function initListeners() {
            window.addEventListener('resize', handleResize);
            
            // Keyboard controls
            window.addEventListener('keydown', handleKeyDown);
            window.addEventListener('keyup', handleKeyUp);

            // Pointer (Mouse / Touch) controls
            canvas.addEventListener('pointerdown', handlePointerDown);
            canvas.addEventListener('pointermove', handlePointerMove);
            window.addEventListener('pointerup', handlePointerUp);
            window.addEventListener('pointercancel', handlePointerUp);

            // Button clicks
            startBtn.addEventListener('click', startGame);
            restartBtn.addEventListener('click', resetGame);
            resetGameBtn.addEventListener('click', resetGame);

            // Visibility API: pause/stop loop if page is hidden
            document.addEventListener('visibilitychange', () => {
                if (document.hidden) {
                    if (animationFrameId) {
                        cancelAnimationFrame(animationFrameId);
                        animationFrameId = null;
                    }
                } else if (state === 'playing') {
                    lastTime = performance.now();
                    animationFrameId = requestAnimationFrame(gameLoop);
                }
            });
        }

        function handleResize() {
            const dpr = window.devicePixelRatio || 1;
            const w = canvas.clientWidth;
            const h = canvas.clientHeight;
            
            // Set actual physical buffer size
            canvas.width = w * dpr;
            canvas.height = h * dpr;
            
            // Map the fixed 600x400 coordinate space to the physical pixel space
            const scaleX = (w * dpr) / LOGICAL_WIDTH;
            const scaleY = (h * dpr) / LOGICAL_HEIGHT;
            ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
            
            draw();
        }

        function handleKeyDown(e) {
            if (e.key in keys) {
                keys[e.key] = true;
                e.preventDefault();
            }
            
            if (e.key === ' ' || e.key === 'Spacebar') {
                if (state === 'start' || state === 'gameover') {
                    resetGame();
                } else {
                    launchBall();
                }
                e.preventDefault();
            }
        }

        function handleKeyUp(e) {
            if (e.key in keys) {
                keys[e.key] = false;
                e.preventDefault();
            }
        }

        function getCanvasRelativeX(clientX) {
            const bgRect = canvas.getBoundingClientRect();
            // Scale clientX to our logical width coordinate system
            return ((clientX - bgRect.left) / bgRect.width) * LOGICAL_WIDTH;
        }

        function handlePointerMove(e) {
            if (state !== 'playing' || !isPointerDown || e.pointerType !== 'touch') return;
            const x = getCanvasRelativeX(e.clientX);
            // Center the paddle on the pointer, clamped cleanly within insets
            paddle.x = Math.max(PADDLE_MARGIN, Math.min(LOGICAL_WIDTH - paddle.width - PADDLE_MARGIN, x - paddle.width / 2));
            
            balls.forEach(ball => {
                if (ball.attachedToPaddle) {
                    ball.x = paddle.x + paddle.width / 2;
                }
            });
        }

        function handlePointerDown(e) {
            if (state !== 'playing' || e.pointerType !== 'touch') return;
            isPointerDown = true;
            
            // Set position immediately on touch down
            const x = getCanvasRelativeX(e.clientX);
            paddle.x = Math.max(PADDLE_MARGIN, Math.min(LOGICAL_WIDTH - paddle.width - PADDLE_MARGIN, x - paddle.width / 2));

            // Launch ball on tap if attached
            launchBall();
        }

        function handlePointerUp() {
            isPointerDown = false;
        }

        // --- Game Logic ---
        function resetGame() {
            score = 0;
            level = 1;
            lives = 3;
            levelUpTimer = 0;
            updatePaddleWidth();
            updateStatsUI();

            // Clear overlays
            startOverlay.classList.add('hidden');
            gameoverOverlay.classList.add('hidden');

            generateBricks();
            resetBall();
            powerups = [];
            particles = [];
            state = 'playing';
            
            if (animationFrameId) {
                cancelAnimationFrame(animationFrameId);
            }
            lastTime = performance.now();
            animationFrameId = requestAnimationFrame(gameLoop);
        }

        function updatePaddleWidth() {
            // Shrink paddle to make it progressively harder (level 1 = 90, level 2 = 83, level 3 = 76, etc. limit to 45px)
            paddle.width = Math.max(45, PADDLE_WIDTH - (level - 1) * 7);
        }

        function generateBricks() {
            bricks = [];
            const paddingLeftRight = 20;
            const paddingTop = 25;
            const gap = 6;
            const totalWidth = LOGICAL_WIDTH - paddingLeftRight * 2;
            const brickWidth = (totalWidth - (BRICK_COLS - 1) * gap) / BRICK_COLS;
            const brickHeight = 14;

            for (let r = 0; r < BRICK_ROWS; r++) {
                for (let c = 0; c < BRICK_COLS; c++) {
                    // 6% chance of being a Multiball special block
                    const isSpecial = Math.random() < 0.06;
                    bricks.push({
                        x: paddingLeftRight + c * (brickWidth + gap),
                        y: paddingTop + r * (brickHeight + gap),
                        width: brickWidth,
                        height: brickHeight,
                        color: colors.bricks[r],
                        active: true,
                        type: isSpecial ? 'multiball' : 'normal'
                    });
                }
            }
        }

        function startGame() {
            resetGame();
        }

        function resetBall() {
            balls = [{
                x: paddle.x + paddle.width / 2,
                y: paddle.y - 7,
                vx: 0,
                vy: 0,
                radius: 7,
                attachedToPaddle: true
            }];

            // Start automatically after a brief delay
            setTimeout(() => {
                if (state === 'playing') {
                    launchBall();
                }
            }, 1200);
        }

        function launchBall() {
            balls.forEach(ball => {
                if (ball.attachedToPaddle) {
                    ball.attachedToPaddle = false;
                    const angle = -Math.PI / 4 - Math.random() * (Math.PI / 2);
                    // Speed multiplier increases progressively with level (10% increase per level)
                    const speed = BALL_SPEED_START * (1 + (level - 1) * 0.10);
                    ball.vx = Math.cos(angle) * speed;
                    ball.vy = Math.sin(angle) * speed;
                }
            });
        }

        function spawnParticles(x, y, color) {
            const count = 10;
            for (let i = 0; i < count; i++) {
                const angle = Math.random() * Math.PI * 2;
                const speed = 40 + Math.random() * 80;
                particles.push({
                    x: x,
                    y: y,
                    vx: Math.cos(angle) * speed,
                    vy: Math.sin(angle) * speed,
                    radius: 2 + Math.random() * 2,
                    alpha: 1.0,
                    decay: 1.8 + Math.random() * 1.2,
                    color: color
                });
            }
        }

        function spawnPowerup(x, y) {
            powerups.push({
                x: x,
                y: y,
                vy: 110, // px per second
                width: 14,
                height: 14,
                letter: 'M',
                color: colors.bricks[0]
            });
        }

        function updateStatsUI() {
            scoreVal.textContent = String(score).padStart(4, '0');
            highScoreVal.textContent = String(highScore).padStart(4, '0');
            levelVal.textContent = String(level);
            livesVal.textContent = String(lives);
        }

        function saveHighScore() {
            if (score > highScore) {
                highScore = score;
                localStorage.setItem('breakout_highscore', String(highScore));
                updateStatsUI();
            }
        }

        function gameLoop(currentTime) {
            if (state !== 'playing') {
                animationFrameId = null;
                return;
            }

            // Delta time in seconds
            let dt = (currentTime - lastTime) / 1000;
            lastTime = currentTime;

            // Clamp delta time to avoid huge leaps
            if (dt > 0.05) dt = 0.05;

            updatePhysics(dt);
            draw();

            animationFrameId = requestAnimationFrame(gameLoop);
        }

        function updatePhysics(dt) {
            // 1. Level-up Timer Decay
            if (levelUpTimer > 0) {
                levelUpTimer -= dt;
            }

            // 2. Move Paddle via Keyboard
            let moveDir = 0;
            if (keys.ArrowLeft || keys.a || keys.A) moveDir -= 1;
            if (keys.ArrowRight || keys.d || keys.D) moveDir += 1;

            if (moveDir !== 0) {
                paddle.x += moveDir * PADDLE_SPEED * dt;
                // Keep paddle strictly inside margins
                paddle.x = Math.max(PADDLE_MARGIN, Math.min(LOGICAL_WIDTH - paddle.width - PADDLE_MARGIN, paddle.x));
                
                balls.forEach(ball => {
                    if (ball.attachedToPaddle) {
                        ball.x = paddle.x + paddle.width / 2;
                    }
                });
            }

            // 3. Update Particles
            for (let i = particles.length - 1; i >= 0; i--) {
                const p = particles[i];
                p.x += p.vx * dt;
                p.y += p.vy * dt;
                p.alpha -= p.decay * dt;
                if (p.alpha <= 0) {
                    particles.splice(i, 1);
                }
            }

            // 4. Update Power-ups
            for (let i = powerups.length - 1; i >= 0; i--) {
                const pu = powerups[i];
                pu.y += pu.vy * dt;

                // Paddle collision
                if (pu.y + pu.height > paddle.y &&
                    pu.y < paddle.y + paddle.height &&
                    pu.x + pu.width > paddle.x &&
                    pu.x < paddle.x + paddle.width) {
                    
                    // Activate Multiball! Split current balls or launch extra
                    const activeBall = balls[0] || { x: paddle.x + paddle.width/2, y: paddle.y - 10, vx: 0, vy: -BALL_SPEED_START };
                    const speed = Math.hypot(activeBall.vx, activeBall.vy) || BALL_SPEED_START;
                    
                    for (let j = 0; j < 2; j++) {
                        const angle = -Math.PI/4 - Math.random() * (Math.PI/2);
                        balls.push({
                            x: activeBall.x,
                            y: activeBall.y,
                            vx: Math.cos(angle) * speed,
                            vy: Math.sin(angle) * speed,
                            radius: 7,
                            attachedToPaddle: false
                        });
                    }

                    powerups.splice(i, 1);
                    score += 50; // Bonus score for catching powerup
                    saveHighScore();
                    continue;
                }

                // Fall off screen
                if (pu.y > LOGICAL_HEIGHT) {
                    powerups.splice(i, 1);
                }
            }

            // 5. Update Balls
            let bricksLeft = bricks.filter(b => b.active).length;

            for (let b = balls.length - 1; b >= 0; b--) {
                const ball = balls[b];
                if (ball.attachedToPaddle) continue;

                ball.x += ball.vx * dt;
                ball.y += ball.vy * dt;

                // Left / Right Walls
                if (ball.x - ball.radius < 0) {
                    ball.x = ball.radius;
                    ball.vx = -ball.vx;
                } else if (ball.x + ball.radius > LOGICAL_WIDTH) {
                    ball.x = LOGICAL_WIDTH - ball.radius;
                    ball.vx = -ball.vx;
                }

                // Ceiling
                if (ball.y - ball.radius < 0) {
                    ball.y = ball.radius;
                    ball.vy = -ball.vy;
                }

                // Floor (Ball out of bounds)
                if (ball.y + ball.radius > LOGICAL_HEIGHT) {
                    balls.splice(b, 1);
                    continue;
                }

                // Paddle Collision
                if (ball.vy > 0 &&
                    ball.x + ball.radius > paddle.x &&
                    ball.x - ball.radius < paddle.x + paddle.width &&
                    ball.y + ball.radius > paddle.y &&
                    ball.y - ball.radius < paddle.y + paddle.height) {
                    
                    ball.y = paddle.y - ball.radius;
                    const hitPoint = ((ball.x - paddle.x) / paddle.width) * 2 - 1;
                    const maxAngle = Math.PI / 3; 
                    const angle = hitPoint * maxAngle;

                    const speedMultiplier = 1 + (level - 1) * 0.10;
                    const currentSpeed = Math.hypot(ball.vx, ball.vy);
                    const speed = Math.min(BALL_SPEED_MAX * speedMultiplier, Math.max(BALL_SPEED_START * speedMultiplier, currentSpeed * 1.02));

                    ball.vx = speed * Math.sin(angle);
                    ball.vy = -speed * Math.cos(angle);
                }

                // Bricks Collision
                for (let i = 0; i < bricks.length; i++) {
                    const brick = bricks[i];
                    if (!brick.active) continue;

                    if (ball.x + ball.radius > brick.x &&
                        ball.x - ball.radius < brick.x + brick.width &&
                        ball.y + ball.radius > brick.y &&
                        ball.y - ball.radius < brick.y + brick.height) {
                        
                        brick.active = false;
                        bricksLeft--;
                        score += 10;
                        saveHighScore();

                        // Visual particles break effect
                        spawnParticles(brick.x + brick.width / 2, brick.y + brick.height / 2, brick.color);

                        // Drop power-up if special
                        if (brick.type === 'multiball') {
                            spawnPowerup(brick.x + brick.width / 2, brick.y + brick.height / 2);
                        }

                        // Bounce logic
                        const overlapX = Math.min(ball.x + ball.radius - brick.x, brick.x + brick.width - (ball.x - ball.radius));
                        const overlapY = Math.min(ball.y + ball.radius - brick.y, brick.y + brick.height - (ball.y - ball.radius));

                        if (overlapX < overlapY) {
                            ball.vx = -ball.vx;
                            ball.x += ball.vx > 0 ? overlapX : -overlapX;
                        } else {
                            ball.vy = -ball.vy;
                            ball.y += ball.vy > 0 ? overlapY : -overlapY;
                        }
                        break;
                    }
                }
            }

            // 6. Check lose/empty balls condition
            if (balls.length === 0) {
                lives--;
                updateStatsUI();
                if (lives <= 0) {
                    state = 'gameover';
                    gameoverOverlay.classList.remove('hidden');
                } else {
                    resetBall();
                }
            }

            // 7. Infinite level advancement when all bricks are cleared
            if (bricksLeft === 0) {
                level++;
                levelUpTimer = 2.0; // Show level banner for 2 seconds
                updatePaddleWidth();
                updateStatsUI();
                generateBricks();
                // Respawn ball attached to paddle cleanly
                resetBall();
                powerups = [];
            }
        }

        // --- Render functions ---
        function draw() {
            ctx.clearRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);

            // Draw Bricks
            for (let i = 0; i < bricks.length; i++) {
                const brick = bricks[i];
                if (brick.active) {
                    ctx.fillStyle = brick.color;
                    ctx.fillRect(brick.x, brick.y, brick.width, brick.height);
                    
                    // Subtle brick outline
                    ctx.strokeStyle = colors.bg;
                    ctx.lineWidth = 1;
                    ctx.strokeRect(brick.x, brick.y, brick.width, brick.height);
                }
            }

            // Draw Particles
            for (let i = 0; i < particles.length; i++) {
                const p = particles[i];
                ctx.save();
                ctx.globalAlpha = p.alpha;
                ctx.fillStyle = p.color;
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
            }

            // Draw Power-ups
            for (let i = 0; i < powerups.length; i++) {
                const pu = powerups[i];
                ctx.save();
                // Capsule outline
                ctx.fillStyle = pu.color;
                ctx.beginPath();
                ctx.roundRect(pu.x, pu.y, pu.width, pu.height, 4);
                ctx.fill();
                
                // Capsule text
                ctx.fillStyle = '#FFF';
                ctx.font = 'bold 10px Inter, sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(pu.letter, pu.x + pu.width / 2, pu.y + pu.height / 2);
                ctx.restore();
            }

            // Draw Fully Rounded Paddle
            ctx.fillStyle = colors.paddle;
            ctx.beginPath();
            ctx.roundRect(paddle.x, paddle.y, paddle.width, paddle.height, paddle.height / 2);
            ctx.fill();

            // Draw Balls
            balls.forEach(ball => {
                ctx.beginPath();
                ctx.arc(ball.x, ball.y, ball.radius, 0, Math.PI * 2);
                ctx.fillStyle = colors.ball;
                ctx.fill();
                ctx.closePath();
            });

            // Draw Level Up Banner text overlay
            if (levelUpTimer > 0) {
                ctx.save();
                ctx.fillStyle = 'rgba(13, 13, 13, 0.7)';
                ctx.fillRect(0, LOGICAL_HEIGHT / 2 - 30, LOGICAL_WIDTH, 60);

                ctx.fillStyle = colors.paddle;
                ctx.font = 'bold 24px Inter, sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(`LEVEL ${level}`, LOGICAL_WIDTH / 2, LOGICAL_HEIGHT / 2);
                ctx.restore();
            }
        }

        // --- Start up ---
        initListeners();
        handleResize();
        updateStatsUI();
