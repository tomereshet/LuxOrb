const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

// --- Constants ---
const ORB_RADIUS = 20;
const ORBIT_RADIUS = ORB_RADIUS * 1.5;   // 30
const ORBIT_SPEED = 0.002;
const PARTICLE_RADIUS = 4;
const CAPTURE_RADIUS = ORB_RADIUS * 2.3; // 46
const DIRECTED_GRAVITY = 0.055;  // constant acceleration per frame in aimed direction
const FRICTION = 0.996;
const MIN_ORB_DISTANCE = ORB_RADIUS * 6;
const NUM_ORBS = 10;
const PHASE_LERP = 0.05;
const RADIUS_LERP = 0.08;
const MIN_DRAG = 15;            // pixels before drag counts as aimed
const TAU = Math.PI * 2;
const PALETTES = {
    normal:     ['#ff4455', '#44aaff', '#ffdd33', '#44ee88', '#ff8800', '#cc44ff'],
    colorblind: ['#E69F00', '#56B4E9', '#009E73', '#F0E442', '#0072B2', '#CC79A7']
};
let PARTICLE_COLORS = [...PALETTES.normal];
const EFFECTS = ['spawn3', 'rocket', 'blip', 'fireworks'];

// --- State ---
let cW, cH;
let orbs = [];
let freeParticles = [];
let drag = null; // { orb, x, y }
let debris = []; // blip fragments: { x, y, vx, vy, color, r }
let score = 0;
let points = 0;
let blackHole = null; // { x, y, particles[], spiralAngle, absorbing, pullingOrb }
let bhCooldown = 0;  // # of orbs that must be fired before a new black hole can spawn
let bestPoints = parseInt(localStorage.getItem('best_pts') || '0');
let stars = [];
let starAngle = 0;
let blipToast = null; // { x, y, vy, alpha }

// --- Palette switching ---
function switchPalette(name) {
    const oldColors = [...PARTICLE_COLORS];
    const newColors = PALETTES[name];
    if (!newColors) return;
    PARTICLE_COLORS = [...newColors];
    const remap = c => { const i = oldColors.indexOf(c); return i !== -1 ? newColors[i] : c; };
    for (const orb of orbs) {
        orb.recipe = orb.recipe.map(remap);
        for (const p of orb.particles) p.color = remap(p.color);
    }
    for (const p of freeParticles) p.color = remap(p.color);
    for (const d of debris) d.color = remap(d.color);
}

// --- Resize ---
function resize() {
    const dpr = window.devicePixelRatio || 1;
    cW = canvas.offsetWidth;
    cH = canvas.offsetHeight;
    canvas.width  = cW * dpr;
    canvas.height = cH * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    initStars();
}
window.addEventListener('resize', resize);
resize();

// --- Orb factory helpers ---
function makeRecipe(size = 3) {
    const shuffled = [...PARTICLE_COLORS].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, size);
}

function spawn3Chance() {
    const level = Math.floor(score / LEVEL_SIZE) + 1;
    return 0.40 * Math.pow(0.95, level - 1);
}

function pickEffect() {
    return Math.random() < spawn3Chance()
        ? 'spawn3'
        : EFFECTS.filter(e => e !== 'spawn3')[Math.floor(Math.random() * 3)];
}

function makeOrb(x, y) {
    const phase = Math.random() * TAU;
    const effect = pickEffect();
    const orb = {
        x, y, alive: true,
        alpha: 0, spawning: true, dying: false,
        rotation: Math.random() * TAU,
        recipe: makeRecipe(effect === 'blip' ? 2 : 3),
        effect,
        overloadPhase: null, overloadT: 0,
        vx: 0, vy: 0,
        splitting: false, splitT: 0, splitDirX: 0, splitDirY: 0, splitParticlesB: [],
        blipPulse: 0,
        particles: []
    };
    const phase2 = (phase + Math.PI) % TAU;
    orb.particles.push(
        { color: PARTICLE_COLORS[Math.floor(Math.random() * PARTICLE_COLORS.length)], phase,  targetPhase: phase,  r: ORBIT_RADIUS },
        { color: PARTICLE_COLORS[Math.floor(Math.random() * PARTICLE_COLORS.length)], phase: phase2, targetPhase: phase2, r: ORBIT_RADIUS }
    );
    return orb;
}

function spawnOrb(avoidX, avoidY) {
    const pad = 80;
    const avoidDist = MIN_ORB_DISTANCE * 3;
    let x, y, attempts = 0;
    do {
        x = randomBetween(pad, cW - pad);
        y = randomBetween(pad, cH - pad);
        attempts++;
    } while (attempts < 200 && (
        orbs.some(o => o.alive && dist(o, { x, y }) < MIN_ORB_DISTANCE) ||
        (avoidX != null && dist({ x, y }, { x: avoidX, y: avoidY }) < avoidDist)
    ));
    orbs.push(makeOrb(x, y));
}

function makeOrbFromSplit(x, y, particles) {
    const effect = pickEffect();
    const orb = {
        x, y, alive: true,
        alpha: 1, spawning: false, dying: false,
        splitting: false, splitT: 0, splitDirX: 0, splitDirY: 0, splitParticlesB: [],
        rotation: Math.random() * TAU,
        recipe: makeRecipe(effect === 'blip' ? 2 : 3),
        effect,
        overloadPhase: null, overloadT: 0,
        vx: 0, vy: 0,
        blipPulse: 0,
        particles
    };
    redistributeParticles(orb);
    return orb;
}

function startSplit(orb) {
    // Blip any particles beyond 9
    while (orb.particles.length > 9) {
        const idx = Math.floor(Math.random() * orb.particles.length);
        const p = orb.particles.splice(idx, 1)[0];
        const a = orb.rotation + p.phase;
        const x = orb.x + Math.cos(a) * p.r, y = orb.y + Math.sin(a) * p.r;
        for (let i = 0; i < 10; i++) {
            const da = Math.random() * TAU, spd = 0.2 + Math.random() * 0.6;
            debris.push({ x, y, vx: Math.cos(da) * spd, vy: Math.sin(da) * spd, color: p.color, r: PARTICLE_RADIUS * 0.75 });
        }
    }
    orb.splitting = true;
    orb.splitT = 0;
    const angle = Math.random() * TAU;
    orb.splitDirX = Math.cos(angle);
    orb.splitDirY = Math.sin(angle);
    const all = [...orb.particles].sort(() => Math.random() - 0.5);
    const half = Math.ceil(all.length / 2);
    orb.particles = all.slice(0, half);
    orb.splitParticlesB = all.slice(half);
    redistributeParticles(orb);
    const n = orb.splitParticlesB.length;
    for (let i = 0; i < n; i++) {
        const t = (i / n) * TAU;
        orb.splitParticlesB[i].phase = t;
        orb.splitParticlesB[i].targetPhase = t;
        orb.splitParticlesB[i].r = ORBIT_RADIUS;
    }
    points += 5;
    updateHUD();
}

function finishSplit(orb) {
    orb.splitting = false;
    const maxOffset = ORB_RADIUS * 3;
    const pad = ORB_RADIUS + 4;
    const newX = Math.max(pad, Math.min(cW - pad, orb.x + orb.splitDirX * maxOffset));
    const newY = Math.max(pad, Math.min(cH - pad, orb.y + orb.splitDirY * maxOffset));
    orb.x = Math.max(pad, Math.min(cW - pad, orb.x - orb.splitDirX * maxOffset));
    orb.y = Math.max(pad, Math.min(cH - pad, orb.y - orb.splitDirY * maxOffset));
    const newOrb = makeOrbFromSplit(newX, newY, orb.splitParticlesB);
    orb.splitParticlesB = [];
    orbs.push(newOrb);
}

// --- Helpers ---
function dist(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
}

function randomBetween(min, max) {
    return min + Math.random() * (max - min);
}

function initStars() {
    stars = [];
    const maxR = Math.sqrt((cW / 2) * (cW / 2) + (cH / 2) * (cH / 2)) * 1.15;
    for (let i = 0; i < 80; i++) {
        const r = Math.random() * maxR;
        const a = Math.random() * TAU;
        stars.push({
            x: Math.cos(a) * r,
            y: Math.sin(a) * r,
            size: 0.4 + Math.random() * 1.2,
            opacity: 0.12 + Math.random() * 0.38
        });
    }
}

function angleDiff(from, to) {
    let d = ((to - from) % TAU + TAU) % TAU;
    if (d > Math.PI) d -= TAU;
    return d;
}

// --- Redistribute particles evenly around orb ---
function redistributeParticles(orb) {
    const n = orb.particles.length;
    if (n === 0) return;
    if (n === 1) { orb.particles[0].targetPhase = orb.particles[0].phase; return; }

    const spacing = TAU / n;

    const sorted = orb.particles.map((p, i) => ({
        i,
        norm: ((p.phase % TAU) + TAU) % TAU
    })).sort((a, b) => a.norm - b.norm);

    let bestCost = Infinity;
    let bestTargets = null;

    for (let r = 0; r < n; r++) {
        const base = sorted[r].norm;
        let cost = 0;
        const targets = new Array(n);
        for (let i = 0; i < n; i++) {
            const idx = sorted[(i + r) % n].i;
            const target = base + i * spacing;
            cost += Math.abs(angleDiff(orb.particles[idx].phase, target));
            targets[idx] = target;
        }
        if (cost < bestCost) {
            bestCost = cost;
            bestTargets = targets;
        }
    }

    for (let i = 0; i < n; i++) {
        orb.particles[i].targetPhase = bestTargets[i];
    }
}

// --- Init ---
function init() {
    orbs = [];
    freeParticles = [];
    debris = [];
    drag = null;
    score = 0;
    points = 0;
    blackHole = null;
    bhCooldown = 0;
    initStars();
    const pad = 80;
    for (let i = 0; i < NUM_ORBS; i++) {
        let x, y, attempts = 0;
        do {
            x = randomBetween(pad, cW - pad);
            y = randomBetween(pad, cH - pad);
            attempts++;
        } while (
            attempts < 200 &&
            orbs.some(o => dist(o, { x, y }) < MIN_ORB_DISTANCE)
        );
        orbs.push(makeOrb(x, y));
    }
    updateHUD();
}

// --- Effects ---
function isRecipeFulfilled(orb) {
    return orb.recipe.every(color => orb.particles.some(p => p.color === color));
}

// Removes up to `count` random particles from alive orbs and returns their positions/colors
function stealParticles(count) {
    const pool = [];
    for (const orb of orbs) {
        if (!orb.alive || orb.dying) continue;
        for (const p of orb.particles) {
            const angle = orb.rotation + p.phase;
            pool.push({ orb, particle: p,
                x: orb.x + Math.cos(angle) * p.r,
                y: orb.y + Math.sin(angle) * p.r,
                color: p.color });
        }
    }
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const stolen = pool.slice(0, Math.min(count, pool.length));
    const affectedOrbs = new Set();
    for (const item of stolen) {
        const idx = item.orb.particles.indexOf(item.particle);
        if (idx !== -1) { item.orb.particles.splice(idx, 1); affectedOrbs.add(item.orb); }
    }
    for (const orb of affectedOrbs) redistributeParticles(orb);
    return stolen;
}

function effectRocket() {
    const candidates = orbs.filter(o => o.alive && !o.dying);
    if (candidates.length === 0) return;
    const target = candidates[Math.floor(Math.random() * candidates.length)];
    const particles = target.particles.splice(0);
    redistributeParticles(target);
    for (const p of particles) {
        const angle = target.rotation + p.phase;
        const absX = target.x + Math.cos(angle) * p.r;
        const absY = target.y + Math.sin(angle) * p.r;
        const dx = absX - target.x, dy = absY - target.y;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        const speed = 2 + Math.random() * 1;
        freeParticles.push({ x: absX, y: absY,
            vx: (dx / len) * speed, vy: (dy / len) * speed,
            gx: 0, gy: 0, useOrbGravity: true,
            skipOrb: target,
            glowColor: '#ffffff', glowBlur: 45, color: p.color });
    }
}

function effectBlip() {
    for (const { x, y, color } of stealParticles(5)) {
        for (let i = 0; i < 10; i++) {
            const a = Math.random() * TAU;
            const speed = 0.2 + Math.random() * 0.6;
            debris.push({ x, y,
                vx: Math.cos(a) * speed, vy: Math.sin(a) * speed,
                color, r: PARTICLE_RADIUS * 0.75, lifeRate: 0.0275 });
        }
    }
}

// Blip one particle of each color from a specific orb (overload trigger)
function orbBlip(orb) {
    const removed = [];
    for (const color of PARTICLE_COLORS) {
        const idx = orb.particles.findIndex(p => p.color === color);
        if (idx !== -1) {
            const p = orb.particles.splice(idx, 1)[0];
            const angle = orb.rotation + p.phase;
            removed.push({
                x: orb.x + Math.cos(angle) * p.r,
                y: orb.y + Math.sin(angle) * p.r,
                color: p.color
            });
        }
    }
    if (removed.length > 0) redistributeParticles(orb);
    for (const { x, y, color } of removed) {
        for (let i = 0; i < 10; i++) {
            const a = Math.random() * TAU;
            const speed = 0.2 + Math.random() * 0.6;
            debris.push({ x, y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, color, r: PARTICLE_RADIUS * 0.75, lifeRate: 0.0275 });
        }
    }
}

function effectFireworks() {
    const pad = 60;
    for (let i = 0; i < 5; i++) {
        const x = randomBetween(pad, cW - pad);
        const y = randomBetween(pad, cH - pad);
        const color = PARTICLE_COLORS[Math.floor(Math.random() * PARTICLE_COLORS.length)];
        const a = Math.random() * TAU;
        const speed = 0.5 + Math.random() * 1;
        freeParticles.push({ x, y,
            vx: Math.cos(a) * speed, vy: Math.sin(a) * speed,
            gx: 0, gy: 0, useOrbGravity: true, color });
    }
}

function triggerEffect(orb) {
    points += 10;
    updateHUD();
    if      (orb.effect === 'spawn3')    { spawnOrb(orb.x, orb.y); spawnOrb(orb.x, orb.y); spawnOrb(orb.x, orb.y); }
    else if (orb.effect === 'rocket')    { effectRocket(); }
    else if (orb.effect === 'blip')      { effectBlip(); }
    else if (orb.effect === 'fireworks') { effectFireworks(); }
}

// --- Die / explode ---
function onOrbFired(dyingOrb) {
    if (bhCooldown > 0) bhCooldown--;
    // Each alive blip orb drains one particle when any other orb is fired
    for (const blipOrb of orbs) {
        if (!blipOrb.alive || blipOrb.dying || blipOrb.splitting) continue;
        if (blipOrb.effect !== 'blip' || blipOrb === dyingOrb) continue;
        if (Math.random() > 0.30) continue;
        const victims = [];
        for (const other of orbs) {
            if (other === blipOrb || other === dyingOrb || !other.alive || other.dying || other.splitting) continue;
            for (const p of other.particles) victims.push({ orb: other, particle: p });
        }
        if (victims.length === 0) continue;
        const pick = victims[Math.floor(Math.random() * victims.length)];
        const angle = pick.orb.rotation + pick.particle.phase;
        const px = pick.orb.x + Math.cos(angle) * pick.particle.r;
        const py = pick.orb.y + Math.sin(angle) * pick.particle.r;
        const pcolor = pick.particle.color;
        const idx = pick.orb.particles.indexOf(pick.particle);
        if (idx !== -1) { pick.orb.particles.splice(idx, 1); redistributeParticles(pick.orb); }
        for (let i = 0; i < 8; i++) {
            const da = Math.random() * TAU, spd = 0.15 + Math.random() * 0.4;
            debris.push({ x: px, y: py, vx: Math.cos(da)*spd, vy: Math.sin(da)*spd, color: pcolor, r: PARTICLE_RADIUS * 0.75 });
        }
        blipOrb.blipPulse = 1;
    }
}

function startDying(orb, dirX, dirY) {
    orb.dying = true;
    orb._dirX = dirX;
    orb._dirY = dirY;
    orb._recipeFulfilled = isRecipeFulfilled(orb);
    onOrbFired(orb);
}

function isDeadlocked() {
    const alive = orbs.filter(o => o.alive && !o.dying && !o.spawning);
    if (alive.length === 0) return true;
    if (alive.some(o => o.splitting)) return false; // split in progress — new orb pending
    return alive.every(o => o.effect === 'blip' && !isRecipeFulfilled(o));
}

function completeDeath(orb) {
    orb.alive = false;
    const { _dirX: dirX, _dirY: dirY } = orb;
    for (const p of orb.particles) {
        const angle = orb.rotation + p.phase;
        const absX = orb.x + Math.cos(angle) * p.r;
        const absY = orb.y + Math.sin(angle) * p.r;
        const speed = ORBIT_SPEED * p.r;
        freeParticles.push({
            x: absX, y: absY,
            vx: -Math.sin(angle) * speed,
            vy:  Math.cos(angle) * speed,
            gx: dirX * DIRECTED_GRAVITY,
            gy: dirY * DIRECTED_GRAVITY,
            useOrbGravity: false,
            color: p.color
        });
    }
    orb.particles = [];
    if (orb._recipeFulfilled) triggerEffect(orb);
    if (blackHole && blackHole.pullingOrb === orb) { blackHole = null; bhCooldown = 5; }
    points++;
    score++;
    updateHUD();
    const currentLevel = Math.floor(score / LEVEL_SIZE) + 1;
    if (!blackHole && bhCooldown === 0 && currentLevel >= 3 && orbs.filter(o => o.alive).length > 0 && Math.random() < 0.25) {
        spawnBlackHole();
    }
    if (isDeadlocked()) setTimeout(() => window.onGameOver?.(), 3000);
}

// --- Input ---
function getOrbAt(px, py) {
    for (const orb of orbs) {
        if (orb.alive && !orb.dying && !orb.spawning && dist({ x: px, y: py }, orb) < ORB_RADIUS + 15) return orb;
    }
    return null;
}

function onPointerDown(px, py) {
    const orb = getOrbAt(px, py);
    if (orb) drag = { orb, x: px, y: py };
}

function onPointerMove(px, py) {
    if (drag) { drag.x = px; drag.y = py; }
}

function onPointerUp() {
    if (!drag) return;
    const dx = drag.x - drag.orb.x;
    const dy = drag.y - drag.orb.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len >= MIN_DRAG && drag.orb.alive && !drag.orb.dying) {
        const blipLocked = drag.orb.effect === 'blip' && !isRecipeFulfilled(drag.orb);
        if (!blipLocked) {
            startDying(drag.orb, dx / len, dy / len);
        } else {
            blipToast = { x: drag.orb.x, y: drag.orb.y - ORB_RADIUS - 18, vy: -0.35, alpha: 1.0 };
        }
    }
    drag = null;
}

function toCanvas(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    return [clientX - r.left, clientY - r.top];
}

canvas.addEventListener('mousedown',  (e) => onPointerDown(...toCanvas(e.clientX, e.clientY)));
canvas.addEventListener('mousemove',  (e) => onPointerMove(...toCanvas(e.clientX, e.clientY)));
canvas.addEventListener('mouseup',    ()  => onPointerUp());
canvas.addEventListener('mouseleave', ()  => { drag = null; });

canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const t = e.touches[0];
    onPointerDown(...toCanvas(t.clientX, t.clientY));
}, { passive: false });
canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    const t = e.touches[0];
    onPointerMove(...toCanvas(t.clientX, t.clientY));
}, { passive: false });
canvas.addEventListener('touchend', (e) => {
    e.preventDefault();
    onPointerUp();
}, { passive: false });

// --- Black hole ---
function spawnBlackHole() {
    const pad = 80;
    blackHole = {
        x: randomBetween(pad, cW - pad),
        y: randomBetween(pad, cH - pad),
        particles: [],
        spiralAngle: 0,
        absorbing: false,
        pullingOrb: null,
    };
    window.onBlackHoleSpawned?.();
}

function checkBlackHoleComplete() {
    if (!blackHole) return;
    if (!PARTICLE_COLORS.every(c => blackHole.particles.some(p => p.color === c))) return;
    let closest = null, closestDist = Infinity;
    for (const orb of orbs) {
        if (!orb.alive || orb.dying || orb.splitting) continue;
        const d = dist(orb, blackHole);
        if (d < closestDist) { closestDist = d; closest = orb; }
    }
    if (!closest) { blackHole = null; bhCooldown = 5; return; }
    blackHole.absorbing = true;
    blackHole.pullingOrb = closest;
    const dx = blackHole.x - closest.x, dy = blackHole.y - closest.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    startDying(closest, dx / len, dy / len);
    closest._recipeFulfilled = true; // always trigger effect
}

// --- Update ---
function update() {
    starAngle += 0.00008;
    if (blipToast) {
        blipToast.y  += blipToast.vy;
        blipToast.alpha -= 0.008;
        if (blipToast.alpha <= 0) blipToast = null;
    }
    const pendingDeath = [];
    for (const orb of orbs) {
        if (!orb.alive) continue;
        orb.rotation += ORBIT_SPEED;
        for (const p of orb.particles) {
            p.phase += angleDiff(p.phase, p.targetPhase) * PHASE_LERP;
            p.r += (ORBIT_RADIUS - p.r) * RADIUS_LERP;
        }
        if (orb.splitting) {
            for (const p of orb.splitParticlesB) {
                p.phase += angleDiff(p.phase, p.targetPhase) * PHASE_LERP;
                p.r += (ORBIT_RADIUS - p.r) * RADIUS_LERP;
            }
            orb.splitT = Math.min(1, orb.splitT + 1 / 60);
            if (orb.splitT >= 1) finishSplit(orb);
            continue;
        }
        if (orb.dying) {
            orb.alpha -= 0.03;
            if (orb.alpha <= 0) pendingDeath.push(orb);
        } else if (orb.spawning) {
            orb.alpha = Math.min(1, orb.alpha + 0.025);
            if (orb.alpha >= 1) orb.spawning = false;
        } else {
            // Decay blip pulse glow
            if (orb.blipPulse > 0) orb.blipPulse = Math.max(0, orb.blipPulse - 1 / 30);
            if (orb.particles.length >= 10) {
                startSplit(orb);
            } else {
            // Overload: fires when orb holds all 6 colors at once
            if (!orb.overloadPhase) {
                if (PARTICLE_COLORS.every(c => orb.particles.some(p => p.color === c))) {
                    orb.overloadPhase = 'charging';
                    orb.overloadT = 0;
                }
            } else if (orb.overloadPhase === 'charging') {
                orb.overloadT = Math.min(1, orb.overloadT + 1 / 80);
                if (orb.overloadT >= 1) {
                    orbBlip(orb);
                    orb.overloadPhase = 'fading';
                }
            } else if (orb.overloadPhase === 'fading') {
                orb.overloadT = Math.max(0, orb.overloadT - 1 / 30);
                if (orb.overloadT <= 0) orb.overloadPhase = null;
            }
            } // end split else
        }
    }
    for (const orb of pendingDeath) completeDeath(orb);

    // Orb repulsion — push alive orbs apart so they never overlap
    const aliveOrbs = orbs.filter(o => o.alive);
    const ORB_REPEL_DIST = ORB_RADIUS * 3;
    const ORB_REPEL_STR  = 0.45;
    const ORB_PAD        = ORB_RADIUS + 4;
    const WALL_ZONE      = 55;
    const WALL_STR       = 0.35;
    const MAX_ORB_SPEED  = 0.05;
    const FUZZ_STR       = 0.008;
    for (let i = 0; i < aliveOrbs.length; i++) {
        for (let j = i + 1; j < aliveOrbs.length; j++) {
            const a = aliveOrbs[i], b = aliveOrbs[j];
            const dx = b.x - a.x, dy = b.y - a.y;
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d < ORB_REPEL_DIST && d > 0.1) {
                const f = (ORB_REPEL_DIST - d) / ORB_REPEL_DIST * ORB_REPEL_STR;
                const nx = dx / d, ny = dy / d;
                a.vx -= nx * f;  a.vy -= ny * f;
                b.vx += nx * f;  b.vy += ny * f;
            }
        }
    }
    if (blackHole) {
        for (const orb of aliveOrbs) {
            if (orb.dying || orb.splitting || orb === blackHole.pullingOrb) continue;
            const dx = orb.x - blackHole.x, dy = orb.y - blackHole.y;
            const d = Math.sqrt(dx * dx + dy * dy);
            const BH_REPEL = ORB_RADIUS * 6;
            if (d < BH_REPEL && d > 0.1) {
                const f = (BH_REPEL - d) / BH_REPEL * 0.4;
                orb.vx += (dx / d) * f;
                orb.vy += (dy / d) * f;
            }
        }
        blackHole.spiralAngle += 0.025;
    }
    for (const orb of aliveOrbs) {
        if (orb.x < WALL_ZONE)                orb.vx += (WALL_ZONE - orb.x) / WALL_ZONE * WALL_STR;
        if (orb.x > cW  - WALL_ZONE) orb.vx -= (orb.x - (cW  - WALL_ZONE)) / WALL_ZONE * WALL_STR;
        if (orb.y < WALL_ZONE)                orb.vy += (WALL_ZONE - orb.y) / WALL_ZONE * WALL_STR;
        if (orb.y > cH - WALL_ZONE) orb.vy -= (orb.y - (cH - WALL_ZONE)) / WALL_ZONE * WALL_STR;
        orb.vx += (Math.random() - 0.5) * FUZZ_STR;
        orb.vy += (Math.random() - 0.5) * FUZZ_STR;
        orb.x += orb.vx;
        orb.y += orb.vy;
        const spd = Math.sqrt(orb.vx * orb.vx + orb.vy * orb.vy);
        if (spd > MAX_ORB_SPEED) { orb.vx = orb.vx / spd * MAX_ORB_SPEED; orb.vy = orb.vy / spd * MAX_ORB_SPEED; }
        orb.x = Math.max(ORB_PAD, Math.min(cW  - ORB_PAD, orb.x));
        orb.y = Math.max(ORB_PAD, Math.min(cH - ORB_PAD, orb.y));
    }

    const toRemove = [];
    for (let i = 0; i < freeParticles.length; i++) {
        const p = freeParticles[i];

        // Decay rocket glow back to normal
        if (p.glowBlur > 12) {
            p.glowBlur -= 0.52;
            if (p.glowBlur <= 12) { p.glowBlur = 12; p.glowColor = undefined; }
        }

        // Clear skipOrb once the particle has escaped its source orb's capture zone
        if (p.skipOrb && dist(p, p.skipOrb) > CAPTURE_RADIUS + 10) p.skipOrb = null;

        // Gravity: directional until first wall hit, then orb gravity
        if (p.useOrbGravity) {
            for (const orb of orbs) {
                if (!orb.alive || orb.dying || orb === p.skipOrb) continue;
                const dx = orb.x - p.x;
                const dy = orb.y - p.y;
                const d2 = dx * dx + dy * dy;
                const d = Math.sqrt(d2);
                if (d < 1) continue;
                const force = 350 / d2;
                p.vx += (dx / d) * force;
                p.vy += (dy / d) * force;
            }
        } else {
            p.vx += p.gx;
            p.vy += p.gy;
        }

        // Black hole attraction
        if (blackHole) {
            const dx = blackHole.x - p.x, dy = blackHole.y - p.y;
            const d2 = dx * dx + dy * dy, d = Math.sqrt(d2);
            if (d >= 1) { const f = 400 / d2; p.vx += (dx / d) * f; p.vy += (dy / d) * f; }
        }

        p.x += p.vx;
        p.y += p.vy;
        p.vx *= FRICTION;
        p.vy *= FRICTION;

        // Bounce off edges — first hit switches gravity mode
        if (p.x < PARTICLE_RADIUS)                  { p.x = PARTICLE_RADIUS;                  p.vx *= -1; p.useOrbGravity = true; }
        if (p.x > cW  - PARTICLE_RADIUS)  { p.x = cW  - PARTICLE_RADIUS;  p.vx *= -1; p.useOrbGravity = true; }
        if (p.y < PARTICLE_RADIUS)                  { p.y = PARTICLE_RADIUS;                  p.vy *= -1; p.useOrbGravity = true; }
        if (p.y > cH - PARTICLE_RADIUS)  { p.y = cH - PARTICLE_RADIUS;  p.vy *= -1; p.useOrbGravity = true; }

        // Capture by black hole first, then orbs
        let captured = false;
        if (blackHole && !blackHole.absorbing && dist(p, blackHole) < CAPTURE_RADIUS) {
            blackHole.particles.push({ color: p.color });
            toRemove.push(i);
            captured = true;
            checkBlackHoleComplete();
        }
        if (!captured) {
            for (const orb of orbs) {
                if (!orb.alive || orb.dying || orb === p.skipOrb) continue;
                if (dist(p, orb) < CAPTURE_RADIUS) {
                    const captureAngle = Math.atan2(p.y - orb.y, p.x - orb.x);
                    const phase = captureAngle - orb.rotation;
                    orb.particles.push({ color: p.color, phase, targetPhase: phase, r: dist(p, orb) });
                    redistributeParticles(orb);
                    toRemove.push(i);
                    break;
                }
            }
        }
    }
    for (let i = toRemove.length - 1; i >= 0; i--) {
        freeParticles.splice(toRemove[i], 1);
    }

    // Update blip debris
    for (let i = debris.length - 1; i >= 0; i--) {
        const d = debris[i];
        d.x += d.vx; d.y += d.vy;
        d.vx *= 0.88; d.vy *= 0.88;
        d.r -= (d.lifeRate ?? 0.11);
        if (d.r <= 0) debris.splice(i, 1);
    }
}

// --- Draw ---
function drawOrb(orb) {
    // Blip orb: expanding red ring when it drains a particle
    if (orb.blipPulse > 0) {
        const bp = orb.blipPulse;
        const ringR = ORB_RADIUS * (1 + (1 - bp) * 1.6);
        ctx.save();
        ctx.shadowBlur = 22 * bp; ctx.shadowColor = 'rgba(255,40,40,0.9)';
        ctx.strokeStyle = `rgba(255,55,55,${bp * 0.85})`;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(orb.x, orb.y, ringR, 0, TAU); ctx.stroke();
        ctx.restore();
    }

    // White orb (with overload red glow when all 6 colors present)
    const ot = orb.overloadPhase ? orb.overloadT : 0;
    if (ot > 0) {
        const haloR = ORB_RADIUS * (1 + ot * 1.8);
        const grad = ctx.createRadialGradient(orb.x, orb.y, ORB_RADIUS * 0.4, orb.x, orb.y, haloR);
        grad.addColorStop(0, `rgba(255,40,40,${ot * 0.55})`);
        grad.addColorStop(1, 'rgba(255,0,0,0)');
        ctx.save();
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(orb.x, orb.y, haloR, 0, TAU);
        ctx.fill();
        ctx.restore();
    }
    ctx.save();
    ctx.shadowBlur = 22 + ot * 35;
    ctx.shadowColor = ot > 0
        ? `rgba(255,${Math.round(255 * (1 - ot))},${Math.round(255 * (1 - ot))},0.9)`
        : 'rgba(255,255,255,0.8)';
    ctx.fillStyle = '#111';
    ctx.strokeStyle = ot > 0
        ? `rgba(255,${Math.round(200 * (1 - ot))},${Math.round(200 * (1 - ot))},0.9)`
        : 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(orb.x, orb.y, ORB_RADIUS, 0, TAU);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // Effect icon
    {
        const ix = orb.x, iy = orb.y - 7;
        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.7)';
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 1;

        if (orb.effect === 'spawn3') {
            // Three empty circle outlines (mini orbs) in a triangle, each with a tiny particle dot
            const orbR = 3.5, dotR = 1.5;
            const centers = [[ix, iy - 5], [ix - 7, iy + 3], [ix + 7, iy + 3]];
            for (const [cx, cy] of centers) {
                ctx.beginPath(); ctx.arc(cx, cy, orbR, 0, TAU); ctx.stroke();
                ctx.beginPath(); ctx.arc(cx + 3.2, cy - 3.2, dotR, 0, TAU); ctx.fill();
            }

        } else if (orb.effect === 'rocket') {
            // Rocket shape pointing upward
            ctx.save();
            ctx.translate(ix, iy);
            // Nose cone
            ctx.beginPath();
            ctx.moveTo(0, -9); ctx.lineTo(-3, -4); ctx.lineTo(3, -4);
            ctx.closePath(); ctx.fill();
            // Body
            ctx.fillRect(-2.5, -4, 5, 8);
            // Left fin
            ctx.beginPath();
            ctx.moveTo(-2.5, 2); ctx.lineTo(-5.5, 6); ctx.lineTo(-2.5, 5);
            ctx.closePath(); ctx.fill();
            // Right fin
            ctx.beginPath();
            ctx.moveTo(2.5, 2); ctx.lineTo(5.5, 6); ctx.lineTo(2.5, 5);
            ctx.closePath(); ctx.fill();
            // Window (dark circle)
            ctx.fillStyle = 'rgba(17,17,17,0.7)';
            ctx.beginPath(); ctx.arc(0, -1, 1.5, 0, TAU); ctx.fill();
            ctx.restore();

        } else if (orb.effect === 'blip') {
            // Dashed circle (broken/disappearing) with small scattered dots inside
            ctx.setLineDash([2, 3]);
            ctx.beginPath(); ctx.arc(ix, iy, 7, 0, TAU); ctx.stroke();
            ctx.setLineDash([]);
            for (let i = 0; i < 5; i++) {
                const a = (i / 5) * TAU;
                ctx.beginPath(); ctx.arc(ix + Math.cos(a) * 3, iy + Math.sin(a) * 3, 1.3, 0, TAU); ctx.fill();
            }

        } else if (orb.effect === 'fireworks') {
            // Starburst: 6 radiating lines with dots at tips
            ctx.save();
            ctx.translate(ix, iy);
            for (let i = 0; i < 6; i++) {
                const a = (i / 6) * TAU;
                ctx.beginPath();
                ctx.moveTo(Math.cos(a) * 2, Math.sin(a) * 2);
                ctx.lineTo(Math.cos(a) * 8, Math.sin(a) * 8);
                ctx.stroke();
                ctx.beginPath(); ctx.arc(Math.cos(a) * 8, Math.sin(a) * 8, 1.3, 0, TAU); ctx.fill();
            }
            ctx.restore();
        }

        ctx.restore();
    }

    // Recipe: 3 colored dots near bottom of orb; filled white inside when that color is held
    const dotY = orb.y + 10;
    for (let i = 0; i < orb.recipe.length; i++) {
        const c = orb.recipe[i];
        const dotX = orb.x + (i - (orb.recipe.length - 1) / 2) * 9;
        const fulfilled = orb.particles.some(p => p.color === c);
        ctx.save();
        ctx.fillStyle = c;
        ctx.shadowBlur = 6;
        ctx.shadowColor = c;
        ctx.beginPath();
        ctx.arc(dotX, dotY, 3, 0, TAU);
        ctx.fill();
        if (fulfilled) {
            ctx.shadowBlur = 0;
            ctx.strokeStyle = 'rgba(255,255,255,0.85)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(dotX, dotY, 4.5, 0, TAU);
            ctx.stroke();
        }
        ctx.restore();
    }
}

function drawParticle(x, y, color, glowColor = color, glowBlur = 12) {
    ctx.save();

    // Radial gradient halo for strong custom glows (more reliable than high shadowBlur)
    if (glowBlur > 12) {
        const t = (glowBlur - 12) / 33; // 0→1 as glowBlur decays 45→12
        const haloRadius = PARTICLE_RADIUS + glowBlur * 0.4;
        const grad = ctx.createRadialGradient(x, y, PARTICLE_RADIUS, x, y, haloRadius);
        grad.addColorStop(0, glowColor);
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.globalAlpha = t * 0.35;
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(x, y, haloRadius, 0, TAU);
        ctx.fill();
        ctx.globalAlpha = 1;
    }

    ctx.shadowBlur = Math.min(glowBlur, 18);
    ctx.shadowColor = glowColor;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, PARTICLE_RADIUS, 0, TAU);
    ctx.fill();
    ctx.restore();
}

function drawSplittingOrb(orb) {
    const maxOffset = ORB_RADIUS * 3;
    const offset = orb.splitT * maxOffset;
    const ax = orb.x - orb.splitDirX * offset, ay = orb.y - orb.splitDirY * offset;
    const bx = orb.x + orb.splitDirX * offset, by = orb.y + orb.splitDirY * offset;
    const d = offset * 2;

    // Fills
    ctx.fillStyle = '#111';
    ctx.shadowBlur = 22; ctx.shadowColor = 'rgba(255,255,255,0.8)';
    ctx.beginPath(); ctx.arc(ax, ay, ORB_RADIUS, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(bx, by, ORB_RADIUS, 0, TAU); ctx.fill();
    ctx.shadowBlur = 0;

    // Outlines — each clipped outside the other circle
    const drawClippedArc = (cx, cy, clipX, clipY) => {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, cW, cH);
        ctx.arc(clipX, clipY, ORB_RADIUS + 1, 0, TAU, true);
        ctx.clip('evenodd');
        ctx.save();
        ctx.shadowBlur = 22; ctx.shadowColor = 'rgba(255,255,255,0.8)';
        ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(cx, cy, ORB_RADIUS, 0, TAU); ctx.stroke();
        ctx.restore();
        ctx.restore();
    };
    if (d < ORB_RADIUS * 2) {
        drawClippedArc(ax, ay, bx, by);
        drawClippedArc(bx, by, ax, ay);
    } else {
        ctx.save();
        ctx.shadowBlur = 22; ctx.shadowColor = 'rgba(255,255,255,0.8)';
        ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(ax, ay, ORB_RADIUS, 0, TAU); ctx.stroke();
        ctx.beginPath(); ctx.arc(bx, by, ORB_RADIUS, 0, TAU); ctx.stroke();
        ctx.restore();
    }

    // Particles: A half around ax,ay — B half around bx,by
    for (const p of orb.particles) {
        const a = orb.rotation + p.phase;
        drawParticle(ax + Math.cos(a) * p.r, ay + Math.sin(a) * p.r, p.color);
    }
    for (const p of orb.splitParticlesB) {
        const a = orb.rotation + p.phase;
        drawParticle(bx + Math.cos(a) * p.r, by + Math.sin(a) * p.r, p.color);
    }
}

function drawBlackHole(bh) {
    const R = ORB_RADIUS;
    // Body
    ctx.save();
    ctx.shadowBlur = 28; ctx.shadowColor = 'rgba(140,140,140,0.7)';
    ctx.fillStyle = '#030303';
    ctx.strokeStyle = 'rgba(160,160,160,0.75)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(bh.x, bh.y, R, 0, TAU);
    ctx.fill(); ctx.stroke();
    ctx.restore();
    // Spiral arms
    ctx.save();
    const numArms = 2;
    for (let arm = 0; arm < numArms; arm++) {
        const base = bh.spiralAngle + (arm / numArms) * TAU;
        ctx.strokeStyle = 'rgba(160,160,160,0.45)'; ctx.lineWidth = 1.5;
        ctx.beginPath();
        const steps = 40;
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const r = R * 0.25 + t * R * 2;
            const angle = base + t * Math.PI * 2.5;
            const px = bh.x + Math.cos(angle) * r, py = bh.y + Math.sin(angle) * r;
            i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        }
        ctx.stroke();
    }
    ctx.restore();
    // Captured particles orbiting
    for (let i = 0; i < bh.particles.length; i++) {
        const angle = bh.spiralAngle * 2 + (i / bh.particles.length) * TAU;
        drawParticle(bh.x + Math.cos(angle) * ORBIT_RADIUS, bh.y + Math.sin(angle) * ORBIT_RADIUS, bh.particles[i].color);
    }
}

function drawAimLine() {
    if (!drag || !drag.orb.alive) return;
    const dx = drag.x - drag.orb.x;
    const dy = drag.y - drag.orb.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < MIN_DRAG) return;

    const angle = Math.atan2(dy, dx);
    const tipX = drag.x;
    const tipY = drag.y;

    const isLocked = drag.orb.effect === 'blip' && !isRecipeFulfilled(drag.orb);
    const lineColor  = isLocked ? 'rgba(255, 80, 80, 0.7)'  : 'rgba(255, 255, 255, 0.55)';
    const arrowColor = isLocked ? 'rgba(255, 80, 80, 0.85)' : 'rgba(255, 255, 255, 0.75)';

    ctx.save();

    // Animated dashed line
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 5]);
    ctx.lineDashOffset = -(performance.now() * 0.03 % 11);
    ctx.beginPath();
    ctx.moveTo(drag.orb.x, drag.orb.y);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();

    // Arrowhead
    ctx.setLineDash([]);
    ctx.fillStyle = arrowColor;
    const headLen = 12;
    const headSpread = Math.PI / 6;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - headLen * Math.cos(angle - headSpread), tipY - headLen * Math.sin(angle - headSpread));
    ctx.lineTo(tipX - headLen * Math.cos(angle + headSpread), tipY - headLen * Math.sin(angle + headSpread));
    ctx.closePath();
    ctx.fill();

    ctx.restore();
}

function draw() {
    ctx.clearRect(0, 0, cW, cH);

    // Star background — slowly rotating around canvas center
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.translate(cW / 2, cH / 2);
    ctx.rotate(starAngle);
    for (const s of stars) {
        ctx.fillStyle = `rgba(255,255,255,${s.opacity})`;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.size, 0, TAU);
        ctx.fill();
    }
    ctx.restore();

    for (const orb of orbs) {
        if (!orb.alive) continue;
        ctx.save();
        ctx.globalAlpha = orb.alpha;
        if (orb.splitting) {
            drawSplittingOrb(orb);
        } else {
            drawOrb(orb);
            for (const p of orb.particles) {
                const angle = orb.rotation + p.phase;
                drawParticle(
                    orb.x + Math.cos(angle) * p.r,
                    orb.y + Math.sin(angle) * p.r,
                    p.color
                );
            }
        }
        ctx.restore();
    }
    if (blackHole) drawBlackHole(blackHole);

    for (const p of freeParticles) {
        drawParticle(p.x, p.y, p.color, p.glowColor, p.glowBlur);
    }

    // Blip debris — small fragments that shrink to nothing
    for (const d of debris) {
        ctx.save();
        ctx.globalAlpha = d.r / (PARTICLE_RADIUS * 0.75);
        ctx.shadowBlur = 7;
        ctx.shadowColor = d.color;
        ctx.fillStyle = d.color;
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.r, 0, TAU);
        ctx.fill();
        ctx.restore();
    }

    drawAimLine();

    // Blip locked toast
    if (blipToast) {
        const msg = 'Collect ingredients to fire';
        const pad = { x: 14, y: 8 };
        const fontSize = 12;
        ctx.save();
        ctx.font = `${fontSize}px system-ui, sans-serif`;
        const tw = ctx.measureText(msg).width;
        const bw = tw + pad.x * 2, bh = fontSize + pad.y * 2;
        const bx = blipToast.x - bw / 2, by = blipToast.y - bh / 2;
        ctx.globalAlpha = Math.max(0, blipToast.alpha);
        // Background pill
        ctx.fillStyle = 'rgba(20,20,20,0.88)';
        ctx.beginPath();
        ctx.roundRect(bx, by, bw, bh, bh / 2);
        ctx.fill();
        // Border
        ctx.strokeStyle = 'rgba(255,80,80,0.6)';
        ctx.lineWidth = 1;
        ctx.stroke();
        // Text
        ctx.fillStyle = 'rgba(255,200,200,0.95)';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';
        ctx.fillText(msg, blipToast.x, blipToast.y);
        ctx.restore();
    }
}

// --- HUD ---
const LEVEL_SIZE = 10;
function updateHUD() {
    const level = Math.floor(score / LEVEL_SIZE) + 1;
    const progress = score % LEVEL_SIZE;
    document.getElementById('level-label').textContent = `LEVEL ${level}`;
    document.getElementById('progress-bar-fill').style.width = `${progress * 100 / LEVEL_SIZE}%`;
    document.getElementById('points-label').textContent = `${points} pts`;
    if (points > bestPoints) {
        bestPoints = points;
        localStorage.setItem('best_pts', bestPoints);
    }
    document.getElementById('best-label').textContent = `BEST ${bestPoints}`;
}

// --- Game Loop ---
function loop() {
    update();
    draw();
    requestAnimationFrame(loop);
}

init();
loop();
