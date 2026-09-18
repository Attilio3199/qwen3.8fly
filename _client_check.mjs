
import * as THREE from 'three';

/* ================================================================
   CONSTANTS & PLANE SPECS (client mirror of server)
================================================================ */
const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') +
  (new URLSearchParams(location.search).get('ws') || 'localhost:3001');
const WORLD_R = 4200, MAX_H = 5200;
const TAU = Math.PI * 2;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);

const PLANE_SPECS = {
  fighter: {
    label: 'Falcon', icon: '🛩️', color: 0x3a6ea5,
    maxSpeed: 150, minSpeed: 30, stall: 34,
    engineForce: 30000, mass: 2200,
    hp: 100,
    ability: { name: 'Afterburner', cd: 10, dur: 3 },
    desc: 'Balanced dogfighter. Fast roll, punchy cannons, afterburner boost.',
    weapons: ['cannon', 'cannon', 'rocket'],
    allow: { s0: ['cannon'], s1: ['cannon'], s2: ['rocket', 'bomb'] },
    stats: { spd: 0.65, arm: 0.7, hp: 0.55, man: 0.8 },
  },
  interceptor: {
    label: 'Viper', icon: '🚀', color: 0x5a8fb0,
    maxSpeed: 175, minSpeed: 34, stall: 38,
    engineForce: 34000, mass: 1800,
    hp: 85,
    ability: { name: 'Flare Burst', cd: 9, dur: 0 },
    desc: 'Blistering speed, tight turns. Triple autocannon + smoke flares.',
    weapons: ['cannon', 'cannon', 'cannon'],
    allow: { s0: ['cannon'], s1: ['cannon'], s2: ['cannon', 'rocket'] },
    stats: { spd: 0.95, arm: 0.55, hp: 0.4, man: 0.7 },
  },
  bomber: {
    label: 'Havoc', icon: '✈️', color: 0x7a5a3a,
    maxSpeed: 108, minSpeed: 26, stall: 30,
    engineForce: 24000, mass: 3400,
    hp: 165,
    ability: { name: 'Field Repair', cd: 16, dur: 0 },
    desc: 'Slow heavy bomber. Huge hull, heavy missiles, self-repair.',
    weapons: ['rocket', 'rocket', 'bomb'],
    allow: { s0: ['rocket', 'bomb'], s1: ['rocket', 'bomb'], s2: ['bomb'] },
    stats: { spd: 0.35, arm: 0.9, hp: 0.95, man: 0.35 },
  },
};
const WPN = {
  cannon: { name: 'Cannon',  dmg: 9,  speed: 340, life: 1.1, reload: 1.8, mag: 14, auto: true,  size: 0.18 },
  rocket: { name: 'Rocket',  dmg: 34, speed: 95,  life: 3.5, reload: 2.6, mag: 8,  auto: false, size: 0.4, trail: true },
  bomb:   { name: 'Bomb',    dmg: 80, speed: 30,  life: 6.0, reload: 4.0, mag: 4,  auto: false, size: 0.7, gravity: true },
};
const TEAM_COLORS = { 1: 0x4da3ff, 2: 0xff6a4d };
const TEAM_HEX = { 1: '#4da3ff', 2: '#ff6a4d' };
const TOWERS = [ [1500, 400, -1800], [-2200, 300, 1200], [400, 250, 2600] ];

/* ================================================================
   AUDIO — procedural Web Audio engine
================================================================ */
const AudioSys = {
  ctx: null, master: null, muted: false,
  engineOsc: null, engineOsc2: null, engineGain: null, engineFilter: null,
  windSrc: null, windGain: null,
  init() {
    if (this.ctx) return;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) { return; }
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.8;
    this.master.connect(this.ctx.destination);
    // engine: 2 detuned saws -> lowpass -> gain
    this.engineGain = this.ctx.createGain(); this.engineGain.gain.value = 0;
    this.engineFilter = this.ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass'; this.engineFilter.frequency.value = 320;
    this.engineOsc = this.ctx.createOscillator(); this.engineOsc.type = 'sawtooth'; this.engineOsc.frequency.value = 55;
    this.engineOsc2 = this.ctx.createOscillator(); this.engineOsc2.type = 'sawtooth'; this.engineOsc2.frequency.value = 55.7;
    this.engineOsc.connect(this.engineFilter); this.engineOsc2.connect(this.engineFilter);
    this.engineFilter.connect(this.engineGain); this.engineGain.connect(this.master);
    this.engineOsc.start(); this.engineOsc2.start();
    // wind: looping noise
    const nb = this.noiseBuffer(2);
    this.windSrc = this.ctx.createBufferSource(); this.windSrc.buffer = nb; this.windSrc.loop = true;
    this.windFilter = this.ctx.createBiquadFilter(); this.windFilter.type = 'lowpass'; this.windFilter.frequency.value = 500;
    this.windGain = this.ctx.createGain(); this.windGain.gain.value = 0;
    this.windSrc.connect(this.windFilter); this.windFilter.connect(this.windGain); this.windGain.connect(this.master);
    this.windSrc.start();
  },
  noiseBuffer(sec) {
    const len = this.ctx.sampleRate * sec;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;      // pinkish
      d[i] = last * 3.5;
    }
    return buf;
  },
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); },
  engine(throttle, speed, boost) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const g = (0.10 + throttle * 0.30) * (this.muted ? 0 : 1);
    this.engineGain.gain.setTargetAtTime(g, t, 0.08);
    const f = 42 + throttle * 42 + (speed / 180) * 18 + (boost ? 26 : 0);
    this.engineOsc.frequency.setTargetAtTime(f, t, 0.1);
    this.engineOsc2.frequency.setTargetAtTime(f * 1.012, t, 0.1);
    this.engineFilter.frequency.setTargetAtTime(240 + throttle * 500, t, 0.1);
    const wg = clamp(speed / 160, 0, 1) * 0.22 * (this.muted ? 0 : 1);
    this.windGain.gain.setTargetAtTime(wg, t, 0.2);
  },
  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 0.8;
  },
  _burst(dur, type, f0, f1, gain, q) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource(); src.buffer = this.noiseBuffer(dur);
    const flt = this.ctx.createBiquadFilter(); flt.type = type;
    flt.frequency.setValueAtTime(f0, t);
    flt.frequency.exponentialRampToValueAtTime(Math.max(f1, 20), t + dur);
    flt.Q.value = q || 1;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(flt); flt.connect(g); g.connect(this.master);
    src.start(); src.stop(t + dur + 0.05);
  },
  _tone(type, f0, f1, dur, gain) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(f1, 20), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(); o.stop(t + dur + 0.05);
  },
  shot()    { this._burst(0.09, 'bandpass', 900, 300, 0.5, 2); this._tone('square', 140, 60, 0.08, 0.25); },
  rocket()  { this._burst(0.45, 'lowpass', 1400, 120, 0.6, 1); },
  boom(big) { this._burst(big ? 1.1 : 0.6, 'lowpass', 500, 40, big ? 0.9 : 0.5, 1); this._tone('sine', 70, 28, big ? 0.9 : 0.5, 0.7); },
  hit()     { this._tone('square', 320, 90, 0.12, 0.3); this._burst(0.08, 'highpass', 2000, 800, 0.2, 1); },
  explodeFar(d) { this.boom(false); },
  thunder(d) { this._burst(1.6, 'lowpass', 200, 30, clamp(0.9 - d / 3000, 0.05, 0.9), 1); },
  click()   { this._tone('sine', 660, 440, 0.06, 0.15); },
  kill()    { this._tone('sine', 520, 1040, 0.25, 0.3); },
  respawn() { this._tone('sine', 300, 900, 0.35, 0.3); },
};

/* ================================================================
   INPUT — keyboard / mouse / gamepad
================================================================ */
const Input = {
  keys: Object.create(null),
  mouse: { fire: false },
  pad: { yaw: 0, pitch: 0, roll: 0, throttle: 0, fire: false, ability: false, camera: false, weapon: false, pause: false },
  padBtns: [false,false,false,false,false,false,false,false,false,false,false,false],
  init() {
    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys[e.code] = true;
      if (['Tab', 'Space'].includes(e.code)) e.preventDefault();
      Game.onKey(e.code);
    });
    addEventListener('keyup', (e) => { this.keys[e.code] = false; });
    const cv = document.getElementById('game-canvas');
    cv.addEventListener('mousedown', (e) => {
      AudioSys.init(); AudioSys.resume();
      if (e.button === 0) this.mouse.fire = true;
    });
    addEventListener('mouseup', (e) => { if (e.button === 0) this.mouse.fire = false; });
    addEventListener('blur', () => { this.keys = Object.create(null); this.mouse.fire = false; });
  },
  pollGamepad() {
    this.pad.fire = this.pad.ability = this.pad.camera = this.pad.weapon = this.pad.pause = false;
    this.pad.yaw = this.pad.pitch = this.pad.roll = this.pad.throttle = 0;
    const gps = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const gp of gps) {
      if (!gp || !gp.connected) continue;
      const ax = (i) => Math.abs(gp.axes[i] || 0) > 0.12 ? gp.axes[i] : 0;
      this.pad.pitch = ax(1); this.pad.yaw = ax(0);
      this.pad.roll = ax(2); this.pad.throttle = ax(3);
      const b = (i) => gp.buttons[i] && gp.buttons[i].pressed;
      this.pad.fire = b(0); this.pad.ability = b(1); this.pad.camera = b(3); this.pad.weapon = b(2);
      this.pad.pause = b(9);
      this.padBtns.forEach((_, i) => {});
      const pressedNow = [];
      gp.buttons.forEach((bt, i) => pressedNow.push(bt.pressed));
      this.padBtns.forEach((was, i) => {
        if (pressedNow[i] && !was && pressedNow[i]) {
          if (i === 4 || i === 5) Game.cycleWeapon(i === 4 ? -1 : 1);
        }
      });
      this.padBtns = pressedNow;
    }
  },
  axis(name) {
    // combines keyboard + gamepad for one control axis
    switch (name) {
      case 'throttle': return (this.keys.KeyW ? 1 : 0) - (this.keys.KeyS ? 1 : 0) + this.pad.throttle;
      case 'pitch':    return (this.keys.ArrowUp ? 1 : 0) - (this.keys.ArrowDown ? 1 : 0) + this.pad.pitch;
      case 'yaw':      return (this.keys.ArrowLeft ? 1 : 0) - (this.keys.ArrowRight ? 1 : 0) + this.pad.yaw;
      case 'roll':     return (this.keys.KeyD ? 1 : 0) - (this.keys.KeyA ? 1 : 0) + this.pad.roll;
      case 'fire':     return !!(this.keys.Space || this.mouse.fire || this.pad.fire);
      case 'ability':  return !!(this.keys.KeyR || this.pad.ability);
      case 'camera':   return !!(this.keys.KeyV || this.pad.camera);
    }
    return 0;
  },
};

/* ================================================================
   THREE.JS SETUP — scene, sky, world
================================================================ */
const canvas = document.getElementById('game-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x9fb8d8, 0.00016);
const camera = new THREE.PerspectiveCamera(68, innerWidth / innerHeight, 0.5, 26000);

// --- lights
const hemi = new THREE.HemisphereLight(0xbfd8ff, 0x3a4a3a, 0.9);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff2d8, 2.2);
scene.add(sun);
const amb = new THREE.AmbientLight(0x334466, 0.35);
scene.add(amb);

// --- skybox (shader)
const skyU = {
  uSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uTime: { value: 0 },
};
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, fog: false,
  uniforms: skyU,
  vertexShader: `
    varying vec3 vDir;
    void main() {
      vDir = normalize(position);
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_Position = (projectionMatrix * mv).xyww;
    }`,
  fragmentShader: `
    varying vec3 vDir;
    uniform vec3 uSunDir;
    uniform float uTime;
    float hash(vec3 p) {
      p = fract(p * 0.3183099 + 0.1);
      p *= 17.0;
      return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
    }
    void main() {
      vec3 d = normalize(vDir);
      float sunH = uSunDir.y;
      float dayF = smoothstep(-0.12, 0.32, sunH);
      float duskF = pow(1.0 - clamp(abs(sunH) * 2.2, 0.0, 1.0), 2.0) * (0.4 + 0.6 * dayF);

      vec3 zenDay = vec3(0.10, 0.28, 0.72), horDay = vec3(0.62, 0.78, 0.95);
      vec3 zenNight = vec3(0.010, 0.015, 0.05), horNight = vec3(0.05, 0.07, 0.14);
      vec3 zen = mix(zenNight, zenDay, dayF);
      vec3 hor = mix(horNight, horDay, dayF);
      hor += vec3(0.85, 0.32, 0.10) * duskF * 0.75;
      zen += vec3(0.18, 0.06, 0.16) * duskF * 0.3;

      float hgt = pow(1.0 - max(d.y, 0.0), 1.6);
      vec3 col = mix(zen, hor, hgt);
      // below horizon: darken
      col = mix(col, col * 0.35, smoothstep(0.0, -0.25, d.y));

      // sun disc + glow
      float sd = max(dot(d, uSunDir), 0.0);
      col += vec3(1.0, 0.95, 0.8) * (pow(sd, 900.0) * 12.0 + pow(sd, 24.0) * 0.35) * dayF;
      col += vec3(1.0, 0.6, 0.3) * pow(sd, 6.0) * 0.25 * duskF;

      // moon
      vec3 mdir = normalize(vec3(-uSunDir.x, abs(uSunDir.y) * 0.7 + 0.25, -uSunDir.z));
      float md = max(dot(d, mdir), 0.0);
      col += vec3(0.8, 0.85, 1.0) * pow(md, 1400.0) * 5.0 * (1.0 - dayF);

      // stars
      if (dayF < 0.5 && d.y > 0.02) {
        vec3 sp = floor(d * 260.0);
        float s = hash(sp);
        if (s > 0.9965) {
          float tw = 0.6 + 0.4 * sin(uTime * 2.0 + s * 90.0);
          col += vec3(0.9, 0.95, 1.0) * (s - 0.9965) * 300.0 * tw * (1.0 - dayF * 2.0);
        }
      }
      gl_FragColor = vec4(col, 1.0);
    }`,
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(20000, 24, 16), skyMat);
sky.frustumCulled = false;
scene.add(sky);

// --- sun/moon visual (billboard glow)
const sunSprite = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(64, 64, 4, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,240,210,1)'); gr.addColorStop(0.25, 'rgba(255,220,160,0.55)'); gr.addColorStop(1, 'rgba(255,200,120,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  const m = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, fog: false });
  const s = new THREE.Sprite(m); s.scale.set(1400, 1400, 1);
  scene.add(s);
  return s;
})();

// --- terrain
function fbm2(x, z) {
  let v = 0, a = 1, f = 1, tot = 0;
  for (let i = 0; i < 4; i++) {
    const s = Math.sin(x * f * 0.0011 + i * 19.7) * Math.cos(z * f * 0.0013 + i * 7.3);
    const c = Math.sin(x * f * 0.0007 - i * 11.1) * Math.sin(z * f * 0.0009 + i * 5.1);
    v += (s + c) * 0.5 * a; tot += a; a *= 0.5; f *= 2.1;
  }
  return v / tot;
}
const terrainGeo = new THREE.PlaneGeometry(14000, 14000, 96, 96);
terrainGeo.rotateX(-Math.PI / 2);
{
  const pos = terrainGeo.attributes.position;
  const cols = [];
  const low = new THREE.Color(0x2e4a2a), mid = new THREE.Color(0x4a5a34), hi = new THREE.Color(0x6a6258), sn = new THREE.Color(0xd8dde8);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const d = Math.hypot(x, z);
    let h = fbm2(x, z) * 900 + fbm2(x * 3.1, z * 3.1) * 160;
    h = Math.max(h, 0);
    // flatten near world center for a flight field
    const flat = clamp((d - 350) / 1400, 0, 1);
    h *= flat;
    pos.setY(i, h);
    const c = new THREE.Color();
    if (h < 60) c.lerpColors(low, mid, h / 60);
    else if (h < 380) c.lerpColors(mid, hi, (h - 60) / 320);
    else c.lerpColors(hi, sn, clamp((h - 380) / 400, 0, 1));
    cols.push(c.r, c.g, c.b);
  }
  terrainGeo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  terrainGeo.computeVertexNormals();
}
const terrain = new THREE.Mesh(terrainGeo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
scene.add(terrain);

// --- sea
const sea = new THREE.Mesh(
  new THREE.CircleGeometry(20000, 48),
  new THREE.MeshPhongMaterial({ color: 0x1a3a5c, specular: 0x88bbdd, shininess: 90, transparent: true, opacity: 0.92 })
);
sea.rotation.x = -Math.PI / 2; sea.position.y = -2;
scene.add(sea);

// --- control towers (objectives)
const towerMeshes = [];
for (const [x, y, z] of TOWERS) {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.CylinderGeometry(14, 20, 40, 8), new THREE.MeshLambertMaterial({ color: 0x777f88 }));
  base.position.y = 20; g.add(base);
  const cab = new THREE.Mesh(new THREE.BoxGeometry(26, 16, 26), new THREE.MeshLambertMaterial({ color: 0x9aa4ad }));
  cab.position.y = 48; g.add(cab);
  const win = new THREE.Mesh(new THREE.BoxGeometry(26.6, 7, 26.6), new THREE.MeshLambertMaterial({ color: 0x223044, emissive: 0x1a2a40 }));
  win.position.y = 48; g.add(win);
  const light = new THREE.Mesh(new THREE.SphereGeometry(2.5, 8, 8), new THREE.MeshBasicMaterial({ color: 0xff5533 }));
  light.position.y = 62; g.add(light);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(60, 1.5, 8, 40), new THREE.MeshBasicMaterial({ color: 0x4da3ff, transparent: true, opacity: 0.5 }));
  ring.rotation.x = Math.PI / 2; ring.position.y = 5; g.add(ring);
  g.position.set(x, 0, z);
  scene.add(g);
  towerMeshes.push({ g, ring, team: 0, x, z });
}

// --- clouds (sprites)
const cloudTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  for (let i = 0; i < 7; i++) {
    const x = 20 + Math.random() * 88, y = 40 + Math.random() * 48, r = 16 + Math.random() * 22;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, 'rgba(255,255,255,0.85)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
  }
  return new THREE.CanvasTexture(c);
})();
const clouds = [];
for (let i = 0; i < 26; i++) {
  const m = new THREE.SpriteMaterial({ map: cloudTex, transparent: true, opacity: 0.5, depthWrite: false });
  const s = new THREE.Sprite(m);
  const sc = rand(500, 1400);
  s.scale.set(sc, sc * 0.42, 1);
  s.position.set(rand(-6000, 6000), rand(950, 1600), rand(-6000, 6000));
  s.userData.wind = rand(2, 7);
  scene.add(s); clouds.push(s);
}

// --- rain (points)
const RAIN_N = 700;
const rainGeo = new THREE.BufferGeometry();
const rainPos = new Float32Array(RAIN_N * 3);
for (let i = 0; i < RAIN_N; i++) {
  rainPos[i*3] = rand(-400, 400); rainPos[i*3+1] = rand(0, 500); rainPos[i*3+2] = rand(-400, 400);
}
rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
const rainMat = new THREE.PointsMaterial({ color: 0x9fb8d8, size: 1.6, transparent: true, opacity: 0, depthWrite: false });
const rain = new THREE.Points(rainGeo, rainMat);
scene.add(rain);

// --- weather state
const Weather = {
  rain: 0, rainTarget: 0, cloud: 0.5, cloudTarget: 0.5,
  nextShift: performance.now() + 20000, lightningAt: 0, flash: 0,
  update(dt, now) {
    if (now > this.nextShift) {
      this.nextShift = now + rand(25000, 50000);
      const roll = Math.random();
      this.rainTarget = roll < 0.35 ? rand(0.3, 1) : roll < 0.55 ? rand(0, 0.2) : 0;
      this.cloudTarget = this.rainTarget > 0.2 ? rand(0.6, 1) : rand(0.2, 0.7);
    }
    this.rain = lerp(this.rain, this.rainTarget, dt * 0.05);
    this.cloud = lerp(this.cloud, this.cloudTarget, dt * 0.05);
    // lightning
    if (this.rain > 0.45 && now > this.lightningAt && Math.random() < dt * 0.06) {
      this.lightningAt = now + rand(3000, 9000);
      this.flash = 1;
      const dist = rand(800, 3000);
      setTimeout(() => AudioSys.thunder(dist), dist * 0.06);
    }
    this.flash = Math.max(0, this.flash - dt * 3.2);
    // apply
    rainMat.opacity = this.rain * 0.5;
    for (const c of clouds) c.material.opacity = this.cloud * 0.55;
    const baseD = 0.00016 + this.rain * 0.00022 + this.cloud * 0.00004;
    scene.fog.density = baseD;
  },
  updateRain(dt, playerPos) {
    if (this.rain < 0.02) { rain.visible = false; return; }
    rain.visible = true;
    rain.position.copy(playerPos);
    const p = rainGeo.attributes.position.array;
    for (let i = 0; i < RAIN_N; i++) {
      p[i*3+1] -= dt * 380;
      p[i*3] += dt * 30;
      if (p[i*3+1] < -30) { p[i*3+1] = rand(200, 520); p[i*3] = rand(-400, 400); p[i*3+2] = rand(-400, 400); }
    }
    rainGeo.attributes.position.needsUpdate = true;
  },
};

/* ================================================================
   AIRPLANE MODEL FACTORY
================================================================ */
const _boxGeo = new THREE.BoxGeometry(1, 1, 1);
function makePlaneMesh(spec, team) {
  const g = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: spec.color, metalness: 0.55, roughness: 0.4 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x22262e, metalness: 0.6, roughness: 0.5 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x9fd8ff, metalness: 0.9, roughness: 0.12, transparent: true, opacity: 0.65 });
  const teamMat = new THREE.MeshStandardMaterial({ color: TEAM_COLORS[team] || 0xffffff, metalness: 0.3, roughness: 0.6 });

  const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z); m.rotation.set(rx, ry, rz); m.scale.set(sx, sy, sz);
    g.add(m); return m;
  };
  const box = (w, h, d) => { const bg = new THREE.BoxGeometry(w, h, d); return bg; };

  // fuselage (pointing -Z)
  add(new THREE.CylinderGeometry(0.62, 0.42, 5.6, 10), bodyMat, 0, 0, 0.2, Math.PI / 2, 0, 0);
  add(new THREE.ConeGeometry(0.62, 1.6, 10), bodyMat, 0, 0, -3.5, -Math.PI / 2, 0, 0);
  add(new THREE.CylinderGeometry(0.7, 0.7, 0.5, 10), darkMat, 0, 0, 2.9, Math.PI / 2, 0, 0); // engine ring
  // canopy
  add(new THREE.SphereGeometry(0.55, 10, 8), glassMat, 0, 0.5, -1.2, 0, 0, 0, 1, 0.75, 1.7);
  // wings
  add(box(9.5, 0.14, 2.1), bodyMat, 0, 0, 0.6);
  add(box(0.5, 0.16, 1.4), teamMat, -4.55, 0.02, 0.6);
  add(box(0.5, 0.16, 1.4), teamMat, 4.55, 0.02, 0.6);
  // tail
  add(box(3.4, 0.1, 1.1), bodyMat, 0, 0.18, 2.7);
  add(box(0.12, 1.7, 1.2), teamMat, 0, 0.95, 2.7, 0, 0, -0.12);
  // guns
  add(new THREE.BoxGeometry(0.12, 0.12, 1.3), darkMat, -1.2, -0.1, -2.6);
  add(new THREE.BoxGeometry(0.12, 0.12, 1.3), darkMat, 1.2, -0.1, -2.6);
  // rocket rails
  add(box(0.3, 0.12, 1.8), darkMat, -2.8, 0.12, 0.6);
  add(box(0.3, 0.12, 1.8), darkMat, 2.8, 0.12, 0.6);
  // team stripe
  add(box(0.16, 0.3, 4.6), teamMat, 0, 0.55, 0.4);

  g.userData.gunL = new THREE.Vector3(-1.2, -0.1, -3.4);
  g.userData.gunR = new THREE.Vector3(1.2, -0.1, -3.4);
  g.userData.nose = new THREE.Vector3(0, 0, -4.3);
  g.userData.tail = new THREE.Vector3(0, 0, 3.2);
  g.traverse((o) => { o.frustumCulled = true; });
  return g;
}

/* name/HP tags above remote planes */
const tagCanvas = document.createElement('canvas'); tagCanvas.width = 64; tagCanvas.height = 16;
function makeTag() {
  const m = new THREE.SpriteMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false });
  const s = new THREE.Sprite(m); s.scale.set(6, 1.5, 1);
  return s;
}
function makeHPBar() {
  const c = document.createElement('canvas'); c.width = 64; c.height = 6;
  const t = new THREE.CanvasTexture(c);
  const m = new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false });
  const s = new THREE.Sprite(m); s.scale.set(5, 0.6, 1); s.center.set(0.5, 1.6);
  s.userData.canvas = c; s.userData.tex = t;
  return s;
}

/* ================================================================
   PARTICLE / EFFECT SYSTEM
================================================================ */
class ParticlePool {
  constructor(max, size, texColor, blending) {
    this.max = max;
    this.geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.grow = new Float32Array(max);
    this.cursor = 0;
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1));
    this.mat = new THREE.PointsMaterial({
      size, sizeAttenuation: true, transparent: true, depthWrite: false,
      vertexColors: true, blending: blending || THREE.NormalBlending,
    });
    this.pts = new THREE.Points(this.geo, this.mat);
    this.pts.frustumCulled = false;
    scene.add(this.pts);
  }
  spawn(p, v, col, life, size, grav, grow) {
    const i = this.cursor; this.cursor = (this.cursor + 1) % this.max;
    this.pos[i*3] = p.x; this.pos[i*3+1] = p.y; this.pos[i*3+2] = p.z;
    this.vel[i*3] = v.x; this.vel[i*3+1] = v.y; this.vel[i*3+2] = v.z;
    this.col[i*3] = col.r; this.col[i*3+1] = col.g; this.col[i*3+2] = col.b;
    this.life[i] = life; this.maxLife[i] = life;
    this.size[i] = size; this.grav[i] = grav; this.grow[i] = grow;
  }
  update(dt) {
    const pos = this.pos, vel = this.vel, col = this.col;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.size[i] = 0; continue; }
      vel[i*3+1] -= this.grav[i] * dt;
      pos[i*3] += vel[i*3] * dt; pos[i*3+1] += vel[i*3+1] * dt; pos[i*3+2] += vel[i*3+2] * dt;
      if (this.grow[i]) this.size[i] += this.grow[i] * dt;
      const f = this.life[i] / this.maxLife[i];
      col[i*3] *= (0.92 + 0.08 * f); // slight fade
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
    this.geo.attributes.size.needsUpdate = true;
  }
}
const softDotTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 32;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
})();
// NOTE: PointsMaterial ignores vertex size; use a shader material for per-particle size
function makeParticleMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `
      attribute float size; attribute vec3 color; varying vec3 vColor;
      void main() {
        vColor = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * (300.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying vec3 vColor;
      void main() {
        vec2 uv = gl_PointCoord - 0.5;
        float d = length(uv);
        if (d > 0.5) discard;
        float a = smoothstep(0.5, 0.0, d);
        gl_FragColor = vec4(vColor, a);
      }`,
  });
}
function makePool(max, mat, normalBlend) {
  const pool = Object.create(ParticlePool.prototype);
  pool.max = max;
  pool.geo = new THREE.BufferGeometry();
  pool.pos = new Float32Array(max * 3);
  pool.col = new Float32Array(max * 3);
  pool.size = new Float32Array(max);
  pool.vel = new Float32Array(max * 3);
  pool.life = new Float32Array(max);
  pool.maxLife = new Float32Array(max);
  pool.grav = new Float32Array(max);
  pool.grow = new Float32Array(max);
  pool.cursor = 0;
  pool.geo.setAttribute('position', new THREE.BufferAttribute(pool.pos, 3));
  pool.geo.setAttribute('color', new THREE.BufferAttribute(pool.col, 3));
  pool.geo.setAttribute('size', new THREE.BufferAttribute(pool.size, 1));
  pool.mat = mat;
  pool.pts = new THREE.Points(pool.geo, mat);
  pool.pts.frustumCulled = false;
  scene.add(pool.pts);
  return pool;
}
const poolSparks  = makePool(900, makeParticleMaterial());   // additive
const poolSmoke   = makePool(700, new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.NormalBlending,
  vertexShader: `
    attribute float size; attribute vec3 color; varying vec3 vColor;
    void main() {
      vColor = color;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = size * (300.0 / -mv.z);
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: `
    varying vec3 vColor;
    void main() {
      vec2 uv = gl_PointCoord - 0.5;
      float d = length(uv);
      if (d > 0.5) discard;
      float a = smoothstep(0.5, 0.1, d) * 0.55;
      gl_FragColor = vec4(vColor, a);
    }`,
}));

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const tmpC = new THREE.Color();

function explode(pos, big) {
  const n = big ? 90 : 46;
  for (let i = 0; i < n; i++) {
    const v = V(rand(-1,1), rand(-1,1), rand(-1,1)).normalize().multiplyScalar(rand(8, big ? 55 : 32));
    tmpC.setHSL(rand(0.02, 0.11), 1, rand(0.45, 0.7));
    poolSparks.spawn(pos, v, tmpC, rand(0.4, 1.3), rand(1.5, big ? 5 : 3), 14, big ? 3 : 1.5);
  }
  for (let i = 0; i < (big ? 26 : 12); i++) {
    const v = V(rand(-1,1), rand(-0.2,1), rand(-1,1)).normalize().multiplyScalar(rand(3, 14));
    tmpC.setHSL(0.08, 0.1, rand(0.25, 0.45));
    poolSmoke.spawn(pos, v, tmpC, rand(1.2, 2.6), rand(2, 4), -2, 2.5);
  }
  // flash light
  const L = new THREE.PointLight(0xffa040, big ? 900 : 350, 400, 2);
  L.position.copy(pos); scene.add(L);
  const t0 = performance.now();
  (function fade() {
    const k = 1 - (performance.now() - t0) / (big ? 500 : 260);
    if (k <= 0) { scene.remove(L); return; }
    L.intensity = (big ? 900 : 350) * k;
    requestAnimationFrame(fade);
  })();
  // shockwave
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.8, 1, 32),
    new THREE.MeshBasicMaterial({ color: 0xffc070, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false })
  );
  ring.position.copy(pos); ring.lookAt(camera.position);
  scene.add(ring);
  const r0 = performance.now();
  (function grow() {
    const k = (performance.now() - r0) / (big ? 700 : 400);
    if (k >= 1) { scene.remove(ring); ring.geometry.dispose(); return; }
    const s = 4 + k * (big ? 90 : 45);
    ring.scale.set(s, s, s);
    ring.material.opacity = 0.8 * (1 - k);
    ring.lookAt(camera.position);
    requestAnimationFrame(grow);
  })();
  AudioSys.boom(big);
  const d = pos.distanceTo(camera.position);
  if (d < 500) {
    ScreenShake.add(big ? 2.4 : 1.2 * (1 - d / 500));
    document.getElementById('flash').style.opacity = big ? 0.5 : 0.2;
    setTimeout(() => document.getElementById('flash').style.opacity = 0, 90);
  }
}
const ScreenShake = {
  amt: 0,
  add(a) { this.amt = Math.min(3, this.amt + a); },
  decay(dt) { this.amt = Math.max(0, this.amt - dt * 2.2); },
  offset() {
    if (this.amt <= 0.001) return V(0,0,0);
    return V(rand(-1,1), rand(-1,1), rand(-1,1)).multiplyScalar(this.amt);
  },
};

// --- projectiles (visual)
const projectiles = [];
function spawnProjectile(kind, from, dir) {
  const w = WPN[kind];
  let mesh;
  if (kind === 'cannon') {
    mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.2, 5),
      new THREE.MeshBasicMaterial({ color: 0xffd28f }));
    mesh.quaternion.setFromUnitVectors(V(0, 1, 0), dir.clone().normalize());
  } else {
    mesh = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 1.1, 6), new THREE.MeshBasicMaterial({ color: 0xcfd6dd }));
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.4, 6), new THREE.MeshBasicMaterial({ color: 0xff6a4d }));
    tip.position.y = 0.75; mesh.add(body, tip);
    mesh.quaternion.setFromUnitVectors(V(0, 1, 0), dir.clone().normalize());
  }
  mesh.position.copy(from);
  scene.add(mesh);
  projectiles.push({
    mesh, kind, p: from.clone(), v: dir.clone().normalize().multiplyScalar(w.speed),
    age: 0, life: w.life,
  });
  if (kind === 'rocket') AudioSys.rocket();
}
function updateProjectiles(dt) {
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const pr = projectiles[i];
    pr.age += dt;
    if (WPN[pr.kind].gravity) pr.v.y -= 9.81 * dt * 0.55;
    pr.p.addScaledVector(pr.v, dt);
    pr.mesh.position.copy(pr.p);
    if (pr.kind === 'rocket' && Math.random() < dt * 40) {
      tmpC.setHSL(0.09, 0.4, 0.5);
      poolSmoke.spawn(pr.p, V(rand(-1,1), rand(-1,1), rand(-1,1)).multiplyScalar(2), tmpC, rand(0.4, 0.9), rand(0.5, 1), 0, 1.4);
    }
    let dead = pr.age > pr.life || pr.p.y < 0;
    if (dead) {
      if (pr.p.y <= 0 && (pr.kind === 'rocket' || pr.kind === 'bomb')) explode(pr.p.clone(), pr.kind === 'bomb');
      scene.remove(pr.mesh);
      projectiles.splice(i, 1);
    }
  }
}

// --- engine exhaust emitters
const exhaust = {};   // playerId -> {acc}
function emitExhaust(id, pos, dir, throttle, boost, dt) {
  const e = exhaust[id] || (exhaust[id] = { acc: 0 });
  e.acc += dt * (14 + throttle * 50);
  while (e.acc > 1) {
    e.acc--;
    const p = pos.clone().add(dir.clone().multiplyScalar(-1)).add(V(rand(-0.3,0.3), rand(-0.3,0.3), rand(-0.3,0.3)));
    const v = dir.clone().multiplyScalar(-(12 + throttle * 30)).add(V(rand(-2,2), rand(-2,2), rand(-2,2)));
    if (boost) {
      tmpC.setHSL(rand(0.05, 0.13), 1, rand(0.55, 0.75));
      poolSparks.spawn(p, v, tmpC, rand(0.25, 0.5), rand(1.2, 2.4), 0, 2);
    } else {
      tmpC.setHSL(0.58, 0.5, 0.75, );
      poolSparks.spawn(p, v, tmpC, rand(0.15, 0.3), rand(0.5, 1.1), 0, 1);
    }
  }
}
function emitDamageSmoke(pos, hp, dt, id) {
  if (hp > 50) return;
  const rate = hp > 25 ? 5 : 14;
  const e = exhaust['smoke' + id] || (exhaust['smoke' + id] = { acc: 0 });
  e.acc += dt * rate;
  while (e.acc > 1) {
    e.acc--;
    const v = V(rand(-1,1), rand(0.5, 2), rand(-1,1)).multiplyScalar(rand(2, 5));
    tmpC.setHSL(0.08, 0.05, hp > 25 ? 0.35 : 0.15);
    poolSmoke.spawn(pos, v, tmpC, rand(0.8, 1.6), rand(1.2, 2.4), -1, 1.8);
    if (hp <= 15 && Math.random() < 0.4) {
      tmpC.setHSL(0.06, 1, 0.6);
      poolSparks.spawn(pos, V(rand(-3,3), rand(2,8), rand(-3,3)), tmpC, rand(0.2, 0.5), rand(0.6, 1.4), 6, 0);
    }
  }
}

/* ================================================================
   GAME STATE
================================================================ */
const Game = {
  state: 'lobby',          // lobby | combat | ended | replay
  me: null,                // my id
  name: 'Pilot',
  plane: 'fighter',
  loadout: [...PLANE_SPECS.fighter.weapons],
  matchMode: 'deathmatch',
  phase: 'lobby',
  score: { p1: 0, p2: 0 },
  timeLeft: 0,
  tod: 0.3,
  camMode: 'chase',        // chase | cockpit | orbit
  camYaw: 0, camPitch: 0.3, camDist: 26,
  selectedSlot: 0,
  ammo: [0, 0, 0], reloadT: [0, 0, 0],
  abilityUsedAt: 0,
  boostUntil: 0,
  lastKillMsg: 0,
  players: new Map(),      // id -> remote player object
  local: null,             // local player state (my plane)
  orbiting: false, lastOrbitBtn: false,
  lastCamBtn: false,
  lastWeaponBtn: false,
  paused: false,
};

/* ---------------- local (predicted) player physics ---------------- */
const local = {
  p: V(0, 400, 0), q: new THREE.Quaternion(), v: V(0, 0, 0),
  throttle: 0.7, hp: 100, alive: true, boostT: 0,
  g: 1,
};
Game.local = local;

const _fwd = V(0,0,-1), _up = V(0,1,0), _right = V(1,0,0);
const _qP = new THREE.Quaternion(), _qY = new THREE.Quaternion(), _qR = new THREE.Quaternion();
const _xAxis = V(1,0,0), _yAxis = V(0,1,0), _zAxis = V(0,0,-1);

function stepLocal(dt) {
  if (!local.alive) return;
  const spec = PLANE_SPECS[Game.plane];
  const inT = clamp(local.throttle + clamp(Input.axis('throttle'), -1, 1) * dt * 0.45, 0, 1);
  local.throttle = lerp(local.throttle, inT, dt * 3);
  const boost = performance.now() < Game.boostUntil;
  local.boostT = boost;

  // control effectiveness scales with airspeed
  local.q.setFromUnitVectors(_yAxis, _yAxis); // no-op, keep
  _fwd.set(0, 0, -1).applyQuaternion(local.q);
  let airspeed = local.v.dot(_fwd);
  if (airspeed < -8) airspeed = -8;
  const eff = clamp(airspeed / 90, 0.12, 1.35);

  const pitchIn = clamp(Input.axis('pitch'), -1, 1);
  const yawIn = clamp(Input.axis('yaw'), -1, 1);
  const rollIn = clamp(Input.axis('roll'), -1, 1);

  // local-axis rotations (applied in yaw/pitch/roll order for intuitive feel)
  const pr = pitchIn * 1.7 * eff * dt;
  const yr = yawIn * 1.15 * eff * dt;
  const rr = rollIn * 2.7 * eff * dt;
  _qP.setFromAxisAngle(_xAxis, -pr);
  _qY.setFromAxisAngle(_yAxis, -yr);
  _qR.setFromAxisAngle(_zAxis, rr);
  local.q.multiply(_qP).multiply(_qY).multiply(_qR);
  local.q.normalize();

  _fwd.set(0, 0, -1).applyQuaternion(local.q);
  _up.set(0, 1, 0).applyQuaternion(local.q);
  _right.set(1, 0, 0).applyQuaternion(local.q);

  const speed = local.v.length();
  const vFwd = clamp(local.v.dot(_fwd), 0, 9999);

  // engine thrust
  const boostF = boost ? 1.55 : 1;
  const thrust = local.throttle * spec.engineForce * boostF;
  const drag = 1.15 * speed * speed * (1 + Math.abs(pitchIn) * 0.12);
  const accel = (thrust - drag) / spec.mass;
  local.v.addScaledVector(_fwd, accel * dt);

  // gravity
  local.v.y -= 9.81 * dt;

  // lift: holds plane against gravity, tilts with bank
  const lift = 2.1 * vFwd * vFwd / spec.mass;
  local.v.addScaledVector(_up, lift * dt);

  // stall behavior
  if (vFwd < spec.stall) {
    const sink = (spec.stall - vFwd) * 0.06;
    local.v.y -= sink * dt * 10;
    _qP.setFromAxisAngle(_xAxis, -0.35 * dt);
    local.q.multiply(_qP); // nose droops
  }

  // vectoring assist: align velocity toward forward (arcade stability)
  const align = clamp(airspeed / 120, 0, 1) * 1.4 * dt;
  const targetV = _fwd.clone().multiplyScalar(Math.max(airspeed, 0));
  local.v.lerp(targetV, align * 0.5);

  // integrate
  local.p.addScaledVector(local.v, dt);

  // g-load estimate (for HUD)
  const latA = _up.clone().applyQuaternion(local.q);
  local.g = clamp(1 + (Math.abs(rollIn) + Math.abs(pitchIn)) * eff * 2.2, 0, 9);

  // ground collision
  if (local.p.y < 4) {
    local.p.y = 4;
    const speedNow = local.v.length();
    const pitchDown = -local.q.clone().invert().multiply(_fwd.clone()).y; // fwd in local
    if (speedNow < 30 && local.v.y > -14) {
      // rough landing — keep rolling
      local.v.y = Math.max(0, local.v.y);
      local.v.x *= 0.985; local.v.z *= 0.985;
      if (speedNow < 8) { local.v.x = 0; local.v.z = 0; }
    } else {
      // crash
      explode(local.p.clone(), true);
      killMe('Crashed');
    }
  }
  // world boundary
  const r = Math.hypot(local.p.x, local.p.z);
  if (r > WORLD_R) {
    const k = (r - WORLD_R) / r;
    local.p.x -= local.p.x * k; local.p.z -= local.p.z * k;
    local.v.multiplyScalar(0.995);
  }
  local.p.y = clamp(local.p.y, 2, MAX_H);
}

function killMe(reason) {
  if (!local.alive) return;
  local.alive = false;
  explode(local.p.clone(), true);
  document.getElementById('respawn-overlay').classList.add('on');
  let t = 3;
  const el = document.getElementById('respawn-t');
  el.textContent = t;
  const iv = setInterval(() => {
    t--;
    if (t <= 0 || local.alive) { clearInterval(iv); return; }
    el.textContent = t;
  }, 1000);
}

function respawnAt(p) {
  local.p.fromArray(p);
  local.q.identity();
  // face outward from center
  const yaw = Math.atan2(-local.p.x, -local.p.z);
  local.q.setFromAxisAngle(_yAxis, -yaw);
  local.v.set(0, 0, 0);
  local.throttle = 0.7;
  local.hp = PLANE_SPECS[Game.plane].hp;
  local.alive = true;
  Game.ammo = Game.loadout.map((w) => WPN[w].mag);
  Game.reloadT = [0, 0, 0];
  document.getElementById('respawn-overlay').classList.remove('on');
  AudioSys.respawn();
  updatePlaneMesh();
  toast('Respawned — good hunting');
}

/* ---------------- remote players ---------------- */
function getRemote(id) {
  let r = Game.players.get(id);
  if (!r) {
    const mesh = makePlaneMesh(PLANE_SPECS.fighter, 1);
    const tag = makeTag(); tag.position.y = 4.5;
    const hpbar = makeHPBar(); hpbar.position.y = 3.6;
    mesh.add(tag, hpbar);
    scene.add(mesh);
    r = {
      id, name: '??', team: 1, plane: 'fighter', hp: 100,
      mesh, tag, hpbar,
      snap: null,           // latest snapshot
      interpFrom: null, interpTo: null, interpT0: 0,
      lastHpDrawn: 100,
    };
    Game.players.set(id, r);
  }
  return r;
}
function removeRemote(id) {
  const r = Game.players.get(id);
  if (r) { scene.remove(r.mesh); Game.players.delete(id); }
}
function updateRemoteInterp(nowMs) {
  const lag = 80; // ms render delay
  for (const r of Game.players.values()) {
    if (!r.snap) continue;
    // interpolate between previous and latest snapshot
    if (r.interpTo && r.snap.ts !== r.interpTo.ts) {
      r.interpFrom = r.interpTo;
      r.interpTo = { ts: r.snap.ts, p: r.snap.p, q: r.snap.q };
    } else if (!r.interpTo) {
      r.interpTo = { ts: r.snap.ts, p: r.snap.p, q: r.snap.q };
    }
    const dt = (nowMs - lag - r.interpTo.ts);
    if (r.interpFrom && dt > 0) {
      const k = clamp(dt / 50, 0, 1.6);
      r.mesh.position.lerpVectors(r.interpFrom.p, r.interpTo.p, k);
      THREE.Quaternion.slerpQuaternions(r.interpFrom.q, r.interpTo.q, r.mesh.quaternion, k);
      // extrapolate a bit if stale
    } else {
      r.mesh.position.copy(r.interpTo.p);
      r.mesh.quaternion.copy(r.interpTo.q);
    }
    // team color
    const tc = TEAM_COLORS[r.team] || 0xffffff;
    r.mesh.children.forEach((c) => {
      if (c.material && c.material.color && c.material.color.getHex() !== tc && c !== r.tag && c !== r.hpbar) {
        // only recolor team stripe pieces (cheap: skip)
      }
    });
    r.tag.material.color.setHex(tc);
    // hp bar
    const f = clamp(r.hp / PLANE_SPECS[r.plane]?.hp || 1, 0, 1);
    if (Math.abs(f - r.lastHpDrawn) > 0.01) {
      r.lastHpDrawn = f;
      const c = r.hpbar.userData.canvas, g = c.getContext('2d');
      g.clearRect(0, 0, 64, 6);
      g.fillStyle = f > 0.5 ? '#38d06a' : f > 0.25 ? '#e0b13a' : '#e0483a';
      g.fillRect(1, 1, 62 * f, 4);
      r.hpbar.userData.tex.needsUpdate = true;
    }
    r.hpbar.visible = f < 1;
  }
}

/* ================================================================
   CAMERA
================================================================ */
function updateCamera(dt) {
  const p = local.p, q = local.q;
  _fwd.set(0, 0, -1).applyQuaternion(q);
  _up.set(0, 1, 0).applyQuaternion(q);
  const k = 1 - Math.exp(-dt * 7);

  if (Game.camMode === 'chase') {
    const desired = p.clone()
      .addScaledVector(_fwd, -14)
      .addScaledVector(_up, 4.6);
    // keep camera above ground
    if (desired.y < 3) desired.y = 3;
    camera.position.lerp(desired, k);
    const look = p.clone().addScaledVector(_fwd, 10);
    camera.up.lerp(_up, k); camera.up.normalize();
    camera.lookAt(look);
  } else if (Game.camMode === 'cockpit') {
    camera.position.copy(p).addScaledVector(_up, 0.55).addScaledVector(_fwd, -1.6);
    if (camera.position.y < 3) camera.position.y = 3;
    camera.up.lerp(_up, k * 1.4); camera.up.normalize();
    const look = camera.position.clone().addScaledVector(_fwd, 300);
    camera.lookAt(look);
    camera.fov = lerp(camera.fov, 74, k);
  } else { // orbit
    Game.camYaw += (Input.keys.ArrowLeft ? 2 : 0) * dt - (Input.keys.ArrowRight ? 2 : 0) * dt;
    Game.camPitch = clamp(Game.camPitch + (Input.keys.ArrowDown ? 1.4 : 0) * dt - (Input.keys.ArrowUp ? 1.4 : 0) * dt, -0.5, 1.3);
    Game.camDist = clamp(Game.camDist + ((Input.keys.KeyE ? 1 : 0) - (Input.keys.KeyQ ? 1 : 0)) * dt * 20, 8, 90);
    const dir = V(
      Math.sin(Game.camYaw) * Math.cos(Game.camPitch),
      Math.sin(Game.camPitch),
      -Math.cos(Game.camYaw) * Math.cos(Game.camPitch)
    );
    camera.position.copy(p).addScaledVector(dir, Game.camDist);
    if (camera.position.y < 3) camera.position.y = 3;
    camera.up.set(0, 1, 0);
    camera.lookAt(p);
  }
  camera.fov = lerp(camera.fov, Game.camMode === 'cockpit' ? 74 : 68, k);
  camera.updateProjectionMatrix();
  // shake
  const sh = ScreenShake.offset();
  if (sh.lengthSq() > 0) camera.position.add(sh);
}

/* ================================================================
   WEAPONS (client side)
================================================================ */
function tryFire(dt) {
  if (!local.alive) return;
  // reload timers
  for (let i = 0; i < 3; i++) {
    if (Game.ammo[i] < WPN[Game.loadout[i]].mag && Game.reloadT[i] > 0) {
      Game.reloadT[i] -= dt;
      if (Game.reloadT[i] <= 0) { Game.ammo[i] = WPN[Game.loadout[i]].mag; }
    }
  }
  const want = Input.axis('fire') > 0;
  Game._fireHeld = want;
  if (!want) return;
  const i = Game.selectedSlot;
  const w = Game.loadout[i];
  const ws = WPN[w];
  if (ws.auto) {
    if (Game.ammo[i] > 0 && (!Game._fireCooldown || performance.now() > Game._fireCooldown)) {
      Game._fireCooldown = performance.now() + 240;
      fireLocal(i, w);
    }
  } else {
    if (Game.ammo[i] > 0 && !Game._semiLatch) {
      Game._semiLatch = true;
      fireLocal(i, w);
    }
  }
  if (!want) Game._semiLatch = false;
}
function fireLocal(slot, kind) {
  const ws = WPN[kind];
  Game.ammo[slot]--;
  if (Game.ammo[slot] <= 0) Game.reloadT[slot] = ws.reload;
  const q = local.q;
  _fwd.set(0, 0, -1).applyQuaternion(q);
  _up.set(0, 1, 0).applyQuaternion(q);
  _right.set(1, 0, 0).applyQuaternion(q);
  const from = local.p.clone().addScaledVector(_fwd, 4.2);
  if (kind === 'cannon') {
    const side = slot % 2 === 0 ? 1 : -1;
    from.addScaledVector(_right, 1.2 * side).addScaledVector(_up, -0.1);
    const dir = _fwd.clone().add(V(rand(-0.01, 0.01), rand(-0.01, 0.01), 0)).normalize();
    spawnProjectile('cannon', from, dir);
  } else {
    const side = slot % 2 === 0 ? 1 : -1;
    from.addScaledVector(_right, 2.8 * side);
    const dir = _fwd.clone().normalize();
    spawnProjectile(kind, from, dir);
  }
  AudioSys.shot();
  ScreenShake.add(kind === 'cannon' ? 0.15 : 0.4);
  Net.fire(slot, kind, from, _fwd, local.p);
}
function cycleWeapon(dir) {
  Game.selectedSlot = (Game.selectedSlot + dir + 3) % 3;
  AudioSys.click();
  buildWeaponHUD();
}

/* ================================================================
   ABILITIES
================================================================ */
function tryAbility() {
  if (!local.alive || Game.state !== 'combat') return;
  const a = PLANE_SPECS[Game.plane].ability;
  const now = performance.now();
  if (now - Game.abilityUsedAt < a.cd * 1000) return;
  Game.abilityUsedAt = now;
  if (a.name === 'Afterburner') {
    Game.boostUntil = now + a.dur * 1000;
    toast('AFTERBURNER ENGAGED');
    AudioSys.rocket();
  } else if (a.name === 'Flare Burst') {
    // smoke burst around the plane
    for (let i = 0; i < 24; i++) {
      const v = V(rand(-1,1), rand(-1,1), rand(-1,1)).normalize().multiplyScalar(rand(4, 16));
      tmpC.setHSL(0.0, 0, rand(0.6, 0.9));
      poolSmoke.spawn(local.p.clone(), v, tmpC, rand(1.5, 3), rand(2, 4), -0.5, 2);
    }
    toast('FLARES DEPLOYED');
    AudioSys.rocket();
  } else if (a.name === 'Field Repair') {
    Net.heal(local.p.toArray());
    toast('REPAIR KIT DEPLOYED (+45 HP)');
    AudioSys.respawn();
  }
}

/* ================================================================
   NETWORK
================================================================ */
const Net = {
  ws: null, retry: 0,
  connect() {
    const ws = new WebSocket(WS_URL);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      document.getElementById('conn-lost').classList.remove('on');
      this.join();
    };
    ws.onmessage = (e) => this.onMsg(JSON.parse(e.data));
    ws.onclose = () => {
      if (Game.state !== 'lobby' || !document.getElementById('lobby').classList.contains('off')) {
        document.getElementById('conn-lost').classList.add('on');
      }
      setTimeout(() => this.connect(), 2000);
    };
    ws.onerror = () => ws.close();
  },
  send(o) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); },
  join() {
    this.send({ t: 'join', name: Game.name, plane: Game.plane, weapons: Game.loadout, ability: PLANE_SPECS[Game.plane].ability });
  },
  onMsg(m) {
    switch (m.t) {
      case 'hello':
        Game.me = m.id;
        Game.phase = m.phase;
        Game.score = m.score || { p1: 0, p2: 0 };
        Game.timeLeft = m.timeLeft || 0;
        if (m.tod) Game.tod = m.tod;
        // load roster
        for (const p of m.players || []) {
          if (p.id === Game.me) continue;
          const r = getRemote(p.id);
          r.name = p.name; r.team = p.team; r.plane = p.plane; r.hp = p.h;
          r.mesh.visible = true;
          r.snap = { ts: Date.now(), p: new THREE.Vector3().fromArray(p.p), q: new THREE.Quaternion().set(...p.q) };
          r.interpTo = { ts: r.snap.ts, p: r.snap.p.clone(), q: r.snap.q.clone() };
          r.mesh.position.copy(r.snap.p); r.mesh.quaternion.copy(r.snap.q);
        }
        updateOnlineRow();
        break;
      case 'join':
        if (m.id !== Game.me) {
          const r = getRemote(m.id);
          r.mesh.visible = true;
        }
        updateOnlineRow();
        break;
      case 'leave':
        removeRemote(m.id);
        updateOnlineRow();
        break;
      case 'st': {
        if (m.n === Game.me) break;
        const r = getRemote(m.n);
        if (!r.snap || m.ts >= r.snap.ts) {
          if (r.snap) r.interpFrom = { ts: r.snap.ts, p: r.snap.p.clone(), q: r.snap.q.clone() };
          r.snap = { ts: m.ts, p: new THREE.Vector3().fromArray(m.p), q: new THREE.Quaternion().set(...m.q) };
        }
        if (Number.isFinite(m.h)) { r.hp = m.h; }
        break;
      }
      case 'fire': {
        // remote weapon fire FX
        const from = new THREE.Vector3().fromArray(m.s || m.tgt);
        const dir = new THREE.Vector3(...m.n);
        if (m.w === 'cannon') spawnProjectile('cannon', from, dir);
        else spawnProjectile(m.w, from, dir);
        const d = from.distanceTo(local.p);
        if (d < 600) {
          if (m.w === 'cannon') AudioSys.shot();
          else AudioSys.rocket();
        }
        break;
      }
      case 'hit': {
        if (m.healed) {
          local.hp = m.d;
          toast('+45 HP — repaired');
          break;
        }
        if (m.assist) {
          addKillFeed(`Assist +${m.assist === m.assist ? 25 : 25}`, true);
          break;
        }
        local.hp = Math.max(0, m.d);
        AudioSys.hit();
        ScreenShake.add(0.5);
        document.getElementById('damage-vignette').style.opacity = 0.9;
        break;
      }
      case 'boom': {
        const pos = new THREE.Vector3().fromArray(m.tgt);
        explode(pos, true);
        if (m.by === Game.me) {
          // I got someone
          AudioSys.kill();
        }
        break;
      }
      case 'kill': {
        const by = m.by === null ? 'CRASH' : (m.by === Game.me ? 'You' : (Game.players.get(m.by)?.name || 'Enemy'));
        const vic = m.victim === Game.me ? 'You' : (Game.players.get(m.victim)?.name || 'Pilot');
        addKillFeed(`${by} ✈ ${vic}`, m.by === Game.me);
        if (m.streak >= 3 && m.by === Game.me) banner(`${m.streak} KILL STREAK!`, '');
        if (m.victim === Game.me) {
          local.alive = false;
          document.getElementById('respawn-overlay').classList.add('on');
          let t = 3;
          const el = document.getElementById('respawn-t'); el.textContent = t;
          const iv = setInterval(() => { t--; if (t <= 0 || local.alive) { clearInterval(iv); return; } el.textContent = t; }, 1000);
        }
        if (m.score) { Game.score = m.score; updateScoreHUD(); }
        Replay.markKill(m);
        break;
      }
      case 'respawn':
        if (m.p) respawnAt(m.p);
        break;
      case 'heal': {
        const pos = new THREE.Vector3().fromArray(m.p);
        for (let i = 0; i < 20; i++) {
          const v = V(rand(-1,1), rand(0.5, 1.5), rand(-1,1)).normalize().multiplyScalar(rand(3, 10));
          tmpC.setHSL(0.35, 0.9, 0.6);
          poolSparks.spawn(pos, v, tmpC, rand(0.4, 0.9), rand(0.8, 1.6), 2, 0);
        }
        break;
      }
      case 'time':
        if (Number.isFinite(m.tod)) Game.tod = m.tod;
        break;
      case 'state':
        Game.phase = m.phase;
        Game.matchMode = m.match || Game.matchMode;
        Game.score = m.score || Game.score;
        Game.timeLeft = m.timeLeft;
        if (m.phase === 'combat' && Game.state === 'lobby') enterCombat();
        if (m.phase === 'combat' && Game.state !== 'combat' && Game.state !== 'replay') enterCombat();
        if (m.phase === 'finished') showEndScreen(m.winner);
        if (m.phase === 'lobby') toLobby();
        updateScoreHUD();
        break;
    }
  },
  sendInput() {
    if (Game.state !== 'combat' || !local.alive) return;
    this.send({
      t: 'input',
      p: local.p.toArray(),
      q: [local.q.x, local.q.y, local.q.z, local.q.w],
      v: local.v.toArray(),
      th: local.throttle,
      h: local.hp,
    });
  },
  fire(slot, kind, from, dir, p) {
    this.send({ t: 'fire', slot, w: kind, tgt: from.toArray(), n: [dir.x, dir.y, dir.z], s: p.toArray() });
  },
  heal(p) { this.send({ t: 'heal', p }); },
};

/* ================================================================
   HUD
================================================================ */
const $ = (id) => document.getElementById(id);
function fmtTime(s) {
  s = Math.max(0, Math.ceil(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function buildWeaponHUD() {
  const wrap = $('weapons');
  wrap.innerHTML = '';
  for (let i = 0; i < 3; i++) {
    const d = document.createElement('div');
    d.className = 'slot' + (i === Game.selectedSlot ? ' active' : '');
    d.id = 'slot-' + i;
    d.innerHTML = `<span class="key">${i + 1}</span><div class="nm">${WPN[Game.loadout[i]].name}</div><div class="ammo" id="ammo-${i}">—</div>`;
    d.addEventListener('click', () => { Game.selectedSlot = i; AudioSys.click(); buildWeaponHUD(); });
    wrap.appendChild(d);
  }
}
function updateWeaponHUD() {
  for (let i = 0; i < 3; i++) {
    const el = $('ammo-' + i);
    if (!el) continue;
    if (Game.reloadT[i] > 0) { el.textContent = 'RELOAD'; el.className = 'ammo reloading'; }
    else { el.textContent = Game.ammo[i]; el.className = 'ammo'; }
  }
}
let hudTick = 0;
function updateHUD(dt) {
  hudTick += dt;
  const fast = hudTick > 0.08;
  if (!fast) return;
  hudTick = 0;
  const speed = local.v.length();
  $('hud-speed').textContent = Math.round(speed * 1.9438);
  $('hud-alt').textContent = Math.round(local.p.y * 3.281);
  _fwd.set(0, 0, -1).applyQuaternion(local.q);
  let hdg = (Math.atan2(_fwd.x, -_fwd.z) * 180 / Math.PI + 360) % 360;
  $('hud-hdg').textContent = String(Math.round(hdg)).padStart(3, '0');
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  $('hud-hdg-l').textContent = dirs[Math.round(hdg / 45) % 8];
  $('hud-g').textContent = local.g.toFixed(1);
  // hp
  const spec = PLANE_SPECS[Game.plane];
  const f = clamp(local.hp / spec.hp, 0, 1);
  $('hp-num').textContent = Math.round(f * 100) + '%';
  const bar = $('hp-bar');
  bar.firstElementChild.style.width = (f * 100) + '%';
  bar.className = 'bar' + (f < 0.25 ? ' low' : f < 0.5 ? ' mid' : '');
  $('lowhp-pulse').style.display = f < 0.25 && local.alive ? 'block' : 'none';
  // damage vignette decay
  const dv = $('damage-vignette');
  dv.style.opacity = Math.max(0, parseFloat(dv.style.opacity || 0) - 0.04);
  // ability
  const a = spec.ability;
  const cdLeft = Math.max(0, (Game.abilityUsedAt + a.cd * 1000) - performance.now()) / 1000;
  $('ability-name').textContent = a.name;
  $('ability-cd').textContent = cdLeft > 0 ? Math.ceil(cdLeft) + 's' : 'READY';
  $('ability-bar').firstElementChild.style.width = (cdLeft > 0 ? (1 - cdLeft / a.cd) * 100 : 100) + '%';
  // timer
  $('hud-timer').textContent = fmtTime(Game.timeLeft);
  $('hud-mode').textContent = Game.matchMode === 'team' ? 'TEAM BATTLE' : 'DEATHMATCH';
  updateScoreHUD();
  updateWeaponHUD();
  drawRadar();
  drawMinimap();
}
function updateScoreHUD() {
  if (Game.matchMode === 'team') {
    $('score-t1').textContent = Game.score.p1;
    $('score-t2').textContent = Game.score.p2;
  } else {
    // top player
    let best = null;
    const all = [[Game.me, Game.name, myScore()]];
    for (const r of Game.players.values()) all.push([r.id, r.name, 0]);
    // (server keeps scores; show my score + placeholder)
    $('score-t1').textContent = myScore();
    $('score-t2').textContent = '—';
  }
}
function myScore() { return (Game._myScore ?? 0); }
function addKillFeed(txt, good) {
  const kf = $('killfeed');
  const d = document.createElement('div');
  d.className = 'kill-entry';
  d.innerHTML = good ? `<span class="k">${txt}</span>` : txt;
  kf.appendChild(d);
  while (kf.children.length > 5) kf.removeChild(kf.firstChild);
  setTimeout(() => { d.style.transition = 'opacity 0.5s'; d.style.opacity = 0; setTimeout(() => d.remove(), 500); }, 4000);
}
let bannerTO = null;
function banner(h, p) {
  $('banner-h').textContent = h;
  $('banner-p').textContent = p;
  $('banner').classList.add('on');
  clearTimeout(bannerTO);
  bannerTO = setTimeout(() => $('banner').classList.remove('on'), 2600);
}
let toastTO = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTO);
  toastTO = setTimeout(() => t.classList.remove('on'), 2200);
}
function drawRadar() {
  const c = $('radar').getContext('2d');
  const W = 160, R = 78, cx = W / 2, cy = W / 2;
  c.clearRect(0, 0, W, W);
  c.strokeStyle = 'rgba(120,170,255,0.35)';
  c.lineWidth = 1;
  for (const rr of [R * 0.33, R * 0.66, R]) { c.beginPath(); c.arc(cx, cy, rr, 0, TAU); c.stroke(); }
  c.beginPath(); c.moveTo(cx, cy - R); c.lineTo(cx, cy + R); c.moveTo(cx - R, cy); c.lineTo(cx + R, cy); c.stroke();
  _fwd.set(0, 0, -1).applyQuaternion(local.q);
  const hdg = Math.atan2(_fwd.x, -_fwd.z);
  const scale = R / 4000;
  c.save();
  c.translate(cx, cy); c.rotate(hdg);
  // sweep
  const sw = (performance.now() / 900) % TAU;
  const grd = c.createConicGradient ? null : null;
  c.beginPath();
  c.moveTo(0, 0); c.arc(0, 0, R, -0.5, 0.02);
  c.fillStyle = 'rgba(120,220,255,0.10)';
  c.fill();
  for (const r of Game.players.values()) {
    const dx = r.mesh.position.x - local.p.x;
    const dy = r.mesh.position.z - local.p.z;
    // rotate into heading frame
    const rx = dx * Math.cos(-hdg) - dy * Math.sin(-hdg);
    const rz = dx * Math.sin(-hdg) + dy * Math.cos(-hdg);
    const x = -rz * scale, y = -rx * scale;
    if (x * x + y * y > R * R) continue;
    c.fillStyle = r.team === 1 ? 'rgba(77,163,255,0.9)' : 'rgba(255,106,77,0.95)';
    c.beginPath(); c.arc(x, y, 3, 0, TAU); c.fill();
  }
  c.restore();
  // me
  c.fillStyle = '#fff';
  c.beginPath(); c.moveTo(cx, cy - 5); c.lineTo(cx - 3.5, cy + 4); c.lineTo(cx + 3.5, cy + 4); c.closePath(); c.fill();
}
function drawMinimap() {
  const c = $('minimap').getContext('2d');
  const W = 200, R = 96, cx = W / 2, cy = W / 2;
  c.clearRect(0, 0, W, W);
  c.strokeStyle = 'rgba(120,170,255,0.25)';
  for (const rr of [R * 0.33, R * 0.66, R]) { c.beginPath(); c.arc(cx, cy, rr, 0, TAU); c.stroke(); }
  const scale = R / 9000;
  const px = (x, z) => [cx + (x - local.p.x) * scale, cy + (z - local.p.z) * scale];
  // towers (objectives)
  for (const t of towerMeshes) {
    const [x, y] = px(t.x, t.z);
    if (Math.hypot(x - cx, y - cy) > R) continue;
    c.fillStyle = t.team === 0 ? 'rgba(255,210,140,0.9)' : TEAM_HEX[t.team];
    c.strokeStyle = 'rgba(0,0,0,0.4)';
    c.beginPath(); c.rect(x - 4, y - 4, 8, 8); c.fill(); c.stroke();
  }
  // players
  for (const r of Game.players.values()) {
    const [x, y] = px(r.mesh.position.x, r.mesh.position.z);
    if (Math.hypot(x - cx, y - cy) > R) continue;
    c.fillStyle = r.team === 1 ? TEAM_HEX[1] : TEAM_HEX[2];
    c.beginPath(); c.arc(x, y, 3, 0, TAU); c.fill();
  }
  // me (north-up arrow)
  _fwd.set(0, 0, -1).applyQuaternion(local.q);
  const a = Math.atan2(_fwd.x, _fwd.z) + Math.PI;
  c.save(); c.translate(cx, cy); c.rotate(-a);
  c.fillStyle = '#fff';
  c.beginPath(); c.moveTo(0, -6); c.lineTo(-4, 5); c.lineTo(4, 5); c.closePath(); c.fill();
  c.restore();
}

/* scoreboard */
function showScoreboard(on) {
  $('scoreboard').classList.toggle('on', on);
  if (!on) return;
  const rows = [[Game.me, Game.name, Game.matchMode === 'team' ? (local.team ?? 1) : 1, myScore()]];
  for (const r of Game.players.values()) rows.push([r.id, r.name, r.team, 0]);
  rows.sort((a, b) => b[3] - a[3]);
  const tb = $('sb-table');
  tb.innerHTML = `<tr><th></th><th>Pilot</th><th>Team</th><th>Score</th></tr>` +
    rows.map((r, i) =>
      `<tr class="${r[0] === Game.me ? 'me' : ''}"><td>${i + 1}</td><td>${r[1]}</td>
       <td class="team${r[2]}">${r[2]}</td><td>${r[3] || '—'}</td></tr>`).join('');
}

/* ================================================================
   REPLAY SYSTEM
================================================================ */
const Replay = {
  frames: [],        // {t, p:{id:[x,y,z,wx,wy,wz,ww,hp,alive]}}
  kills: [],         // {t, by, victim}
  maxFrames: 3600,   // 3 min @ 20Hz
  acc: 0,
  playing: false, t: 0, speed: 1, followId: null,
  markKill(m) { this.kills.push({ t: performance.now(), by: m.by, victim: m.victim }); if (this.kills.length > 64) this.kills.shift(); },
  start() { this.frames = []; this.kills = []; this.acc = 0; },
  record(dt) {
    this.acc += dt;
    if (this.acc < 0.05) return;
    this.acc = 0;
    const p = {};
    if (local.alive) p[Game.me] = [local.p.x, local.p.y, local.p.z, local.q.x, local.q.y, local.q.z, local.q.w, local.hp, 1];
    for (const r of Game.players.values()) {
      if (r.snap) p[r.id] = [r.mesh.position.x, r.mesh.position.y, r.mesh.position.z, r.mesh.quaternion.x, r.mesh.quaternion.y, r.mesh.quaternion.z, r.mesh.quaternion.w, r.hp, 1];
    }
    this.frames.push({ t: performance.now(), p });
    if (this.frames.length > this.maxFrames) this.frames.shift();
  },
  highlightStart() {
    // start from 8s before last kill, or 0
    if (this.kills.length === 0) return 0;
    const last = this.kills[this.kills.length - 1].t;
    const start = this.frames[0].t;
    const end = this.frames[this.frames.length - 1].t;
    return clamp(last - 8000, start, end - 2000);
  },
  enter(mode) {
    if (this.frames.length < 20) { toast('Not enough replay data'); return; }
    Game.state = 'replay';
    this.playing = true;
    this.speed = 1;
    this.t = mode === 'highlight' ? this.highlightStart() : this.frames[0].t;
    this.followId = null;
    document.getElementById('replay-bar').classList.add('on');
    $('rp-speed').textContent = '1×';
    $('rp-cam').textContent = 'CAM: AUTO';
    $('hud').classList.add('on');
    for (const r of Game.players.values()) { r.mesh.visible = false; }
    // ensure my mesh is in the scene
    updatePlaneMesh();
  },
  exit() {
    Game.state = 'lobby';
    this.playing = false;
    document.getElementById('replay-bar').classList.remove('on');
    for (const r of Game.players.values()) r.mesh.visible = true;
    toLobby();
  },
  sample(time) {
    // find bracketing frames
    const F = this.frames;
    let lo = 0, hi = F.length - 1;
    if (time <= F[0].t) return F[0];
    if (time >= F[hi].t) return F[hi];
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (F[mid].t <= time) lo = mid; else hi = mid;
    }
    const a = F[lo], b = F[hi];
    const k = (time - a.t) / Math.max(1, b.t - a.t);
    const out = { p: {} };
    for (const id of new Set([...Object.keys(a.p), ...Object.keys(b.p)])) {
      const A = a.p[id], B = b.p[id];
      if (!A || !B) continue;
      out.p[id] = [
        lerp(A[0], B[0], k), lerp(A[1], B[1], k), lerp(A[2], B[2], k),
        ...(THREE.Quaternion.slerpQuaternions(
          new THREE.Quaternion(A[3], A[4], A[5], A[6]),
          new THREE.Quaternion(B[3], B[4], B[5], B[6]), new THREE.Quaternion(), k).toArray()),
        lerp(A[7], B[7], k), 1,
      ];
    }
    return out;
  },
  update(dt) {
    const F = this.frames;
    const t0 = F[0].t, t1 = F[F.length - 1].t;
    if (this.playing) this.t += dt * 1000 * this.speed;
    if (this.t > t1) { this.t = t1; this.playing = false; $('rp-play').textContent = '▶'; }
    const s = this.sample(this.t);
    // apply to meshes
    const ids = Object.keys(s.p);
    // follow target: auto = last killer on screen, or me
    if (!this.followId || !s.p[this.followId]) {
      this.followId = (s.p[Game.me] ? Game.me : ids[0]);
    }
    for (const id of ids) {
      const d = s.p[id];
      let mesh;
      if (id === Game.me) {
        local.p.set(d[0], d[1], d[2]);
        local.q.set(d[3], d[4], d[5], d[6]);
        local.hp = d[7];
        local.alive = d[8] > 0.5;
        updatePlaneMesh();
        mesh = Game.localMesh;
      } else {
        const r = getRemote(id);
        mesh = r.mesh;
        mesh.position.set(d[0], d[1], d[2]);
        mesh.quaternion.set(d[3], d[4], d[5], d[6]);
        mesh.visible = true;
        r.hp = d[7];
      }
    }
    // hide players not in sample
    for (const r of Game.players.values()) if (!s.p[r.id]) r.mesh.visible = false;
    // camera: chase the followed plane
    const q = new THREE.Quaternion();
    if (this.followId === Game.me) q.copy(local.q);
    else { const r = Game.players.get(this.followId); if (r) q.copy(r.mesh.quaternion); }
    const p = this.followId === Game.me ? local.p : Game.players.get(this.followId)?.mesh.position;
    if (p) {
      const fwd = V(0, 0, -1).applyQuaternion(q);
      const up = V(0, 1, 0).applyQuaternion(q);
      const k = 1 - Math.exp(-dt * 5);
      camera.position.lerp(p.clone().addScaledVector(fwd, -14).addScaledVector(up, 4.6), k);
      camera.up.lerp(up, k); camera.up.normalize();
      camera.lookAt(p.clone().addScaledVector(fwd, 10));
    }
    // track UI
    const k = (this.t - t0) / Math.max(1, t1 - t0);
    $('replay-playhead').style.left = (k * 100) + '%';
    updateHUD(dt);
  },
  saveJSON() {
    const data = {
      game: 'SKYFALL replay', v: 1,
      duration: (this.frames[this.frames.length - 1].t - this.frames[0].t) / 1000,
      kills: this.kills,
      frames: this.frames,
    };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `skysfall-replay-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  },
};

/* ================================================================
   TIME OF DAY / ENVIRONMENT
================================================================ */
function updateEnvironment(dt) {
  const tod = Game.tod;
  const az = tod * TAU;
  const elevAngle = -Math.cos((tod - 0.3) * TAU) * 1.15;
  const sunDir = V(Math.cos(az) * Math.cos(elevAngle), Math.sin(elevAngle), Math.sin(az) * Math.cos(elevAngle)).normalize();
  skyU.uSunDir.value.copy(sunDir);
  skyU.uTime.value = performance.now() / 1000;
  sun.position.copy(sunDir).multiplyScalar(5000).add(local.p);
  sun.intensity = clamp(Math.sin(elevAngle) * 3 + 0.3, 0.05, 2.6);
  const warm = 1 - clamp(Math.sin(elevAngle), 0, 1);
  sun.color.setHSL(0.11 - warm * 0.04, 0.5 + warm * 0.4, 0.75 - warm * 0.15);
  const dayF = clamp((Math.sin(elevAngle) + 0.1) / 0.5, 0, 1);
  hemi.intensity = 0.15 + dayF * 0.85;
  hemi.color.setHSL(0.6, 0.5, 0.3 + dayF * 0.4);
  amb.intensity = 0.12 + dayF * 0.3;
  // horizon fog color approx
  const fogC = new THREE.Color().setHSL(0.6, 0.35, 0.15 + dayF * 0.45);
  scene.fog.color.copy(fogC);
  // sun sprite
  sunSprite.position.copy(local.p).add(sunDir.clone().multiplyScalar(18000));
  sunSprite.material.opacity = dayF > 0.02 ? 1 : 0;
  // clouds drift
  for (const c of clouds) {
    c.position.x += c.userData.wind * dt;
    if (c.position.x - local.p.x > 7000) c.position.x -= 14000;
    if (c.position.x - local.p.x < -7000) c.position.x += 14000;
  }
  // keep sky centered
  sky.position.copy(local.p);
  Weather.update(dt, performance.now());
  Weather.updateRain(dt, local.p);
  // lightning flash
  if (Weather.flash > 0) {
    amb.intensity += Weather.flash * 1.5;
    document.getElementById('flash').style.opacity = Math.min(0.35, Weather.flash * 0.35);
  }
}

/* ================================================================
   LOBBY UI
================================================================ */
function buildLobby() {
  const wrap = $('plane-cards');
  wrap.innerHTML = '';
  for (const key of Object.keys(PLANE_SPECS)) {
    const s = PLANE_SPECS[key];
    const d = document.createElement('div');
    d.className = 'plane-card' + (key === Game.plane ? ' sel' : '');
    d.innerHTML = `
      <div class="ic">${s.icon}</div>
      <h3>${s.label}</h3>
      <div class="desc">${s.desc}</div>
      <div class="statline">SPD <div class="bar"><i style="width:${s.stats.spd*100}%;background:var(--accent)"></i></div></div>
      <div class="statline">ARM <div class="bar"><i style="width:${s.stats.arm*100}%;background:var(--accent2)"></i></div></div>
      <div class="statline">HULL <div class="bar"><i style="width:${s.stats.hp*100}%;background:#38d06a"></i></div></div>`;
    d.addEventListener('click', () => {
      Game.plane = key;
      Game.loadout = [...s.weapons];
      buildLobby(); buildLoadout();
      AudioSys.click();
      Net.send({ t: 'join', name: Game.name, plane: Game.plane, weapons: Game.loadout, ability: s.ability });
    });
    wrap.appendChild(d);
  }
  $('ability-info').innerHTML = `Ability: <b>${PLANE_SPECS[Game.plane].ability.name}</b> — ${PLANE_SPECS[Game.plane].ability.desc} (cooldown ${PLANE_SPECS[Game.plane].ability.cd}s)`;
}
function buildLoadout() {
  const wrap = $('loadout');
  wrap.innerHTML = '';
  const allow = PLANE_SPECS[Game.plane].allow;
  for (const slot of ['s0', 's1', 's2']) {
    const idx = parseInt(slot[1]);
    const div = document.createElement('div');
    div.innerHTML = `<div class="slotlbl">Slot ${idx + 1}</div>`;
    const sel = document.createElement('select');
    for (const w of allow[slot]) {
      const o = document.createElement('option');
      o.value = w; o.textContent = WPN[w].name + ' ×' + WPN[w].mag;
      if (Game.loadout[idx] === w) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => {
      Game.loadout[idx] = sel.value;
      AudioSys.click();
      Net.send({ t: 'join', name: Game.name, plane: Game.plane, weapons: Game.loadout, ability: PLANE_SPECS[Game.plane].ability });
    });
    div.appendChild(sel);
    wrap.appendChild(div);
  }
}
function updateOnlineRow() {
  const row = $('online-row');
  row.innerHTML = '';
  const me = document.createElement('span');
  me.className = 'online-chip me';
  me.textContent = 'You (' + Game.name + ')';
  row.appendChild(me);
  let n = 0;
  for (const r of Game.players.values()) {
    const c = document.createElement('span');
    c.className = 'online-chip';
    c.style.color = TEAM_HEX[r.team];
    c.textContent = r.name;
    row.appendChild(c);
    n++;
  }
  if (n === 0) row.insertAdjacentHTML('beforeend', '<span class="online-chip">No other pilots yet</span>');
  $('lobby-status').textContent = `${n + 1} pilot(s) online`;
}
function initLobbyUI() {
  Game.name = 'Pilot-' + Math.floor(rand(100, 999));
  $('plane-name').value = Game.name;
  $('plane-name').addEventListener('input', (e) => {
    Game.name = e.target.value.trim() || 'Pilot';
    Net.send({ t: 'join', name: Game.name, plane: Game.plane, weapons: Game.loadout, ability: PLANE_SPECS[Game.plane].ability });
  });
  buildLobby(); buildLoadout();
  document.querySelectorAll('#match-opt label').forEach((l) => {
    l.addEventListener('click', () => {
      document.querySelectorAll('#match-opt label').forEach((x) => x.classList.remove('sel'));
      l.classList.add('sel');
      Game.matchMode = l.dataset.mode;
      AudioSys.click();
    });
  });
  $('join-btn').addEventListener('click', () => {
    AudioSys.init(); AudioSys.resume(); AudioSys.click();
    Net.join();
    banner('DEPLOYING', 'Match starts when a pilot launches…');
    Net.send({ t: 'join', name: Game.name, plane: Game.plane, weapons: Game.loadout, ability: PLANE_SPECS[Game.plane].ability, start: true });
  });
  $('mute-btn').addEventListener('click', () => {
    AudioSys.setMuted(!AudioSys.muted);
    $('mute-btn').textContent = AudioSys.muted ? '🔇' : '🔊';
  });
}

/* ================================================================
   STATE TRANSITIONS
================================================================ */
function enterCombat() {
  if (Game.state === 'combat') return;
  Game.state = 'combat';
  $('lobby').classList.add('off');
  $('hud').classList.add('on');
  $('mini-wrap').style.display = 'flex';
  $('end-screen').classList.remove('on');
  Game.selectedSlot = 0;
  Game._myScore = 0;
  local.team = 1;
  Game.ammo = Game.loadout.map((w) => WPN[w].mag);
  Game.reloadT = [0, 0, 0];
  buildWeaponHUD();
  updatePlaneMesh();
  respawnAt(local.p.toArray());
  Replay.start();
  banner(Game.matchMode === 'team' ? 'TEAM BATTLE' : 'FREE-FLY DEATHMATCH',
    Game.matchMode === 'team' ? 'First team to 500 points' : 'Most kills wins');
  AudioSys.respawn();
}
function toLobby() {
  Game.state = 'lobby';
  $('hud').classList.remove('on');
  $('mini-wrap').style.display = 'none';
  $('end-screen').classList.remove('on');
  $('lobby').classList.remove('off');
  updateOnlineRow();
}
function showEndScreen(winner) {
  Game.state = 'ended';
  let title = 'MATCH OVER', cls = '';
  let sub = '';
  if (Game.matchMode === 'team') {
    if (winner === 1) { title = 'BLUE TEAM WINS'; cls = 'win'; sub = `Final score ${Game.score.p1} — ${Game.score.p2}`; }
    else if (winner === 2) { title = 'RED TEAM WINS'; cls = 'lose'; sub = `Final score ${Game.score.p1} — ${Game.score.p2}`; }
    else { title = 'DRAW'; sub = `Final score ${Game.score.p1} — ${Game.score.p2}`; }
  } else {
    title = 'VICTORY'; cls = 'win';
    sub = 'Top of the scoreboard';
  }
  $('end-title').textContent = title;
  $('end-title').className = cls;
  $('end-sub').textContent = sub;
  $('end-screen').classList.add('on');
}

/* ================================================================
   PLANE MESH (my visible plane)
================================================================ */
let myMesh = null;
function updatePlaneMesh() {
  if (!myMesh) {
    myMesh = makePlaneMesh(PLANE_SPECS[Game.plane], 1);
    scene.add(myMesh);
  } else {
    scene.remove(myMesh);
    myMesh.traverse((o) => { if (o.geometry && o !== myMesh) { /* keep geos */ } });
    scene.add(myMesh);
  }
  myMesh.visible = local.alive && (Game.state === 'combat' || Game.state === 'replay');
  myMesh.position.copy(local.p);
  myMesh.quaternion.copy(local.q);
  Game.localMesh = myMesh;
}

/* ================================================================
   KEY HANDLING
================================================================ */
Game.onKey = (code) => {
  if (Game.state === 'lobby') return;
  switch (code) {
    case 'Digit1': Game.selectedSlot = 0; buildWeaponHUD(); break;
    case 'Digit2': Game.selectedSlot = 1; buildWeaponHUD(); break;
    case 'Digit3': Game.selectedSlot = 2; buildWeaponHUD(); break;
    case 'KeyV': {
      if (!Game._lastV || performance.now() - Game._lastV > 250) {
        Game.camMode = Game.camMode === 'chase' ? 'cockpit' : Game.camMode === 'cockpit' ? 'orbit' : 'chase';
        Game.camYaw = 0; Game.camPitch = 0.3; Game.camDist = 26;
        toast('Camera: ' + Game.camMode.toUpperCase());
        Game._lastV = performance.now();
      }
      break;
    }
    case 'KeyR': tryAbility(); break;
    case 'Tab': showScoreboard(!$('scoreboard').classList.contains('on')); break;
    case 'KeyN': AudioSys.setMuted(!AudioSys.muted); $('mute-btn').textContent = AudioSys.muted ? '🔇' : '🔊'; break;
    case 'Escape': showScoreboard(false); break;
  }
};
Game.cycleWeapon = (dir) => cycleWeapon(dir);

/* replay bar */
$('rp-play').addEventListener('click', () => {
  if (Replay.t >= Replay.frames[Replay.frames.length - 1].t - 100) Replay.t = Replay.frames[0].t;
  Replay.playing = !Replay.playing;
  $('rp-play').textContent = Replay.playing ? '⏸' : '▶';
});
$('rp-speed').addEventListener('click', () => {
  Replay.speed = Replay.speed === 1 ? 0.5 : Replay.speed === 0.5 ? 2 : 1;
  $('rp-speed').textContent = Replay.speed + '×';
});
$('rp-cam').addEventListener('click', () => {
  const ids = Object.keys(Replay.sample(Replay.t).p);
  if (ids.length === 0) return;
  const i = ids.indexOf(String(Replay.followId));
  Replay.followId = ids[(i + 1) % ids.length];
  $('rp-cam').textContent = 'CAM: ' + (Replay.followId === Game.me ? 'YOU' : 'P' + Replay.followId);
});
$('rp-save').addEventListener('click', () => Replay.saveJSON());
$('rp-exit').addEventListener('click', () => Replay.exit());
$('replay-track').addEventListener('click', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  const k = (e.clientX - r.left) / r.width;
  Replay.t = lerp(Replay.frames[0].t, Replay.frames[Replay.frames.length - 1].t, k);
});
$('end-again').addEventListener('click', () => {
  $('end-screen').classList.remove('on');
  Net.send({ t: 'leave' });
  Net.send({ t: 'join', name: Game.name, plane: Game.plane, weapons: Game.loadout, ability: PLANE_SPECS[Game.plane].ability, start: true });
});
$('end-replay').addEventListener('click', () => {
  $('end-screen').classList.remove('on');
  Replay.enter('highlight');
});
$('end-save').addEventListener('click', () => Replay.saveJSON());
$('end-lobby').addEventListener('click', () => {
  $('end-screen').classList.remove('on');
  toLobby();
});

/* ================================================================
   MAIN LOOP
================================================================ */
let lastT = performance.now();
let inputAcc = 0;
function loop(now) {
  requestAnimationFrame(loop);
  let dt = (now - lastT) / 1000;
  lastT = now;
  dt = Math.min(dt, 0.05);

  Input.pollGamepad();

  if (Game.state === 'combat') {
    // local simulation (client prediction)
    stepLocal(dt);
    // weapons
    tryFire(dt);
    if (Input.axis('ability') && !Game._lastA) tryAbility();
    Game._lastA = Input.axis('ability') > 0;
    if (Input.axis('camera') && !Game.lastCamBtn) {
      Game.camMode = Game.camMode === 'chase' ? 'cockpit' : Game.camMode === 'cockpit' ? 'orbit' : 'chase';
      toast('Camera: ' + Game.camMode.toUpperCase());
    }
    Game.lastCamBtn = Input.axis('camera') > 0;
    // network @20Hz
    inputAcc += dt;
    if (inputAcc >= 0.05) { inputAcc = 0; Net.sendInput(); }
    // exhaust + damage smoke
    if (local.alive) {
      _fwd.set(0, 0, -1).applyQuaternion(local.q);
      const tail = local.p.clone().addScaledVector(_fwd, -3.2);
      emitExhaust('me', tail, _fwd.clone().negate(), local.throttle, local.boostT, dt);
      emitDamageSmoke(local.p, local.hp, dt, 'me');
    }
    // remotes
    updateRemoteInterp(now);
    for (const r of Game.players.values()) {
      if (r.hp < 50) emitDamageSmoke(r.mesh.position, r.hp, dt, r.id);
    }
    // remote exhaust (cheap: every other frame)
    if ((now / 16 | 0) % 2 === 0) {
      for (const r of Game.players.values()) {
        if (!r.snap) continue;
        const f = V(0, 0, -1).applyQuaternion(r.mesh.quaternion);
        emitExhaust(r.id, r.mesh.position.clone().addScaledVector(f, -3.2), f.clone().negate(), 0.7, false, dt * 2);
      }
    }
    // record replay
    if (Game.phase === 'combat') Replay.record(dt);
    // tower capture (client-side visual; server authoritative for score)
    for (const t of towerMeshes) {
      if (t.team === 0 && local.alive) {
        if (Math.hypot(local.p.x - t.x, local.p.z - t.z) < 260) {
          t.team = local.team;
          t.ring.material.color.setHex(TEAM_COLORS[local.team]);
          toast('TOWER CAPTURED!');
          AudioSys.kill();
        }
      }
    }
    updateCamera(dt);
    updateHUD(dt);
  } else if (Game.state === 'replay') {
    Replay.update(dt);
  } else if (Game.state === 'lobby') {
    // idle cinematic: slow orbit around a demo plane
    if (!myMesh) updatePlaneMesh();
    local.p.set(0, 300, 0);
    local.q.setFromAxisAngle(_yAxis, Math.sin(now / 9000) * 0.5);
    myMesh.visible = true;
    myMesh.position.copy(local.p);
    myMesh.quaternion.copy(local.q);
    const a = now / 12000;
    camera.position.set(local.p.x + Math.sin(a) * 22, local.p.y + 6, local.p.z + Math.cos(a) * 22);
    camera.up.set(0, 1, 0);
    camera.lookAt(local.p);
    _fwd.set(0, 0, -1).applyQuaternion(local.q);
    const tail = local.p.clone().addScaledVector(_fwd, -3.2);
    emitExhaust('me', tail, _fwd.clone().negate(), 0.55, Math.sin(now / 3000) > 0.7, dt);
  }

  // shared
  updateEnvironment(dt);
  updateProjectiles(dt);
  poolSparks.update(dt);
  poolSmoke.update(dt);
  ScreenShake.decay(dt);

  renderer.render(scene, camera);
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

/* ================================================================
   BOOT
================================================================ */
Input.init();
initLobbyUI();
Net.connect();
// start match server-side: send 'join' with start flag triggers nothing server-side yet;
// server auto-starts when 2+ join? Add explicit: broadcast start on second join.
setInterval(() => {
  if (Game.state === 'lobby' && Game.players.size >= 1) {
    // nudge: ask server to start when 2+ players (server handles via join count)
  }
}, 5000);
requestAnimationFrame(loop);
