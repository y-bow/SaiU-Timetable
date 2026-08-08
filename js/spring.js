/**
 * Spring Animation Utility
 * Apple-style spring animations using Web Animations API
 * Based on Motion/Framer Motion spring model (damping + response)
 */

export const SpringPresets = {
    // Critically damped - no overshoot, graceful settle
    ui: { damping: 1.0, response: 0.35 },
    // Momentum-driven - slight bounce for flicks/throws
    momentum: { damping: 0.8, response: 0.35 },
    // Snappy - for small UI elements
    snappy: { damping: 1.0, response: 0.25 },
    // Gentle - for large repositioning
    gentle: { damping: 1.0, response: 0.5 },
    // Sheet/drawer
    sheet: { damping: 0.8, response: 0.3 },
};

/**
 * Convert damping ratio + response to spring physics parameters
 * Based on Apple's design guidelines and Framer Motion's implementation
 */
function springPhysics(damping, response) {
    // Response is time to reach ~63% of target (1 - 1/e)
    // Natural frequency ω₀ = 1 / response
    // Damping ratio ζ = damping
    const omega0 = 1 / response;
    const zeta = damping;

    if (zeta >= 1) {
        // Critically damped or overdamped
        const beta = omega0 * zeta;
        const gamma = Math.sqrt(beta * beta - omega0 * omega0);
        return { type: 'overdamped', omega0, zeta, beta, gamma };
    } else {
        // Underdamped (oscillating)
        const omegaD = omega0 * Math.sqrt(1 - zeta * zeta);
        return { type: 'underdamped', omega0, zeta, omegaD };
    }
}

/**
 * Create a spring animation using Web Animations API
 * Animates from current value to target with velocity handoff
 */
export function animateSpring(element, keyframes, options = {}) {
    const {
        damping = 1.0,
        response = 0.35,
        velocity = 0,
        onComplete,
        ...animationOptions
    } = options;

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReducedMotion) {
        // Instant transition for reduced motion
        element.style.setProperty(keyframes[0], keyframes[1]);
        onComplete?.();
        return Promise.resolve();
    }

    const physics = springPhysics(damping, response);
    const duration = estimateSettleTime(physics);

    // Use WAAPI with a custom easing that approximates spring
    // For true spring physics, we'd need to manually animate via rAF
    // But WAAPI with spring-like easing is performant and interruptible

    return new Promise((resolve) => {
        const animation = element.animate(keyframes, {
            duration,
            easing: springEasing(physics),
            fill: 'forwards',
            ...animationOptions,
        });

        animation.onfinish = () => {
            onComplete?.();
            resolve();
        };

        animation.oncancel = () => resolve();

        // Store for potential interruption
        element._springAnimation = animation;
    });
}

/**
 * Estimate settle time for spring (when amplitude < 0.1px)
 */
function estimateSettleTime(physics) {
    if (physics.type === 'overdamped') {
        // For overdamped, settle time ≈ 4.6 / (β - γ) for 1% threshold
        const tau = 1 / (physics.beta - physics.gamma);
        return Math.min(tau * 4.6 * 1000, 2000); // cap at 2s
    } else {
        // For underdamped, settle time ≈ 4.6 / (ζω₀) for 1% threshold
        const tau = 1 / (physics.zeta * physics.omega0);
        return Math.min(tau * 4.6 * 1000, 2000);
    }
}

/**
 * Generate a cubic-bezier approximation of spring easing
 * This is a simplified approximation; true springs need rAF
 */
function springEasing(physics) {
    if (physics.type === 'overdamped') {
        // Critically damped approximation
        return 'cubic-bezier(0.25, 0.1, 0.25, 1)';
    } else {
        // Under-damped with slight overshoot
        // The more underdamped, the more "bouncy" the curve
        const zeta = physics.zeta;
        if (zeta > 0.9) return 'cubic-bezier(0.25, 0.1, 0.25, 1)';
        if (zeta > 0.7) return 'cubic-bezier(0.15, 0.5, 0.3, 1.1)';
        return 'cubic-bezier(0.1, 0.6, 0.2, 1.2)';
    }
}

/**
 * True spring animation using requestAnimationFrame
 * For gesture-driven interactions requiring velocity handoff and interruption
 */
export function createSpringAnimator(config = {}) {
    const {
        damping = 1.0,
        response = 0.35,
        stiffness = undefined, // If provided, overrides damping/response
        mass = 1,
    } = config;

    let currentValue = 0;
    let targetValue = 0;
    let currentVelocity = 0;
    let animationFrame = null;
    let onUpdate = null;
    let onComplete = null;
    let isAnimating = false;

    // Convert to spring physics
    let k, c;
    if (stiffness !== undefined) {
        k = stiffness;
        c = 2 * damping * Math.sqrt(k * mass);
    } else {
        // From response/damping (Framer Motion model)
        const omega0 = 1 / response;
        k = mass * omega0 * omega0;
        c = 2 * damping * Math.sqrt(k * mass);
    }

    function step(dt) {
        if (!isAnimating) return;

        // Spring force: F = -k * x - c * v
        const displacement = currentValue - targetValue;
        const acceleration = (-k * displacement - c * currentVelocity) / mass;

        currentVelocity += acceleration * dt;
        currentValue += currentVelocity * dt;

        onUpdate?.(currentValue, currentVelocity);

        // Check if settled (critically damped or underdamped)
        const settled = Math.abs(displacement) < 0.01 && Math.abs(currentVelocity) < 0.01;

        if (settled) {
            currentValue = targetValue;
            currentVelocity = 0;
            isAnimating = false;
            if (animationFrame) {
                cancelAnimationFrame(animationFrame);
                animationFrame = null;
            }
            onUpdate?.(currentValue, 0);
            onComplete?.();
            return;
        }

        animationFrame = requestAnimationFrame((time) => step(1/60));
    }

    return {
        start(from, to, velocity = 0, updateFn, completeFn) {
            currentValue = from;
            targetValue = to;
            currentVelocity = velocity;
            onUpdate = updateFn;
            onComplete = completeFn;
            isAnimating = true;

            if (animationFrame) cancelAnimationFrame(animationFrame);
            animationFrame = requestAnimationFrame((time) => step(1/60));
        },

        updateTarget(newTarget) {
            targetValue = newTarget;
        },

        stop() {
            isAnimating = false;
            if (animationFrame) {
                cancelAnimationFrame(animationFrame);
                animationFrame = null;
            }
        },

        get value() { return currentValue; },
        get velocity() { return currentVelocity; },
        get isRunning() { return isAnimating; },
    };
}

/**
 * Spring-based value for declarative animations
 * Usage: const x = springValue(0); x.set(100); x.onChange(v => el.style.transform = `translateX(${v}px)`);
 */
export function springValue(initial = 0, config = {}) {
    const animator = createSpringAnimator(config);
    let value = initial;
    let subscribers = [];

    animator.onUpdate = (v) => {
        value = v;
        subscribers.forEach(fn => fn(v));
    };

    return {
        get value() { return value; },
        set(target, velocity = 0) {
            animator.start(value, target, velocity);
        },
        animate(target, velocity = 0) {
            return new Promise(resolve => {
                animator.onComplete = resolve;
                animator.start(value, target, velocity);
            });
        },
        stop() { animator.stop(); },
        onChange(fn) {
            subscribers.push(fn);
            return () => { subscribers = subscribers.filter(f => f !== fn); };
        },
    };
}

/**
 * Interpolate spring progress for non-transform properties
 */
export function springInterpolate(from, to, progress) {
    return from + (to - from) * progress;
}

/**
 * Rubber-band function for overscroll resistance
 * Apple's exact implementation from Designing Fluid Interfaces
 */
export function rubberband(overshoot, dimension, constant = 0.55) {
    return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

/**
 * Momentum projection for flick gestures
 * Apple's exponential decay projection
 */
export function projectMomentum(velocity, decelerationRate = 0.998) {
    return (velocity / 1000) * decelerationRate / (1 - decelerationRate);
}

/**
 * Check if reduced motion is preferred
 */
export function prefersReducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Check if reduced transparency is preferred
 */
export function prefersReducedTransparency() {
    return window.matchMedia('(prefers-reduced-transparency: reduce)').matches;
}

/**
 * Check if high contrast is preferred
 */
export function prefersHighContrast() {
    return window.matchMedia('(prefers-contrast: more)').matches;
}