/* ═══════════════════════════════════════════════════════════════════════
   welcome-3d.js — the two WebGL scenes on the marketing page.

   Every piece is built here from a profile, the way a turner makes one on
   a lathe: a line is spun round the vertical axis. The knight is the only
   piece that isn't round, so its head is a drawn silhouette pushed out
   into a slab and set on a turned base.

   The hero board assembles itself on load and then plays a few quiet moves
   on a loop. The tour scene shows one piece at a time on a pedestal; the
   page tells it which one through a `tour-step` event.

   Both scenes stop drawing when they're off screen.
   ═══════════════════════════════════════════════════════════════════════ */

import * as THREE from '/assets/vendor/three/three.module.min.js';
import { RoomEnvironment } from '/assets/vendor/three/RoomEnvironment.js';

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ── colour: one per part of a club, matching the stylesheet ─────────── */

export const TONES = {
  gold:  0xe9a93a,   // king    — the club itself
  rose:  0xf0508c,   // queen   — tournaments
  coral: 0xff6a4d,   // rook    — meetings
  iris:  0x6e5bff,   // bishop  — puzzles
  sky:   0x2d8cff,   // knight  — duels
  mint:  0x18bf86,   // pawn    — points
  ink:   0x20232c
};

function material(tone) {
  if (tone === 'gold') {
    return new THREE.MeshPhysicalMaterial({
      color: TONES.gold, metalness: 0.75, roughness: 0.24, clearcoat: 1, clearcoatRoughness: 0.08
    });
  }
  if (tone === 'ink') {
    return new THREE.MeshPhysicalMaterial({
      color: TONES.ink, metalness: 0.1, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.12
    });
  }
  return new THREE.MeshPhysicalMaterial({
    color: TONES[tone], metalness: 0, roughness: 0.42, clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 0.45
  });
}

/* ── profiles: [radius, height], foot to crown ───────────────────────── */

const FOOT = [[0, 0], [0.40, 0], [0.445, 0.02], [0.45, 0.07], [0.42, 0.11], [0.36, 0.135], [0.355, 0.17], [0.31, 0.2]];

function arc(cy, r, from, to, n = 10) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const a = from + (to - from) * (i / n);
    out.push([Math.max(0, Math.cos(a) * r), cy + Math.sin(a) * r]);
  }
  return out;
}
const deg = Math.PI / 180;

const PROFILES = {
  pawn: [...FOOT, [0.23, 0.24], [0.175, 0.32], [0.145, 0.45], [0.135, 0.53], [0.215, 0.565], [0.215, 0.6], [0.14, 0.625],
    ...arc(0.775, 0.175, -58 * deg, 90 * deg, 14)],
  rook: [...FOOT, [0.28, 0.24], [0.255, 0.34], [0.235, 0.62], [0.27, 0.66], [0.31, 0.69], [0.31, 0.82], [0.215, 0.82], [0.215, 0.79], [0, 0.79]],
  bishop: [...FOOT, [0.23, 0.24], [0.175, 0.34], [0.145, 0.5], [0.135, 0.585], [0.225, 0.62], [0.225, 0.655], [0.14, 0.68],
    [0.165, 0.73], [0.19, 0.8], [0.18, 0.88], [0.14, 0.95], [0.085, 1.01], [0.03, 1.045], [0, 1.05]],
  queen: [...FOOT, [0.245, 0.24], [0.185, 0.36], [0.145, 0.6], [0.135, 0.72], [0.23, 0.76], [0.23, 0.795], [0.145, 0.82],
    [0.17, 0.9], [0.225, 1.0], [0.235, 1.03], [0.2, 1.045], [0.09, 1.03], [0, 1.03]],
  king: [...FOOT, [0.25, 0.24], [0.19, 0.36], [0.152, 0.62], [0.142, 0.76], [0.235, 0.8], [0.235, 0.835], [0.15, 0.86],
    [0.185, 0.96], [0.215, 1.05], [0.17, 1.09], [0.06, 1.1], [0, 1.1]],
  knight: [...FOOT, [0.27, 0.24], [0.27, 0.27], [0, 0.27]]
};

/* A Catmull-Rom pass rounds every corner a little, which is what makes
   them look moulded rather than machined. */
function turned(points) {
  const curve = new THREE.SplineCurve(points.map(([x, y]) => new THREE.Vector2(x, y)));
  const pts = curve.getSpacedPoints(points.length * 6).map((p) => new THREE.Vector2(Math.max(0, p.x), p.y));
  pts[0].x = 0;
  pts[pts.length - 1].x = 0;
  return new THREE.LatheGeometry(pts, 72);
}

function knightHead() {
  // facing −x: nose on the left, mane on the right
  const s = new THREE.Shape();
  const V = (x, y) => new THREE.Vector2(x, y);
  s.moveTo(0.3, 0);
  s.splineThru([V(0.33, 0.2), V(0.33, 0.42), V(0.29, 0.64), V(0.21, 0.84), V(0.11, 0.98)]);
  s.lineTo(0.09, 1.17);            // ear
  s.lineTo(0.0, 1.06);
  s.splineThru([V(-0.12, 1.02), V(-0.23, 0.93), V(-0.33, 0.8), V(-0.42, 0.68)]);
  s.quadraticCurveTo(-0.47, 0.6, -0.42, 0.55);   // muzzle
  s.quadraticCurveTo(-0.33, 0.51, -0.2, 0.56);    // mouth
  s.quadraticCurveTo(-0.11, 0.6, -0.08, 0.55);    // jaw
  s.splineThru([V(-0.14, 0.38), V(-0.24, 0.18), V(-0.28, 0)]);
  s.lineTo(0.3, 0);
  const g = new THREE.ExtrudeGeometry(s, {
    depth: 0.2, curveSegments: 32, bevelEnabled: true, bevelThickness: 0.07, bevelSize: 0.05, bevelSegments: 10
  });
  g.translate(0, 0, -0.1);
  return g;
}

const geometryCache = {};
function geometryFor(type) {
  if (!geometryCache[type]) geometryCache[type] = turned(PROFILES[type]);
  return geometryCache[type];
}

export function makePiece(type, tone) {
  const mat = material(tone);
  const g = new THREE.Group();
  const add = (geo, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
    return m;
  };
  add(geometryFor(type));
  if (type === 'rook') {
    const merlon = new THREE.BoxGeometry(0.11, 0.12, 0.13);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const m = add(merlon, Math.cos(a) * 0.262, 0.875, Math.sin(a) * 0.262);
      m.rotation.y = -a;
    }
  } else if (type === 'queen') {
    const ball = new THREE.SphereGeometry(0.042, 20, 14);
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      add(ball, Math.cos(a) * 0.205, 1.07, Math.sin(a) * 0.205);
    }
    add(new THREE.SphereGeometry(0.07, 24, 16), 0, 1.1, 0);
  } else if (type === 'bishop') {
    add(new THREE.SphereGeometry(0.055, 24, 16), 0, 1.09, 0);
    // the mitre's cut, as a raised band
    const band = add(new THREE.TorusGeometry(0.16, 0.012, 8, 48, Math.PI), 0, 0.86, 0);
    band.rotation.set(0.9, 0, 0);
  } else if (type === 'king') {
    add(new THREE.BoxGeometry(0.075, 0.27, 0.075), 0, 1.24, 0);
    add(new THREE.BoxGeometry(0.2, 0.075, 0.075), 0, 1.27, 0);
  } else if (type === 'knight') {
    if (!geometryCache.knightHead) geometryCache.knightHead = knightHead();
    add(geometryCache.knightHead, 0, 0.25, 0);
  }
  return g;
}

/* ── shared renderer setup ───────────────────────────────────────────── */

function webgl() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGL2RenderingContext && c.getContext('webgl2'));
  } catch (e) { return false; }
}

function setup(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;
  return { renderer, scene };
}

function keyLight(scene, size) {
  scene.add(new THREE.HemisphereLight(0xffffff, 0xdfe6f2, 0.3));
  const sun = new THREE.DirectionalLight(0xffffff, 1.25);
  sun.position.set(-5, 11, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -size; sun.shadow.camera.right = size;
  sun.shadow.camera.top = size; sun.shadow.camera.bottom = -size;
  sun.shadow.camera.near = 1; sun.shadow.camera.far = 30;
  sun.shadow.radius = 6;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  scene.add(sun);
  return sun;
}

/* run `frame` only while the canvas is on screen and the tab is visible */
function loop(canvas, frame) {
  let visible = false, raf = 0, last = performance.now();
  const tick = (now) => {
    raf = 0;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    frame(dt, now / 1000);
    if (visible && !document.hidden) raf = requestAnimationFrame(tick);
  };
  const wake = () => { if (!raf && visible && !document.hidden) { last = performance.now(); raf = requestAnimationFrame(tick); } };
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; wake(); }, { rootMargin: '120px' }).observe(canvas);
  document.addEventListener('visibilitychange', wake);
  return wake;
}

function fit(renderer, camera, canvas) {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  const cur = renderer.getSize(new THREE.Vector2());
  if (cur.x === w && cur.y === h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

const ease = {
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  out: (t) => 1 - Math.pow(1 - t, 3),
  back: (t) => { const c = 1.7; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); }
};
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/* ═══ HERO ═══════════════════════════════════════════════════════════════ */

const SQ = 1;
const at = (name) => new THREE.Vector3(('abcdefgh'.indexOf(name[0]) - 3.5) * SQ, 0.12, (3.5 - (+name[1] - 1)) * SQ);

function hero(canvas) {
  const { renderer, scene } = setup(canvas);
  const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 100);
  keyLight(scene, 7);

  /* the board: a moulded slab with tiles set into it */
  const board = new THREE.Group();
  scene.add(board);
  const slabShape = new THREE.Shape();
  const half = 4.45, r = 0.5;
  slabShape.moveTo(-half + r, -half);
  slabShape.lineTo(half - r, -half); slabShape.quadraticCurveTo(half, -half, half, -half + r);
  slabShape.lineTo(half, half - r); slabShape.quadraticCurveTo(half, half, half - r, half);
  slabShape.lineTo(-half + r, half); slabShape.quadraticCurveTo(-half, half, -half, half - r);
  slabShape.lineTo(-half, -half + r); slabShape.quadraticCurveTo(-half, -half, -half + r, -half);
  const slabGeo = new THREE.ExtrudeGeometry(slabShape, { depth: 0.34, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.08, bevelSegments: 6, curveSegments: 16 });
  slabGeo.rotateX(Math.PI / 2);
  const slab = new THREE.Mesh(slabGeo, new THREE.MeshPhysicalMaterial({ color: 0xf4f6fa, roughness: 0.35, clearcoat: 0.6, clearcoatRoughness: 0.3, envMapIntensity: 0.7 }));
  slab.position.y = 0.0;
  slab.receiveShadow = true;
  board.add(slab);

  const tileGeo = new THREE.BoxGeometry(SQ * 0.965, 0.1, SQ * 0.965);
  const light = new THREE.MeshPhysicalMaterial({ color: 0xeef1f8, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.2, envMapIntensity: 0.6 });
  const dark = new THREE.MeshPhysicalMaterial({ color: 0x8e9cc8, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.2, envMapIntensity: 0.6 });
  const tiles = [];
  for (let f = 0; f < 8; f++) {
    for (let rk = 0; rk < 8; rk++) {
      const t = new THREE.Mesh(tileGeo, (f + rk) % 2 === 0 ? dark : light);
      t.position.set((f - 3.5) * SQ, 0.06, (3.5 - rk) * SQ);
      t.receiveShadow = true;
      t.userData.delay = Math.hypot(f - 3.5, rk - 3.5) * 0.07;
      board.add(t);
      tiles.push(t);
    }
  }
  // shadow catcher under the floating board
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.ShadowMaterial({ opacity: 0.12 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -1.1;
  floor.receiveShadow = true;
  scene.add(floor);

  /* a club's pieces in colour against a set in ink */
  const SETUP = [
    ['rook', 'coral', 'a1'], ['queen', 'rose', 'd1'], ['king', 'gold', 'g1'], ['knight', 'sky', 'c3'], ['bishop', 'iris', 'c4'],
    ['pawn', 'mint', 'a2'], ['pawn', 'mint', 'f2'], ['pawn', 'mint', 'g2'], ['pawn', 'mint', 'h2'], ['pawn', 'mint', 'd3'], ['pawn', 'mint', 'e4'],
    ['king', 'ink', 'g8'], ['rook', 'ink', 'f8'], ['queen', 'ink', 'd8'], ['knight', 'ink', 'f6'], ['bishop', 'ink', 'b7'],
    ['pawn', 'ink', 'a7'], ['pawn', 'ink', 'f7'], ['pawn', 'ink', 'g7'], ['pawn', 'ink', 'h7'], ['pawn', 'ink', 'e5'], ['pawn', 'ink', 'd6']
  ];
  const pieces = {};
  SETUP.forEach(([type, tone, sq], i) => {
    const p = makePiece(type, tone);
    p.scale.setScalar(0.84);
    p.position.copy(at(sq));
    if (type === 'knight') p.rotation.y = tone === 'ink' ? 0.35 : Math.PI - 0.35;
    p.userData = { sq, type, tone, delay: 0.75 + i * 0.045, hop: 0, home: p.position.clone() };
    board.add(p);
    pieces[sq] = p;
  });

  /* a few quiet moves, played forward then back, forever */
  const MOVES = [['c3', 'd5'], ['f6', 'h5'], ['c4', 'b3'], ['d8', 'd7'], ['d1', 'e2'], ['b7', 'c6']];
  let moveIx = 0, dir = 1, moving = null, wait = 3.2;
  function nextMove() {
    const [a, b] = MOVES[moveIx];
    const from = dir > 0 ? a : b, to = dir > 0 ? b : a;
    const p = pieces[from];
    delete pieces[from];
    pieces[to] = p;
    p.userData.sq = to;
    moving = { p, from: p.position.clone(), to: at(to), t: 0, dur: p.userData.type === 'knight' ? 1.0 : 0.85, lift: p.userData.type === 'knight' ? 1.1 : 0.35 };
    moveIx += dir;
    if (moveIx === MOVES.length) { moveIx = MOVES.length - 1; dir = -1; }
    else if (moveIx < 0) { moveIx = 0; dir = 1; }
  }

  /* labels: glass chips in the page, pinned over pieces */
  const labels = [...document.querySelectorAll('[data-anchor]')].map((el) => ({ el, sq: el.dataset.anchor }));
  const v = new THREE.Vector3();
  function placeLabels() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    labels.forEach(({ el, sq }) => {
      const p = Object.values(pieces).find((q) => q.userData.label === sq) || null;
      if (!p) return;
      p.getWorldPosition(v);
      v.y += 1.25;
      v.project(camera);
      el.style.transform = `translate3d(${((v.x + 1) / 2 * w).toFixed(1)}px, ${((1 - v.y) / 2 * h).toFixed(1)}px, 0)`;
    });
  }
  labels.forEach(({ sq }) => { if (pieces[sq]) pieces[sq].userData.label = sq; });

  /* tap a piece and it jumps */
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  function pick(e) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(Object.values(pieces), true)[0];
    if (!hit) return null;
    let o = hit.object;
    while (o.parent && o.parent !== board) o = o.parent;
    return o;
  }
  canvas.addEventListener('pointermove', (e) => {
    canvas.style.cursor = pick(e) ? 'pointer' : '';
  });
  canvas.addEventListener('click', (e) => {
    const p = pick(e);
    if (p && p.userData.hop <= 0) p.userData.hop = 1;
  });

  /* pointer and scroll steer the camera a little */
  let px = 0, py = 0, tx = 0, ty = 0;
  addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || reduced) return;
    tx = e.clientX / innerWidth - 0.5;
    ty = e.clientY / innerHeight - 0.5;
  }, { passive: true });
  const heroEl = canvas.closest('section') || canvas;

  let time = reduced ? 10 : 0;
  const wake = loop(canvas, (dt) => {
    fit(renderer, camera, canvas);
    time += dt;
    px += (tx - px) * Math.min(1, dt * 3);
    py += (ty - py) * Math.min(1, dt * 3);

    const sr = heroEl.getBoundingClientRect();
    const scroll = clamp01(-sr.top / Math.max(1, sr.height));
    const narrow = canvas.clientWidth < 700;

    // assembly
    tiles.forEach((t) => {
      const k = ease.back(clamp01((time - t.userData.delay) / 0.6));
      t.position.y = 0.06 - (1 - k) * 0.9;
      t.scale.set(Math.max(0.001, k), 1, Math.max(0.001, k));
    });
    const sk = ease.out(clamp01(time / 0.9));
    slab.scale.setScalar(0.85 + 0.15 * sk);
    Object.values(pieces).forEach((p) => {
      const d = p.userData;
      const k = clamp01((time - d.delay) / 0.55);
      if (k < 1) {
        p.position.y = 0.12 + (1 - ease.out(k)) * 3.2;
        p.scale.setScalar(0.84 * (0.4 + 0.6 * ease.back(k)));
        p.visible = k > 0;
      } else if (d.hop > 0) {
        d.hop = Math.max(0, d.hop - dt * 1.8);
        const t = 1 - d.hop;
        p.position.y = 0.12 + Math.sin(t * Math.PI) * 0.9;
        p.rotation.y += dt * 9 * Math.sin(t * Math.PI);
        const squash = t > 0.85 ? 1 - Math.sin((t - 0.85) / 0.15 * Math.PI) * 0.12 : 1;
        p.scale.set(0.84 / Math.sqrt(squash), 0.84 * squash, 0.84 / Math.sqrt(squash));
      } else if (p !== (moving && moving.p)) {
        p.position.y = 0.12;
        p.scale.setScalar(0.84);
      }
    });

    // the move loop starts once everything has landed
    if (!reduced && time > 2.2) {
      if (moving) {
        moving.t = Math.min(1, moving.t + dt / moving.dur);
        const k = ease.inOut(moving.t);
        moving.p.position.lerpVectors(moving.from, moving.to, k);
        moving.p.position.y = 0.12 + Math.sin(k * Math.PI) * moving.lift;
        if (moving.t >= 1) { moving = null; wait = 1.7; }
      } else if ((wait -= dt) <= 0) nextMove();
    }

    // camera on a sphere round the board
    const az = -0.32 + px * 0.22 + Math.sin(time * 0.12) * 0.05;
    const pol = (narrow ? 0.9 : 1.02) - py * 0.08 - scroll * 0.5;
    const rad = narrow ? 27 : 21;
    camera.position.set(Math.sin(az) * Math.sin(pol) * rad, Math.cos(pol) * rad, Math.cos(az) * Math.sin(pol) * rad);
    camera.lookAt(0, narrow ? -1.3 : 0.2, 0);
    board.rotation.y = scroll * 0.35;

    renderer.render(scene, camera);
    placeLabels();
  });
  addEventListener('resize', wake);
  canvas.classList.add('live');
}

/* ═══ TOUR: one piece at a time ══════════════════════════════════════════ */

const TOUR = [
  ['king', 'gold'], ['rook', 'coral'], ['bishop', 'iris'], ['knight', 'sky'], ['queen', 'rose'], ['pawn', 'mint']
];

function tour(canvas) {
  const { renderer, scene } = setup(canvas);
  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);
  keyLight(scene, 4);
  const rim = new THREE.PointLight(TONES.gold, 30, 12, 2);
  rim.position.set(2.5, 2.2, -2.5);
  scene.add(rim);

  const pedestal = new THREE.Mesh(
    new THREE.CylinderGeometry(1.35, 1.42, 0.28, 96),
    new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.08 })
  );
  pedestal.position.y = -0.14;
  pedestal.receiveShadow = true;
  pedestal.castShadow = true;
  scene.add(pedestal);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.39, 0.025, 12, 128), new THREE.MeshBasicMaterial({ color: TONES.gold }));
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.005;
  scene.add(ring);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.ShadowMaterial({ opacity: 0.1 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.28;
  floor.receiveShadow = true;
  scene.add(floor);

  const turntable = new THREE.Group();
  scene.add(turntable);
  const made = TOUR.map(([type, tone]) => {
    const p = makePiece(type, tone);
    p.scale.setScalar(1.75);
    p.visible = false;
    turntable.add(p);
    return p;
  });

  let current = -1, target = +(document.documentElement.dataset.tour || 0), swap = 1, outgoing = null;
  const colour = new THREE.Color(), want = new THREE.Color(TONES.gold);
  document.addEventListener('tour-step', (e) => { target = e.detail; });

  // drag to spin
  let spin = 0, vel = 0.35, dragging = false, lastX = 0;
  canvas.addEventListener('pointerdown', (e) => { dragging = true; lastX = e.clientX; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    vel = (e.clientX - lastX) * 0.6;
    spin += (e.clientX - lastX) * 0.012;
    lastX = e.clientX;
  });
  const release = () => { dragging = false; };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  let time = 0;
  const wake = loop(canvas, (dt) => {
    fit(renderer, camera, canvas);
    time += dt;
    if (target !== current && swap >= 1) {
      outgoing = made[current] || null;
      current = target;
      swap = 0;
      want.setHex(TONES[TOUR[current][1]]);
    }
    if (swap < 1) {
      swap = Math.min(1, swap + dt / (reduced ? 0.01 : 0.85));
      const kOut = clamp01(swap / 0.4), kIn = clamp01((swap - 0.3) / 0.7);
      if (outgoing) {
        outgoing.visible = kOut < 1;
        outgoing.scale.setScalar(1.75 * (1 - ease.inOut(kOut)));
        outgoing.position.y = -ease.inOut(kOut) * 0.6;
        outgoing.rotation.y = ease.inOut(kOut) * 2;
      }
      const p = made[current];
      p.visible = true;
      p.scale.setScalar(1.75 * Math.max(0.001, ease.back(kIn)));
      p.position.y = (1 - ease.out(kIn)) * 1.2;
      p.rotation.y = -(1 - ease.out(kIn)) * 3;
    }
    colour.copy(rim.color).lerp(want, Math.min(1, dt * 4));
    rim.color.copy(colour);
    ring.material.color.copy(colour);

    if (!dragging) { vel += (0.35 - vel) * Math.min(1, dt * 1.5); spin += vel * dt; }
    turntable.rotation.y = spin;
    const bob = reduced ? 0 : Math.sin(time * 1.4) * 0.04;
    turntable.position.y = bob;

    // far enough back that both the piece and the pedestal fit, whatever the shape
    const t = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const dist = Math.max(1.75 / t, 1.85 / (t * camera.aspect));
    camera.position.set(0, dist * 0.27, dist);
    camera.lookAt(0, 1.0, 0);
    renderer.render(scene, camera);
  });
  addEventListener('resize', wake);
  canvas.classList.add('live');
}

/* ═══ LINEUP: all six, standing in a row at the end of the page ═════════ */

function lineup(canvas) {
  const { renderer, scene } = setup(canvas);
  const camera = new THREE.PerspectiveCamera(22, 1, 0.1, 100);
  keyLight(scene, 6);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.ShadowMaterial({ opacity: 0.08 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const order = [['pawn', 'mint'], ['knight', 'sky'], ['bishop', 'iris'], ['king', 'gold'], ['queen', 'rose'], ['rook', 'coral']];
  const row = order.map(([type, tone], i) => {
    const p = makePiece(type, tone);
    p.position.x = (i - 2.5) * 1.15;
    if (type === 'knight') p.rotation.y = Math.PI - 0.5;
    p.userData.near = 0;
    scene.add(p);
    return p;
  });

  // the piece nearest the pointer stands up a little taller
  let pointerX = null;
  canvas.parentElement.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    pointerX = ((e.clientX - r.left) / r.width - 0.5) * 7.2;
  });
  canvas.parentElement.addEventListener('pointerleave', () => { pointerX = null; });

  let time = 0;
  const wake = loop(canvas, (dt) => {
    fit(renderer, camera, canvas);
    time += dt;
    row.forEach((p, i) => {
      const near = pointerX == null ? 0 : Math.max(0, 1 - Math.abs(pointerX - p.position.x) / 1.1);
      p.userData.near += (near - p.userData.near) * Math.min(1, dt * 8);
      const wave = reduced ? 0 : Math.max(0, Math.sin(time * 1.6 - i * 0.55)) * 0.16;
      p.position.y = wave + p.userData.near * 0.35;
      p.rotation.y += reduced ? 0 : dt * (0.25 + p.userData.near * 2);
    });
    const t = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const dist = Math.max(1.0 / t, 3.9 / (t * camera.aspect));
    camera.position.set(0, dist * 0.16, dist);
    camera.lookAt(0, 0.6, 0);
    renderer.render(scene, camera);
  });
  addEventListener('resize', wake);
}

/* ═══ boot ═══════════════════════════════════════════════════════════════ */

if (webgl()) {
  const h = document.getElementById('hero-canvas');
  const t = document.getElementById('tour-canvas');
  const l = document.getElementById('line-canvas');
  if (h) hero(h);
  if (t) tour(t);
  if (l) lineup(l);
} else {
  document.documentElement.classList.add('no-webgl');
}
