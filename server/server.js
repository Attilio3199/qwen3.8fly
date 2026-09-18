#!/usr/bin/env node
/**
 * Air Combat — authoritative game server (Node.js + ws, zero other deps)
 *
 * Protocol (JSON over WebSocket):
 *   client -> server:  {t:'join', name, plane, weapons, ability}
 *                      {t:'input', p:[x,y,z], q:[x,y,z,w], v:[x,y,z], th, h}
 *                      {t:'fire', slot, t:[x,y,z], n:[x,y,z], s:[x,y,z], p:[x,y,z]}
 *                      {t:'boom', t:[x,y,z], s:[x,y,z], p:[x,y,z]}
 *                      {t:'heal', p:[x,y,z]}
 *                      {t:'leave'}
 *   server -> client:  {t:'hello', id, name, players}
 *                      {t:'join', id} / {t:'leave', id}
 *                      {t:'st',  ts, n:0, p:[x,y,z], q:[x,y,z,w], v:[x,y,z]}
 *                      {t:'hit', p, d, h}
 *                      {t:'boom', t:[x,y,z], by}
 *                      {t:'kill', by, victim, score}
 *                      {t:'respawn', p:[x,y,z]}
 *                      {t:'heal', p:[x,y,z]}
 *                      {t:'time', tod}
 *                      {t:'state', phase, score, timeLeft}
 */
'use strict';

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
const WORLD_R = 4200;          // world radius (soft boundary)
const MAX_H = 5200;            // max altitude
const TAU = Math.PI * 2;

// ---------------------------------------------------------------- constants
const PLANE_SPECS = {
  fighter: {
    label: 'Falcon — balanced fighter',
    maxSpeed: 150, minSpeed: 32, turnRate: 2.1,
    hp: 100, reload: 0.24, dmg: 9,  projSpeed: 340, spread: 0.010, mag: 14,
    cam: 'chase',
    desc: 'All-round dogfighter. 2x cannon, rockets, afterburner.',
    weapons: ['cannon', 'cannon', 'rocket'],
    ability: { name: 'Afterburner', cd: 10, desc: 'Boost speed +35% for 3s' },
  },
  interceptor: {
    label: 'Viper — speed interceptor',
    maxSpeed: 172, minSpeed: 36, turnRate: 1.55,
    hp: 85, reload: 0.16, dmg: 6,  projSpeed: 420, spread: 0.008, mag: 16,
    cam: 'chase',
    desc: 'Blisteringly fast, weakly armed. 3x autocannon, flares, repair kit.',
    weapons: ['cannon', 'cannon', 'cannon'],
    ability: { name: 'Flare Burst', cd: 9, desc: '3 smoke flares that mask you' },
  },
  bomber: {
    label: 'Havoc — heavy bomber',
    maxSpeed: 108, minSpeed: 26, turnRate: 1.15,
    hp: 165, reload: 1.4, dmg: 34, projSpeed: 90, spread: 0.012, mag: 4,
    cam: 'chase',
    desc: 'Slow but a tank. 2x heavy missiles, 1x bomb, repair ability.',
    weapons: ['rocket', 'rocket', 'bomb'],
    ability: { name: 'Field Repair', cd: 16, desc: 'Restore 45 HP' },
  },
};

const SCORES = { deathmatch: { kill: 100, assist: 0, streak: 10 }, team: { kill: 100, assist: 25, streak: 10 } };
const TEAM_GOAL = 500;
const MATCH_MIN = 5;           // minutes
const MATCH_EXTRA = 2;         // sudden-death extension

// ---------------------------------------------------------------- helpers
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function norm3(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
function dist2(ax, ay, az, bx, by, bz) {
  const dx = ax - bx, dy = ay - by, dz = az - bz;
  return dx * dx + dy * dy + dz * dz;
}

// ---------------------------------------------------------------- game state
const S = {
  phase: 'lobby',
  match: 'deathmatch',
  tod: 0.30,                 // 0..1, 0.3 ≈ midday
  timeLeft: 0,
  score: { p1: 0, p2: 0 },
  players: new Map(),        // id -> player
  nextId: 1,
  started: false,
};

const BOUND = { x0: -WORLD_R, x1: WORLD_R, y0: 0, y1: MAX_H, z0: -WORLD_R, z1: WORLD_R };

function makeSpawn(team) {
  const ang = rnd(0, TAU);
  const r = rnd(600, 2200);
  return {
    p: [Math.cos(ang) * r, rnd(350, 700), Math.sin(ang) * r],
    q: [0, Math.cos(ang + Math.PI), 0, -Math.sin(ang + Math.PI)], // yaw facing outward-ish
  };
}

function newPlayer(ws, id, name, plane, weapons, ability) {
  const spec = PLANE_SPECS[plane] || PLANE_SPECS.fighter;
  const spawn = makeSpawn(1);
  return {
    id, ws,
    name: String(name || 'Pilot').slice(0, 16),
    plane, spec,
    weapons: Array.isArray(weapons) && weapons.length === 3 ? weapons : [...spec.weapons],
    ability,
    team: 1,
    p: spawn.p.slice(), q: spawn.q.slice(), v: [0, 0, 0],
    hp: spec.hp, alive: true,
    throttle: 0.7,
    lastSeen: Date.now(),
    kills: 0, deaths: 0, streak: 0, score: 0,
    lastHitAt: 0, lastHitBy: null,
    respawnAt: 0,
    // server-side ability state
    abilityAt: 0,
  };
}

function broadcast(obj, exceptId) {
  const data = JSON.stringify(obj);
  for (const pl of S.players.values()) {
    if (pl.id === exceptId || pl.ws.readyState !== 1) continue;
    try { pl.ws.send(data); } catch (_) { /* drop */ }
  }
}

function sendTo(pl, obj) {
  if (pl.ws.readyState === 1) { try { pl.ws.send(JSON.stringify(obj)); } catch (_) {} }
}

// ---------------------------------------------------------------- match flow
function playersSummary() {
  return [...S.players.values()].map((o) => ({ id: o.id, name: o.name, team: o.team, score: o.score }));
}

function startMatch(mode) {
  const players = [...S.players.values()];
  if (players.length === 0) return;

  S.match = (mode === 'team' || mode === 'deathmatch')
    ? mode
    : (players.length >= 2 && Math.random() < 0.5 ? 'team' : 'deathmatch');
  // team assignment: alternate
  let t = 1;
  for (const pl of players) {
    pl.team = S.match === 'team' ? t++ : 1;
    if (t > 2) t = 1;
  }
  for (const pl of players) {
    const spawn = makeSpawn(pl.team);
    pl.p = spawn.p; pl.q = spawn.q; pl.v = [0, 0, 0];
    pl.hp = pl.spec.hp; pl.alive = true; pl.streak = 0; pl.score = 0;
  }
  S.score = { p1: 0, p2: 0 };
  S.timeLeft = MATCH_MIN * 60;
  S.phase = 'combat';
  S.started = true;
  broadcast({ t: 'state', phase: 'combat', match: S.match, score: S.score, timeLeft: S.timeLeft, players: playersSummary() });
  broadcast({ t: 'time', tod: S.tod });
  for (const pl of players) sendTo(pl, { t: 'respawn', p: pl.p });
}

function endMatch() {
  S.phase = 'finished';
  let winner = null;
  if (S.match === 'team') winner = S.score.p1 > S.score.p2 ? 1 : S.score.p2 > S.score.p1 ? 2 : 0;
  else {
    const byScore = [...S.players.values()].sort((a, b) => b.score - a.score);
    winner = byScore[0] ? byScore[0].id : null;
  }
  broadcast({ t: 'state', phase: 'finished', match: S.match, score: S.score, timeLeft: 0, winner, players: playersSummary() });
}

// ---------------------------------------------------------------- combat
function fireWeapon(pl, slot, target, normDir, startP) {
  const w = pl.weapons[slot];
  if (!w) { console.log(`[fire] dropped: no weapon slot ${slot} for`, pl.name, pl.weapons); return; }
  const spec = pl.spec;
  const now = Date.now();
  if (now < pl.lastFire) return;
  pl.lastFire = now + spec.reload * 1000;

  const dir = normDir.slice();
  const [dx, dy, dz] = dir;
  dir[0] += rnd(-1, 1) * spec.spread;
  dir[1] += rnd(-1, 1) * spec.spread;
  dir[2] += rnd(-1, 1) * spec.spread;
  const d = norm3(dir);

  broadcast({ t: 'fire', id: pl.id, slot, w, tgt: target, n: d, s: startP }, null);
  // (fire is visible to everyone incl. shooter; shooter also plays local fx)

  // Immediate hit check at spawn (point-blank)
  for (const other of S.players.values()) {
    if (other === pl || !other.alive) continue;
    const rr = 6.5;
    if (dist2(pl.p[0], pl.p[1], pl.p[2], other.p[0], other.p[1], other.p[2]) < rr * rr) {
      damage(other, spec.dmg, pl, w);
    }
  }
}

function damage(victim, dmg, by, weapon) {
  if (!victim.alive) return;
  victim.hp -= dmg;
  const now = Date.now();
  victim.lastHitAt = now;
  victim.lastHitBy = by ? by.id : null;
  sendTo(victim, { t: 'hit', p: dmg, d: Math.round(victim.hp), h: (now % 60000) * 10 });
  if (victim.hp <= 0) kill(victim, by, weapon);
}

function kill(victim, by, weapon) {
  victim.hp = 0;
  victim.alive = false;
  victim.deaths++;
  victim.respawnAt = Date.now() + 2500;
  broadcast({ t: 'boom', tgt: victim.p, by: by ? by.id : null });
  if (by && by !== victim) {
    by.kills++;
    by.streak++;
    const sc = SCORES[S.match] || SCORES.deathmatch;
    let pts = sc.kill + by.streak * sc.streak;
    if (S.match === 'team' && by.team !== victim.team) {
      S.score[by.team === 1 ? 'p1' : 'p2'] += pts;
      // team-mate assists: any other alive team-mate within 1200m of kill
      for (const m of S.players.values()) {
        if (m !== by && m.team === by.team && m.alive &&
            dist2(m.p[0], m.p[1], m.p[2], victim.p[0], victim.p[1], victim.p[2]) < 1200 * 1200) {
          const ap = sc.assist;
          m.score += ap;
          S.score[m.team === 1 ? 'p1' : 'p2'] += ap;
          sendTo(m, { t: 'hit', p: 0, d: -1, h: 1, assist: by.id });
        }
      }
    }
    by.score += pts;
    broadcast({ t: 'kill', by: by.id, victim: victim.id, score: S.score, streak: by.streak, byScore: by.score, players: playersSummary() });
    if (S.match === 'team' && (S.score.p1 >= TEAM_GOAL || S.score.p2 >= TEAM_GOAL)) endMatch();
  } else {
    broadcast({ t: 'kill', by: null, victim: victim.id, score: S.score, streak: 0, players: playersSummary() });
  }
}

// ---------------------------------------------------------------- input loop
const TICK = 50; // ms
let lastTick = Date.now();

function serverTick() {
  const now = Date.now();
  const dt = (now - lastTick) / 1000;
  lastTick = now;

  if (S.phase !== 'lobby') {
    S.timeLeft -= dt;
    if (S.timeLeft <= 0) {
      if (S.match === 'team' && S.score.p1 < TEAM_GOAL && S.score.p2 < TEAM_GOAL) {
        S.timeLeft = MATCH_EXTRA * 60; // sudden death extension
        broadcast({ t: 'state', phase: 'combat', match: S.match, score: S.score, timeLeft: S.timeLeft });
      } else {
        endMatch();
      }
    }
  }

  // time of day drift: full cycle ~ 8 min
  S.tod = (S.tod + dt / (8 * 60)) % 1;

  // lag compensation: last known input, re-broadcast to others
  for (const pl of S.players.values()) {
    if (pl.alive && pl.lastSeen && now - pl.lastSeen < 5000) {
      broadcast({ t: 'st', ts: pl.lastSeen, n: pl.id, p: pl.p, q: pl.q, v: pl.v, h: pl.hp }, pl.id);
    }
    // respawn
    if (!pl.alive && now >= pl.respawnAt) {
      const spawn = makeSpawn(pl.team);
      pl.p = spawn.p; pl.q = spawn.q; pl.v = [0, 0, 0];
      pl.hp = pl.spec.hp; pl.alive = true;
      pl.lastHitAt = 0; pl.lastHitBy = null;
      sendTo(pl, { t: 'respawn', p: pl.p });
      broadcast({ t: 'join', id: pl.id }, pl.id);
    }
    // idle reaper
    if (now - pl.lastSeen > 15000) removePlayer(pl, true);
  }

  // periodic time broadcast (cheap: 1/sec)
  if (Math.floor(now / 1000) !== Math.floor((now - TICK) / 1000)) {
    broadcast({ t: 'time', tod: Number(S.tod.toFixed(4)) });
  }
}

function removePlayer(pl, silent) {
  S.players.delete(pl.id);
  try { pl.ws.close(); } catch (_) {}
  if (!silent) broadcast({ t: 'leave', id: pl.id });
  if (S.phase !== 'lobby' && S.players.size === 0) {
    S.phase = 'lobby';
    S.started = false;
    broadcast({ t: 'state', phase: 'lobby', match: S.match, score: S.score, timeLeft: 0, players: [] });
  }
}

// ---------------------------------------------------------------- http + ws
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, phase: S.phase, players: S.players.size }));
    return;
  }
  res.writeHead(404); res.end('air-combat server');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch (_) { return; }
    handleMsg(ws, m);
  });
  ws.on('close', () => {
    const pl = [...S.players.values()].find((p) => p.ws === ws);
    if (pl) removePlayer(pl, false);
  });
});

function handleMsg(ws, m) {
  let pl = [...S.players.values()].find((p) => p.ws === ws);
  console.log(`[msg] t=${m.t} player=${pl ? pl.name : 'none'}`);

  switch (m.t) {
    case 'join': {
      if (pl) { updateProfile(pl, m); break; }
      const id = S.nextId++;
      pl = newPlayer(ws, id, m.name, m.plane, m.weapons, m.ability);
      S.players.set(id, pl);
      // sync roster to newcomer
      const roster = [...S.players.values()].map((o) => ({
        id: o.id, name: o.name, plane: o.plane, team: o.team, score: o.score,
        kills: o.kills, deaths: o.deaths, p: o.p, q: o.q, h: o.hp,
      }));
      sendTo(pl, { t: 'hello', id, name: pl.name, players: roster, tod: S.tod, phase: S.phase, match: S.match, score: S.score, timeLeft: S.timeLeft });
      broadcast({ t: 'join', id }, pl.id);
      // late join mid-combat: drop them in at a fresh spawn
      if (S.phase === 'combat') {
        const sp = makeSpawn(pl.team);
        pl.p = sp.p; pl.q = sp.q; pl.v = [0, 0, 0];
        pl.hp = pl.spec.hp; pl.alive = true;
        sendTo(pl, { t: 'respawn', p: sp.p });
      }
      if (m.start && S.phase === 'lobby') startMatch(m.mode);
      console.log(`[join] ${pl.name} (plane=${pl.plane}) — ${S.players.size} online`);
      break;
    }
    case 'input': {
      if (!pl || !pl.alive) return;
      if (Array.isArray(m.p) && m.p.length === 3 && Number.isFinite(m.p[0])) pl.p = m.p.map(Number);
      if (Array.isArray(m.q) && m.q.length === 4 && Number.isFinite(m.q[0])) pl.q = m.q.map(Number);
      if (Array.isArray(m.v) && m.v.length === 3) pl.v = m.v.map(Number);
      if (Number.isFinite(m.th)) pl.throttle = clamp(m.th, 0, 1.2);
      if (Number.isFinite(m.h)) pl.hp = clamp(m.h, 0, pl.spec.hp);
      pl.lastSeen = Date.now();
      break;
    }
    case 'fire': {
      if (!pl || !pl.alive) { console.log('[fire] dropped: no player or not alive'); return; }
      pl.lastSeen = Date.now();
      // trust client position for spawn; validate target direction
      if (Array.isArray(m.n) && m.n.length === 3) {
        fireWeapon(pl, m.slot | 0, m.tgt, m.n, m.s || pl.p);
      } else { console.log('[fire] dropped: bad dir', JSON.stringify(m.n)); }
      break;
    }
    case 'boom': {
      if (!pl) return;
      // ability explosion / visual only
      break;
    }
    case 'heal': {
      if (!pl || !pl.alive) return;
      const spec = pl.spec;
      if (spec.ability.name === 'Field Repair') {
        const now = Date.now();
        if (now - (pl.abilityAt || 0) > spec.ability.cd * 1000 && pl.hp < spec.hp) {
          pl.abilityAt = now;
          pl.hp = clamp(pl.hp + 45, 0, spec.hp);
          broadcast({ t: 'heal', p: pl.p }, pl.id);
          sendTo(pl, { t: 'hit', p: 0, d: Math.round(pl.hp), h: 0, healed: true });
        }
      }
      break;
    }
    case 'leave': {
      if (pl) removePlayer(pl, false);
      break;
    }
  }
}

function updateProfile(pl, m) {
  if (m.name) pl.name = String(m.name).slice(0, 16);
  if (m.plane && PLANE_SPECS[m.plane]) {
    pl.plane = m.plane;
    pl.spec = PLANE_SPECS[m.plane];
    pl.hp = pl.spec.hp;
  }
  if (Array.isArray(m.weapons) && m.weapons.length === 3) pl.weapons = m.weapons;
  if (m.ability) pl.ability = m.ability;
  broadcast({ t: 'join', id: pl.id }, pl.id);
}

// ---------------------------------------------------------------- housekeeping
setInterval(serverTick, TICK);
setInterval(() => {
  let dead = 0;
  for (const c of wss.clients) {
    if (!c.isAlive) { dead++; c.terminate(); continue; }
    c.isAlive = false;
    try { c.ping(); } catch (_) {}
  }
  if (dead) console.log(`[ping] terminated ${dead} dead sockets`);
}, 20000);

server.listen(PORT, () => {
  console.log(`✈  Air Combat server listening on ws://localhost:${PORT}`);
  console.log(`   health: http://localhost:${PORT}/health`);
});
