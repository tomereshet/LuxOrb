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
const EFFECTS = ['spawn3', 'rocket', 'blip', 'fireworks', 'crystalize'];
const CRYSTAL_CHECK_INTERVAL = 120;  // ~2s between passive attempts
const CRYSTAL_CHANCE = 0.2;
const CRYSTAL_PULL_STRENGTH = 0.15;
const CRYSTAL_REPEL_DIST = ORB_RADIUS * 4;    // repels orbs within 80px
const CRYSTAL_REPEL_STR = 0.6;
const CRYSTAL_PARTICLE_REPEL_DIST = ORB_RADIUS * 3;
const CRYSTAL_PARTICLE_REPEL_STR = 180;        // inverse-square coeff
const WORM_SEGMENT_COUNT = 15;
const SEGMENT_SPACING = 10;
const WORM_SPEED = 3;
const WORM_TURN_RATE = 0.12;
const WORM_AVOID_RADIUS = ORB_RADIUS * 1.8;
const WORM_EXIT_AFTER = 600; // frames (~10s at 60fps)

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
let worm = null;       // { segments[], targetX, targetY, headAngle, speed, alive, spawnAlpha, age }
let wormCooldown = 0;
let wormSpawnChecked = false;
let deadlockPending = false;
let deadlockTimer = 0;  // frames since particles settled & deadlock confirmed

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
    if (worm) for (const seg of worm.segments) seg.color = remap(seg.color);
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
    if (Math.random() < spawn3Chance()) return 'spawn3';
    const blipCount = orbs.filter(o => o.alive && !o.dying && o.effect === 'blip').length;
    const currentLevel = Math.floor(score / LEVEL_SIZE) + 1;
    const pool = EFFECTS.filter(e =>
        e !== 'spawn3' &&
        !(e === 'blip' && blipCount >= 2) &&
        !(e === 'crystalize' && currentLevel < 7)
    );
    return pool[Math.floor(Math.random() * pool.length)];
}

function makeOrb(x, y) {
    const phase = Math.random() * TAU;
    const effect = pickEffect();
    const orb = {
        x, y, alive: true,
        alpha: 0, spawning: true, dying: false,
        rotation: Math.random() * TAU,
        recipe: makeRecipe(effect === 'blip' || effect === 'fireworks' || effect === 'crystalize' ? 2 : 3),
        effect,
        overloadPhase: null, overloadT: 0,
        vx: 0, vy: 0,
        splitting: false, splitT: 0, splitDirX: 0, splitDirY: 0, splitParticlesB: [],
        blipPulse: 0,
        crystalTarget: null, crystalTimer: 0, crystalUsed: false,
        crystallized: false, crystallizedBy: null, crystalVerts: null, crystalPulse: 0,
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
        recipe: makeRecipe(effect === 'blip' || effect === 'fireworks' || effect === 'crystalize' ? 2 : 3),
        effect,
        overloadPhase: null, overloadT: 0,
        vx: 0, vy: 0,
        blipPulse: 0,
        crystalTarget: null, crystalTimer: 0, crystalUsed: false,
        crystallized: false, crystallizedBy: null, crystalVerts: null, crystalPulse: 0,
        particles
    };
    redistributeParticles(orb);
    return orb;
}

function startSplit(orb) {
    if (orb.effect === 'crystalize') releaseCrystalVictim(orb);
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
    orb.overloadPhase = null;
    orb.overloadT = 0;
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

function pointToSegmentDist(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 0.01) return dist(p, a);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return dist(p, { x: a.x + t * dx, y: a.y + t * dy });
}

function pickWormTarget() {
    const pad = 80;
    let x, y, attempts = 0;
    do {
        x = randomBetween(pad, cW - pad);
        y = randomBetween(pad, cH - pad);
        attempts++;
    } while (
        attempts < 100 &&
        orbs.some(o => o.alive && dist(o, { x, y }) < WORM_AVOID_RADIUS * 1.5)
    );
    return { x, y };
}

// --- Crystal helpers ---
function generateCrystalVerts() {
    const R = ORB_RADIUS * 1.6;
    const numPts = 10;
    // Scatter points on a circle, ensuring all 4 quadrants get at least 2
    const angles = [];
    const quadrantRanges = [[0, Math.PI/2], [Math.PI/2, Math.PI], [Math.PI, Math.PI*1.5], [Math.PI*1.5, TAU]];
    for (const [lo, hi] of quadrantRanges) {
        angles.push(lo + Math.random() * (hi - lo));
        angles.push(lo + Math.random() * (hi - lo));
    }
    while (angles.length < numPts) angles.push(Math.random() * TAU);
    angles.sort((a, b) => a - b);
    const pts = angles.map(a => {
        const r = R * (0.85 + Math.random() * 0.3);
        return { x: Math.cos(a) * r, y: Math.sin(a) * r };
    });
    // Fan triangulation of the convex polygon
    const tris = [];
    for (let i = 1; i < pts.length - 1; i++) {
        const shade = Math.floor(100 + Math.random() * 155);
        const alpha = 0.2 + Math.random() * 0.15;
        tris.push({ x1: pts[0].x, y1: pts[0].y, x2: pts[i].x, y2: pts[i].y, x3: pts[i+1].x, y3: pts[i+1].y, shade, alpha });
    }
    return tris;
}

function releaseCrystalVictim(crystalOrb) {
    const victim = crystalOrb.crystalTarget;
    if (!victim) return;
    victim.crystallized = false;
    victim.crystallizedBy = null;
    victim.crystalVerts = null;
    crystalOrb.crystalTarget = null;
    crystalOrb.crystalUsed = true;
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
    worm = null;
    wormCooldown = 0;
    wormSpawnChecked = false;
    deadlockPending = false;
    deadlockTimer = 0;
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
        if (!orb.alive || orb.dying || orb.crystallized) continue;
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
    for (let i = 0; i < 10; i++) {
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
    if      (orb.effect === 'spawn3')     { spawnOrb(orb.x, orb.y); spawnOrb(orb.x, orb.y); spawnOrb(orb.x, orb.y); }
    else if (orb.effect === 'rocket')     { effectRocket(); }
    else if (orb.effect === 'blip')       { }
    else if (orb.effect === 'fireworks')  { effectFireworks(); }
    else if (orb.effect === 'crystalize') { releaseCrystalVictim(orb); }
}

// --- Die / explode ---
function onOrbFired(dyingOrb) {
    if (bhCooldown > 0) bhCooldown--;
    wormSpawnChecked = false;
    // Each alive blip orb drains one particle when any other orb is fired
    for (const blipOrb of orbs) {
        if (!blipOrb.alive || blipOrb.dying || blipOrb.splitting) continue;
        if (blipOrb.effect !== 'blip' || blipOrb === dyingOrb) continue;
        if (Math.random() > 0.30) continue;
        const victims = [];
        for (const other of orbs) {
            if (other === blipOrb || other === dyingOrb || !other.alive || other.dying || other.splitting || other.crystallized) continue;
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
    if (orb.crystallized) return; // crystallized victims cannot die
    if (orb.effect === 'crystalize') releaseCrystalVictim(orb);
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
    return alive.every(o => o.crystallized || ((o.effect === 'blip' || o.effect === 'crystalize') && !isRecipeFulfilled(o)));
}

function completeDeath(orb) {
    orb.alive = false;
    if (orb.effect === 'crystalize') releaseCrystalVictim(orb);
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
    if (orb._recipeFulfilled && !orb.crystallized) triggerEffect(orb);
    if (blackHole && blackHole.pullingOrb === orb) { blackHole = null; bhCooldown = 5; }
    points++;
    score++;
    updateHUD();
    const currentLevel = Math.floor(score / LEVEL_SIZE) + 1;
    if (!blackHole && bhCooldown === 0 && currentLevel >= 3 && orbs.filter(o => o.alive).length > 0 && Math.random() < 0.25) {
        spawnBlackHole();
    }
    if (isDeadlocked() && !deadlockPending) {
        deadlockPending = true;
    }
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
        const recipeLocked = (drag.orb.effect === 'blip' || drag.orb.effect === 'crystalize') && !isRecipeFulfilled(drag.orb);
        if (drag.orb.crystallized) {
            // Crystallized orbs can't be fired — crystal makes it obvious
        } else if (drag.orb.overloadPhase) {
            // Overloading orbs can't be fired until overload finishes
        } else if (!recipeLocked) {
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
        if (!orb.alive || orb.dying || orb.splitting || orb.crystallized) continue;
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

// --- Worm ---
function spawnWorm() {
    // Enter from a random screen edge, aimed inward
    const side = Math.floor(Math.random() * 4);
    let x, y, headAngle;
    if (side === 0) { // top
        x = randomBetween(60, cW - 60); y = -SEGMENT_SPACING;
        headAngle = Math.PI / 2 + (Math.random() - 0.5) * 0.8;
    } else if (side === 1) { // bottom
        x = randomBetween(60, cW - 60); y = cH + SEGMENT_SPACING;
        headAngle = -Math.PI / 2 + (Math.random() - 0.5) * 0.8;
    } else if (side === 2) { // left
        x = -SEGMENT_SPACING; y = randomBetween(60, cH - 60);
        headAngle = (Math.random() - 0.5) * 0.8;
    } else { // right
        x = cW + SEGMENT_SPACING; y = randomBetween(60, cH - 60);
        headAngle = Math.PI + (Math.random() - 0.5) * 0.8;
    }
    const segments = [];
    for (let i = 0; i < WORM_SEGMENT_COUNT; i++) {
        segments.push({
            x: x - Math.cos(headAngle) * SEGMENT_SPACING * i,
            y: y - Math.sin(headAngle) * SEGMENT_SPACING * i,
            color: PARTICLE_COLORS[Math.floor(Math.random() * PARTICLE_COLORS.length)]
        });
    }
    worm = { segments, targetX: 0, targetY: 0, headAngle, speed: WORM_SPEED, alive: true, spawnAlpha: 1, age: 0 };
    const t = pickWormTarget();
    worm.targetX = t.x;
    worm.targetY = t.y;
}

function explodeWorm() {
    if (!worm) return;
    for (const seg of worm.segments) {
        const angle = Math.random() * TAU;
        const speed = 1.5 + Math.random() * 2.0;
        freeParticles.push({
            x: seg.x, y: seg.y,
            vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
            gx: 0, gy: 0, useOrbGravity: true, color: seg.color
        });
        for (let i = 0; i < 6; i++) {
            const da = Math.random() * TAU, spd = 0.3 + Math.random() * 0.8;
            debris.push({ x: seg.x, y: seg.y, vx: Math.cos(da) * spd, vy: Math.sin(da) * spd, color: seg.color, r: PARTICLE_RADIUS * 0.6 });
        }
    }
    worm = null;
    wormCooldown = 300;
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
        if (!orb.crystallized) {
            orb.rotation += ORBIT_SPEED;
            for (const p of orb.particles) {
                p.phase += angleDiff(p.phase, p.targetPhase) * PHASE_LERP;
                p.r += (ORBIT_RADIUS - p.r) * RADIUS_LERP;
            }
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
            if (orb.crystalPulse > 0) orb.crystalPulse = Math.max(0, orb.crystalPulse - 1 / 30);
            if (!orb.crystallized && orb.particles.length >= 10) {
                startSplit(orb);
            } else if (!orb.crystallized) {
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

    // --- Crystalize passive mechanic ---
    for (const orb of orbs) {
        if (!orb.alive || orb.dying || orb.spawning || orb.splitting) continue;
        if (orb.effect !== 'crystalize' || orb.crystalTarget || orb.crystalUsed) continue;
        orb.crystalTimer++;
        if (orb.crystalTimer < CRYSTAL_CHECK_INTERVAL) continue;
        orb.crystalTimer = 0;
        if (Math.random() > CRYSTAL_CHANCE) continue;
        const candidates = orbs.filter(o =>
            o !== orb && o.alive && !o.dying && !o.splitting && !o.spawning &&
            o.effect !== 'crystalize' && !o.crystallized
        );
        if (candidates.length === 0) continue;
        const target = candidates[Math.floor(Math.random() * candidates.length)];
        orb.crystalTarget = target;
        target.crystallized = true;
        target.crystallizedBy = orb;
        target.crystalVerts = generateCrystalVerts();
        orb.crystalPulse = 1;
        window.onCrystalizeHappened?.();
    }

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
            if ((a.crystallized && a.crystallizedBy === b) || (b.crystallized && b.crystallizedBy === a)) continue;
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
    // Crystal pull: victim pulled toward crystalize orb
    for (const orb of aliveOrbs) {
        if (!orb.crystallized || !orb.crystallizedBy || !orb.crystallizedBy.alive) continue;
        const src = orb.crystallizedBy;
        const dx = src.x - orb.x, dy = src.y - orb.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        const minDist = ORB_RADIUS * 2.5;
        if (d > minDist) {
            orb.vx += (dx / d) * CRYSTAL_PULL_STRENGTH;
            orb.vy += (dy / d) * CRYSTAL_PULL_STRENGTH;
        } else if (d > 0.1 && d < minDist) {
            const push = (minDist - d) / minDist * 0.5;
            orb.vx -= (dx / d) * push;
            orb.vy -= (dy / d) * push;
            src.vx += (dx / d) * push;
            src.vy += (dy / d) * push;
        }
    }
    // Crystal shell repels other orbs (stronger than normal)
    for (const a of aliveOrbs) {
        if (!a.crystallized) continue;
        for (const b of aliveOrbs) {
            if (b === a || b === a.crystallizedBy) continue;
            const dx = b.x - a.x, dy = b.y - a.y;
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d < CRYSTAL_REPEL_DIST && d > 0.1) {
                const f = (CRYSTAL_REPEL_DIST - d) / CRYSTAL_REPEL_DIST * CRYSTAL_REPEL_STR;
                b.vx += (dx / d) * f;
                b.vy += (dy / d) * f;
            }
        }
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
                if (!orb.alive || orb.dying || orb === p.skipOrb || orb.crystallized) continue;
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
        // Crystal shell repels free particles
        for (const orb of orbs) {
            if (!orb.alive || !orb.crystallized) continue;
            const dx = p.x - orb.x, dy = p.y - orb.y;
            const d2 = dx * dx + dy * dy;
            const d = Math.sqrt(d2);
            if (d < CRYSTAL_PARTICLE_REPEL_DIST && d > 1) {
                const force = CRYSTAL_PARTICLE_REPEL_STR / d2;
                p.vx += (dx / d) * force;
                p.vy += (dy / d) * force;
            }
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
                if (!orb.alive || orb.dying || orb === p.skipOrb || orb.crystallized) continue;
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

    // --- Worm cooldown ---
    if (wormCooldown > 0) wormCooldown--;

    // --- Worm update ---
    if (worm && worm.alive) {
        worm.age++;

        const head = worm.segments[0];

        // After 5s, aim for the nearest screen edge to exit
        if (worm.age >= WORM_EXIT_AFTER) {
            const toLeft = head.x, toRight = cW - head.x;
            const toTop = head.y, toBottom = cH - head.y;
            const min = Math.min(toLeft, toRight, toTop, toBottom);
            if (min === toLeft) { worm.targetX = -80; worm.targetY = head.y; }
            else if (min === toRight) { worm.targetX = cW + 80; worm.targetY = head.y; }
            else if (min === toTop) { worm.targetX = head.x; worm.targetY = -80; }
            else { worm.targetX = head.x; worm.targetY = cH + 80; }
        } else if (dist(head, { x: worm.targetX, y: worm.targetY }) < 40 || worm.age % 120 === 0) {
            // Normal wandering: re-pick target when close or periodically
            const t = pickWormTarget();
            worm.targetX = t.x;
            worm.targetY = t.y;
        }

        // Desired angle toward target
        const desiredAngle = Math.atan2(worm.targetY - head.y, worm.targetX - head.x);

        // Soft avoidance from orb centers (only prevents direct collision)
        let avoidX = 0, avoidY = 0;
        for (const orb of orbs) {
            if (!orb.alive) continue;
            const d = dist(head, orb);
            if (d < WORM_AVOID_RADIUS && d > 1) {
                const strength = (WORM_AVOID_RADIUS - d) / WORM_AVOID_RADIUS;
                avoidX += ((head.x - orb.x) / d) * strength;
                avoidY += ((head.y - orb.y) / d) * strength;
            }
        }
        if (blackHole) {
            const d = dist(head, blackHole);
            if (d < WORM_AVOID_RADIUS && d > 1) {
                const strength = (WORM_AVOID_RADIUS - d) / WORM_AVOID_RADIUS;
                avoidX += ((head.x - blackHole.x) / d) * strength;
                avoidY += ((head.y - blackHole.y) / d) * strength;
            }
        }

        // Blend target direction with avoidance
        const avoidLen = Math.sqrt(avoidX * avoidX + avoidY * avoidY);
        let finalAngle;
        if (avoidLen > 0.01) {
            const avoidAngle = Math.atan2(avoidY, avoidX);
            const weight = Math.min(avoidLen * 2, 0.7);
            finalAngle = desiredAngle + angleDiff(desiredAngle, avoidAngle) * weight;
        } else {
            finalAngle = desiredAngle;
        }

        // Turn rate limit
        const diff = angleDiff(worm.headAngle, finalAngle);
        worm.headAngle += Math.sign(diff) * Math.min(Math.abs(diff), WORM_TURN_RATE);

        // Move head
        head.x += Math.cos(worm.headAngle) * WORM_SPEED;
        head.y += Math.sin(worm.headAngle) * WORM_SPEED;

        // Body follow
        for (let i = 1; i < worm.segments.length; i++) {
            const prev = worm.segments[i - 1];
            const seg = worm.segments[i];
            const sdx = prev.x - seg.x, sdy = prev.y - seg.y;
            const sd = Math.sqrt(sdx * sdx + sdy * sdy);
            if (sd > SEGMENT_SPACING) {
                seg.x = prev.x - (sdx / sd) * SEGMENT_SPACING;
                seg.y = prev.y - (sdy / sd) * SEGMENT_SPACING;
            }
        }

        // Check if fully off-screen (all segments outside canvas)
        const margin = PARTICLE_RADIUS * 2;
        const allOff = worm.segments.every(s =>
            s.x < -margin || s.x > cW + margin || s.y < -margin || s.y > cH + margin
        );
        if (allOff && worm.age > 60) {
            worm = null;
            wormCooldown = 300;
        }

        // Collision with free particles
        if (worm) {
            let hit = false;
            for (const p of freeParticles) {
                for (const seg of worm.segments) {
                    if (dist(p, seg) < PARTICLE_RADIUS * 2.5) { hit = true; break; }
                }
                if (hit) break;
                for (let i = 0; i < worm.segments.length - 1; i++) {
                    if (pointToSegmentDist(p, worm.segments[i], worm.segments[i + 1]) < PARTICLE_RADIUS + 2) {
                        hit = true; break;
                    }
                }
                if (hit) break;
            }
            if (hit) explodeWorm();
        }
    }

    // --- Worm spawn (after turn settles) ---
    if (!wormSpawnChecked && !worm && wormCooldown === 0) {
        const settled = freeParticles.length === 0
            && !orbs.some(o => o.alive && (o.dying || o.splitting || o.spawning));
        if (settled) {
            wormSpawnChecked = true;
            const currentLevel = Math.floor(score / LEVEL_SIZE) + 1;
            if (currentLevel >= 5 && Math.random() < 0.15) {
                // Show tutorial first, then spawn after 2s
                window.onWormIncoming?.();
            }
        }
    }

    // --- Deadlock: wait for particles to settle, then 5s timer ---
    if (deadlockPending) {
        const settled = freeParticles.length === 0
            && !orbs.some(o => o.alive && (o.dying || o.splitting || o.spawning));
        if (settled && isDeadlocked()) {
            deadlockTimer++;
            if (deadlockTimer >= 300) {  // 5 seconds at 60fps
                deadlockPending = false;
                deadlockTimer = 0;
                window.onGameOver?.();
            }
        } else {
            // Conditions no longer met — reset
            deadlockPending = false;
            deadlockTimer = 0;
        }
    }
}

// --- Draw ---
function drawOrb(orb) {
    // Crystalize orb: expanding pink ring when it captures a target
    if (orb.crystalPulse > 0) {
        const cp = orb.crystalPulse;
        const ringR = ORB_RADIUS * (1 + (1 - cp) * 1.6);
        ctx.save();
        ctx.shadowBlur = 22 * cp; ctx.shadowColor = 'rgba(255,100,200,0.9)';
        ctx.strokeStyle = `rgba(255,130,200,${cp * 0.85})`;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(orb.x, orb.y, ringR, 0, TAU); ctx.stroke();
        ctx.restore();
    }

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

        } else if (orb.effect === 'crystalize') {
            // Diamond/crystal shape
            ctx.save();
            ctx.translate(ix, iy);
            // Top pentagon
            ctx.beginPath();
            ctx.moveTo(0, -9);
            ctx.lineTo(-6, -3);
            ctx.lineTo(-4, 3);
            ctx.lineTo(4, 3);
            ctx.lineTo(6, -3);
            ctx.closePath();
            ctx.strokeStyle = 'rgba(255,160,220,0.8)';
            ctx.stroke();
            // Inner facets
            ctx.beginPath(); ctx.moveTo(-6, -3); ctx.lineTo(0, 5); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(6, -3); ctx.lineTo(0, 5); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(0, -9); ctx.lineTo(0, 5); ctx.stroke();
            // Bottom point
            ctx.beginPath();
            ctx.moveTo(-4, 3); ctx.lineTo(0, 8); ctx.lineTo(4, 3);
            ctx.stroke();
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
        drawParticleTexture(ctx, dotX, dotY, 3, c);
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

    drawParticleTexture(ctx, x, y, PARTICLE_RADIUS, color);
    ctx.restore();
}

function drawParticleTexture(c, x, y, radius, color) {
    const ci = PARTICLE_COLORS.indexOf(color);
    if (ci < 0) return;
    c.save();
    c.shadowBlur = 0;
    c.strokeStyle = 'rgba(0,0,0,0.35)';
    c.fillStyle = 'rgba(0,0,0,0.35)';
    c.lineWidth = 1;
    const r = radius * 0.55;
    switch (ci) {
        case 0: // cross +
            c.beginPath(); c.moveTo(x - r, y); c.lineTo(x + r, y); c.stroke();
            c.beginPath(); c.moveTo(x, y - r); c.lineTo(x, y + r); c.stroke();
            break;
        case 1: // diamond
            c.beginPath(); c.moveTo(x, y - r); c.lineTo(x + r, y); c.lineTo(x, y + r); c.lineTo(x - r, y); c.closePath(); c.stroke();
            break;
        case 2: // horizontal line
            c.beginPath(); c.moveTo(x - r, y); c.lineTo(x + r, y); c.stroke();
            break;
        case 3: // triangle
            c.beginPath(); c.moveTo(x, y - r); c.lineTo(x + r, y + r * 0.7); c.lineTo(x - r, y + r * 0.7); c.closePath(); c.stroke();
            break;
        case 4: // X
            c.beginPath(); c.moveTo(x - r, y - r); c.lineTo(x + r, y + r); c.stroke();
            c.beginPath(); c.moveTo(x + r, y - r); c.lineTo(x - r, y + r); c.stroke();
            break;
        case 5: // dot
            c.beginPath(); c.arc(x, y, r * 0.45, 0, TAU); c.fill();
            break;
    }
    c.restore();
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

function drawWorm(w) {
    ctx.save();
    ctx.globalAlpha = w.spawnAlpha;

    // Connecting white lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.lineWidth = 2;
    ctx.shadowBlur = 8;
    ctx.shadowColor = 'rgba(255, 255, 255, 0.3)';
    ctx.beginPath();
    ctx.moveTo(w.segments[0].x, w.segments[0].y);
    for (let i = 1; i < w.segments.length; i++) {
        ctx.lineTo(w.segments[i].x, w.segments[i].y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Segment dots
    for (const seg of w.segments) {
        drawParticle(seg.x, seg.y, seg.color);
    }

    // Head indicator
    const head = w.segments[0];
    ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
    ctx.beginPath();
    ctx.arc(head.x, head.y, 2.5, 0, TAU);
    ctx.fill();

    ctx.restore();
}

function drawCrystalOverlay(orb) {
    ctx.save();
    ctx.translate(orb.x, orb.y);
    for (const tri of orb.crystalVerts) {
        ctx.beginPath();
        ctx.moveTo(tri.x1, tri.y1);
        ctx.lineTo(tri.x2, tri.y2);
        ctx.lineTo(tri.x3, tri.y3);
        ctx.closePath();
        ctx.fillStyle = `rgba(255, ${tri.shade}, 200, ${tri.alpha})`;
        ctx.fill();
    }
    ctx.restore();
}

function drawCrystalBeams() {
    for (const orb of orbs) {
        if (!orb.alive || orb.effect !== 'crystalize' || !orb.crystalTarget) continue;
        const target = orb.crystalTarget;
        if (!target.alive) continue;
        ctx.save();
        const grad = ctx.createLinearGradient(orb.x, orb.y, target.x, target.y);
        grad.addColorStop(0, 'rgba(255, 100, 200, 0.6)');
        grad.addColorStop(0.5, 'rgba(255, 140, 220, 0.4)');
        grad.addColorStop(1, 'rgba(255, 100, 200, 0.6)');
        ctx.strokeStyle = grad;
        ctx.lineWidth = 2;
        ctx.shadowBlur = 12;
        ctx.shadowColor = 'rgba(255, 100, 200, 0.5)';
        ctx.beginPath();
        ctx.moveTo(orb.x, orb.y);
        ctx.lineTo(target.x, target.y);
        ctx.stroke();
        // Animated energy dot along beam
        const beamT = (performance.now() % 1500) / 1500;
        const bx = orb.x + (target.x - orb.x) * beamT;
        const by = orb.y + (target.y - orb.y) * beamT;
        ctx.fillStyle = 'rgba(255, 180, 240, 0.7)';
        ctx.beginPath();
        ctx.arc(bx, by, 2.5, 0, TAU);
        ctx.fill();
        ctx.restore();
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

    const isLocked = drag.orb.crystallized || drag.orb.overloadPhase || ((drag.orb.effect === 'blip' || drag.orb.effect === 'crystalize') && !isRecipeFulfilled(drag.orb));
    const lockColor = drag.orb.crystallized ? [255, 130, 200] : [255, 80, 80];
    const lineColor  = isLocked ? `rgba(${lockColor},0.7)`  : 'rgba(255, 255, 255, 0.55)';
    const arrowColor = isLocked ? `rgba(${lockColor},0.85)` : 'rgba(255, 255, 255, 0.75)';

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
            if (orb.crystallized && orb.crystalVerts) {
                drawCrystalOverlay(orb);
            }
        }
        ctx.restore();
    }
    drawCrystalBeams();
    if (blackHole) drawBlackHole(blackHole);
    if (worm && worm.alive) drawWorm(worm);

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
        drawParticleTexture(ctx, d.x, d.y, d.r, d.color);
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
