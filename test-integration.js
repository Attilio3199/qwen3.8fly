// End-to-end protocol test: full combat flow, team mode, late join.
// Usage: node test-integration.js
const URL = process.env.TEST_URL || 'ws://localhost:3000';
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) { pass++; console.log('  PASS', msg); } else { fail++; console.log('  FAIL', msg); } };

class C {
  constructor(name) {
    this.name = name;
    this.msgs = [];
    this.ws = new WebSocket(URL);
    this.ws.onmessage = (e) => { this.msgs.push(JSON.parse(e.data)); };
  }
  wait(type, n = 2500, filter) {
    return new Promise((res) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const m = this.msgs.find((x) => x.t === type && (!filter || filter(x)));
        if (m || Date.now() - t0 > n) { clearInterval(iv); res(m || null); }
      }, 50);
    });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  close() { try { this.ws.close(); } catch {} }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const A = new C('Alpha');
  await new Promise((r) => { A.ws.onopen = r; });
  A.send({ t: 'join', name: 'Alpha', plane: 'fighter', weapons: ['cannon','cannon','rocket'], ability: {} });
  const helloA = await A.wait('hello');
  ok(!!helloA && helloA.id, `A receives hello with id ${helloA && helloA.id}`);
  const AID = helloA.id;

  const B = new C('Bravo');
  await new Promise((r) => { B.ws.onopen = r; });
  B.send({ t: 'join', name: 'Bravo', plane: 'interceptor', weapons: ['cannon','cannon','cannon'], ability: {}, start: true, mode: 'team' });
  const helloB = await B.wait('hello');
  ok(!!helloB && helloB.players.length === 2, 'B receives hello with 2-player roster');
  ok(helloB.phase === 'lobby', 'B in lobby before start');
  const BID = helloB.id;

  const stA = await A.wait('state');
  ok(!!stA && stA.phase === 'combat' && stA.match === 'team', `A: combat state with requested mode (match=${stA && stA.match})`);
  ok(Array.isArray(stA.players) && stA.players.some((p) => p.id === AID && p.team === 1) && stA.players.some((p) => p.id === BID && p.team === 2),
     `Team assignment: A=${(stA.players.find(p=>p.id===AID)||{}).team}, B=${(stA.players.find(p=>p.id===BID)||{}).team}`);
  const rpA = await A.wait('respawn');
  const rpB = await B.wait('respawn');
  ok(!!rpA && Array.isArray(rpA.p) && !!rpB && Array.isArray(rpB.p), 'Both receive respawn positions');
  const timeMsg = await A.wait('time', 3000);
  ok(!!timeMsg && Number.isFinite(timeMsg.tod), 'A receives time-of-day broadcast');

  // position relay
  A.send({ t: 'input', p: [100, 200, 300], q: [0, 0, 0, 1], v: [10, 0, 0], th: 0.8, h: 100 });
  await sleep(160);
  const stB = await B.wait('st', 2500, (x) => x.n === AID && x.p[0] === 100);
  ok(!!stB && stB.p[0] === 100, 'B receives A position snapshot (x=100)');

  // combat: A on top of B fires sustained burst -> kill
  const bP = rpB.p;
  A.send({ t: 'input', p: bP, q: [0, 0, 0, 1], v: [0, 0, 0], th: 0.5, h: 100 });
  await sleep(120);
  const tFire = Date.now();
  while (Date.now() - tFire < 8000) {
    A.send({ t: 'fire', slot: 0, w: 'cannon', tgt: bP, n: [0, 0, -1], s: bP });
    await sleep(260);
    if (B.msgs.some((x) => x.t === 'kill')) break;
  }
  const hitB = B.msgs.find((x) => x.t === 'hit' && x.d < 100 && !x.healed && x.d >= 0);
  ok(!!hitB, `B receives damage (hp=${hitB && hitB.d})`);
  const boomB = B.msgs.find((x) => x.t === 'boom');
  ok(!!boomB && Array.isArray(boomB.tgt), 'B receives explosion broadcast');
  const killB = B.msgs.find((x) => x.t === 'kill');
  ok(!!killB && killB.by === AID && killB.victim === BID, `Kill: ${AID} -> ${BID} (score=${JSON.stringify(killB && killB.score)})`);
  ok(killB && killB.byScore === killB.score.p1, 'Kill carries killer score (byScore matches team score)');
  ok(killB && Array.isArray(killB.players) && killB.players.some((p) => p.id === AID && p.score > 0), 'Kill carries players summary with updated scores');
  const killA = await A.wait('kill', 2000, (x) => x.by === AID);
  ok(!!killA, 'A receives own kill confirmation');
  const killIdx = B.msgs.findIndex((x) => x.t === 'kill');
  const rp2 = await B.wait('respawn', 8000, (x) => B.msgs.indexOf(x) > killIdx);
  ok(!!rp2, 'B respawns after kill');

  // late join mid-combat
  const Cc = new C('Charlie');
  await new Promise((r) => { Cc.ws.onopen = r; });
  Cc.send({ t: 'join', name: 'Charlie', plane: 'bomber', weapons: ['rocket','rocket','bomb'], ability: {} });
  const helloC = await Cc.wait('hello');
  ok(!!helloC && helloC.phase === 'combat', 'C (late join) gets hello with combat phase');
  const rpC = await Cc.wait('respawn', 3000);
  ok(!!rpC && Array.isArray(rpC.p), 'C (late join) receives respawn position');
  const stC = await A.wait('st', 3000, (x) => x.n === helloC.id);
  ok(!!stC, 'A receives C position snapshot after C sends input');
  Cc.send({ t: 'input', p: [50, 60, 70], q: [0,0,0,1], v: [0,0,0], th: 0.5, h: 165 });

  A.close(); B.close(); Cc.close();
  await sleep(300);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(1); });
