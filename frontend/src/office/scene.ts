// Office scenes — Skyline and Armillary — both generated from the live fleet. Any number of
// agents. Each agent gets a stable visual (derived from its name), so the scene does not reshuffle
// between reloads and a new agent simply appears. Ink/ember palette, drifting camera.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export interface FleetAgent {
  agent: string;
  initials: string;
  name: string;
  tasksToday: number;
  success: number;
  share: number;
  state: string;
}

export interface SceneController {
  dispose: () => void;
}

// The original skyline palette.
const EMBER = 0xe25822;
const SOFT = 0xf59e6b;
const INK = 0x1a1410;
const SPOTLIGHT = 0x00e5ff; // active/working — the cyan the original used for live work
const BRASS = 0x9a7448;

function isWorking(a: FleetAgent): boolean {
  return a.state === "EXECUTING" || a.state === "PROCESSING_NOW" || a.state === "TASK_IN_PROGRESS";
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967295; // 0..1
}

function isOrch(a: FleetAgent): boolean {
  return a.agent === "orchestrator" || /orchestrat/i.test(a.agent);
}

// Concentric-ring layout: fill the inner ring, expand to new rings as needed. baseR is the
// first ring radius, gap the spacing between rings, spacing the minimum arc between towers.
function ringLayout(n: number, baseR: number, gap: number, spacing: number): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  let placed = 0, ring = 0;
  while (placed < n) {
    const r = baseR + ring * gap;
    const cap = Math.max(1, Math.floor((2 * Math.PI * r) / spacing));
    const count = Math.min(cap, n - placed);
    const offset = ring * 0.4; // stagger rings so towers don't line up radially
    for (let i = 0; i < count; i++) {
      const ang = (i / count) * Math.PI * 2 + offset;
      out.push({ x: Math.cos(ang) * r, z: Math.sin(ang) * r });
    }
    placed += count;
    ring++;
  }
  return out;
}

function glowTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const x = c.getContext("2d")!;
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(255,190,140,1)");
  g.addColorStop(0.4, "rgba(226,88,34,0.5)");
  g.addColorStop(1, "rgba(226,88,34,0)");
  x.fillStyle = g;
  x.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

function labelSprite(text: string, glow: THREE.Texture, size = 0.5): THREE.Sprite {
  const c = document.createElement("canvas");
  c.width = 160; c.height = 80;
  const x = c.getContext("2d")!;
  x.font = "500 40px 'JetBrains Mono', monospace";
  x.textAlign = "center"; x.textBaseline = "middle";
  x.fillStyle = "rgba(247,240,225,0.85)";
  x.fillText(text, 80, 42);
  void glow;
  const m = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, depthTest: false });
  const s = new THREE.Sprite(m);
  s.scale.set(size * 2, size, 1);
  return s;
}

function glowSprite(tex: THREE.Texture, size: number, color: number, opacity: number): THREE.Sprite {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  s.scale.set(size, size, 1);
  return s;
}

function baseScene(canvas: HTMLCanvasElement): {
  renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera;
  controls: OrbitControls; resize: () => void;
} {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.25;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(INK);
  scene.fog = new THREE.FogExp2(INK, 0.012);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 400);

  // The original skyline controls: drag to orbit, scroll to zoom. A gentle auto-rotate runs
  // until the operator grabs it, then resumes after they let go.
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.5;
  controls.minDistance = 6;
  controls.maxDistance = 90;
  controls.maxPolarAngle = Math.PI * 0.49; // don't drop below the ground
  const resume = () => { window.setTimeout(() => { controls.autoRotate = true; }, 2500); };
  controls.addEventListener("start", () => { controls.autoRotate = false; });
  controls.addEventListener("end", resume);

  const resize = () => {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();
  return { renderer, scene, camera, controls, resize };
}

// ---------------------------------------------------------------------------
// Skyline — a tower per agent, HQ (orchestrator) at the centre.
// ---------------------------------------------------------------------------

export function buildSkyline(canvas: HTMLCanvasElement, fleet: FleetAgent[]): SceneController {
  const { renderer, scene, camera, controls, resize } = baseScene(canvas);
  const glow = glowTexture();
  camera.position.set(0, 8, 18);
  controls.target.set(0, 3, 0);

  scene.add(new THREE.AmbientLight(0x6a4a2c, 0.7));
  const key = new THREE.PointLight(EMBER, 3.4, 60); key.position.set(0, 12, 0); scene.add(key);
  const rim = new THREE.DirectionalLight(SOFT, 1.1); rim.position.set(-10, 14, 8); scene.add(rim);
  const fill = new THREE.DirectionalLight(0x8a5a3a, 0.6); fill.position.set(12, 8, -8); scene.add(fill);
  scene.add(new THREE.HemisphereLight(0x5a4230, 0x140d08, 0.6));

  // warm horizon glow so the towers read against a lit sky, like the original
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(140, 32, 16, 0, Math.PI * 2, Math.PI * 0.42, Math.PI * 0.2),
    new THREE.MeshBasicMaterial({ color: 0x6e3417, side: THREE.BackSide, fog: false }));
  scene.add(sky);
  const horizon = glowSprite(glow, 120, EMBER, 0.28); horizon.position.set(0, 0, -60); scene.add(horizon);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(400, 400),
    new THREE.MeshStandardMaterial({ color: 0x241811, roughness: 0.9, metalness: 0.15 }));
  ground.rotation.x = -Math.PI / 2; scene.add(ground);
  const grid = new THREE.GridHelper(80, 80, 0x2a1f17, 0x1a130d);
  (grid.material as THREE.Material).opacity = 0.35; (grid.material as THREE.Material).transparent = true;
  scene.add(grid);

  const maxTasks = Math.max(1, ...fleet.map((a) => a.tasksToday));
  const specialists = fleet.filter((a) => !isOrch(a));
  const orch = fleet.find(isOrch);

  interface Tower { mesh: THREE.Mesh; windows: THREE.Points; agent: FleetAgent; }
  const towers: Tower[] = [];

  function makeTower(a: FleetAgent, x: number, z: number, hq: boolean) {
    const h = (hq ? 4 : 2) + (a.tasksToday / maxTasks) * (hq ? 6 : 7);
    const w = hq ? 3.2 : 1.6 + hash(a.agent) * 0.8;
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, w),
      new THREE.MeshStandardMaterial({
        color: hq ? 0x3a2a1c : 0x2c2016, roughness: 0.7, metalness: 0.35,
        emissive: 0x1a0f08, emissiveIntensity: 0.6,
      }));
    body.position.set(x, h / 2, z);
    scene.add(body);

    // windows as a point cloud on the four faces; lit share ~ activity
    const cols = Math.max(3, Math.round(w * 3));
    const rows = Math.max(5, Math.round(h * 2.2));
    const pts: number[] = [];
    const colors: number[] = [];
    const working = isWorking(a);
    const litShare = working ? 0.92 : 0.4 + (a.tasksToday / maxTasks) * 0.4;
    // original palette: cyan spotlight when the agent is live, ember otherwise. Brighter than
    // the face colour so tone mapping makes them glow.
    const cLit = new THREE.Color(working ? SPOTLIGHT : hq ? EMBER : SOFT).multiplyScalar(1.6);
    const cDark = new THREE.Color(0x5a3f28);
    for (let f = 0; f < 4; f++) {
      const ang = (f / 4) * Math.PI * 2;
      const nx = Math.cos(ang), nz = Math.sin(ang);
      for (let ci = 0; ci < cols; ci++) {
        for (let ri = 0; ri < rows; ri++) {
          const u = (ci / (cols - 1) - 0.5) * (w * 0.8);
          const vy = 0.6 + (ri / rows) * (h - 1);
          const px = x + nx * (w / 2 + 0.02) - nz * u;
          const pz = z + nz * (w / 2 + 0.02) + nx * u;
          pts.push(px, vy, pz);
          const on = hash(`${a.agent}-${f}-${ci}-${ri}`) < litShare;
          const col = on ? cLit : cDark;
          colors.push(col.r, col.g, col.b);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    const windows = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 0.2, vertexColors: true, transparent: true, opacity: 1,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    }));
    scene.add(windows);

    if (hq || working) {
      const g = glowSprite(glow, hq ? 5 : 3, working ? SPOTLIGHT : EMBER, working ? 0.7 : 0.5);
      g.position.set(x, h + 0.5, z); scene.add(g);
    }
    const lb = labelSprite(a.initials, glow, hq ? 0.6 : 0.44);
    lb.position.set(x, h + (hq ? 1.1 : 0.7), z);
    scene.add(lb);

    towers.push({ mesh: body, windows, agent: a });
  }

  if (orch) makeTower(orch, 0, 0, true);

  // Auto-arrange into concentric rings: fill the inner ring, then expand outward. Each ring
  // holds as many towers as its circumference allows, so the city grows to any agent count.
  const positions = ringLayout(specialists.length, 7, 5, 4.6);
  specialists.forEach((a, i) => makeTower(a, positions[i].x, positions[i].z, false));
  const R = positions.length ? Math.max(...positions.map((p) => Math.hypot(p.x, p.z))) : 7;

  camera.position.set(0, 8, R + 14);
  let raf = 0;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced) controls.autoRotate = false;
  function loop() {
    controls.update();
    renderer.render(scene, camera);
    raf = requestAnimationFrame(loop);
  }
  raf = requestAnimationFrame(loop);
  window.addEventListener("resize", resize);

  return {
    dispose() {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      controls.dispose();
      renderer.dispose();
      scene.traverse((o) => {
        const any = o as unknown as { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] };
        any.geometry?.dispose?.();
        const m = any.material;
        if (Array.isArray(m)) m.forEach((x) => x.dispose()); else m?.dispose?.();
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Armillary — brass rings at real inclinations, orchestrator as the core.
// ---------------------------------------------------------------------------

export function buildArmillary(canvas: HTMLCanvasElement, fleet: FleetAgent[]): SceneController {
  const { renderer, scene, camera, controls, resize } = baseScene(canvas);
  const glow = glowTexture();
  camera.position.set(0, 3, 14);
  controls.target.set(0, 0, 0);
  controls.autoRotateSpeed = 0.8;

  scene.add(new THREE.AmbientLight(0x3a2a1c, 0.7));
  const core = new THREE.PointLight(0xffa265, 4.5, 50); scene.add(core);

  const sun = new THREE.Mesh(new THREE.SphereGeometry(0.62, 32, 32),
    new THREE.MeshBasicMaterial({ color: 0xffc79a, toneMapped: false }));
  scene.add(sun);
  const sunGlow = glowSprite(glow, 5.6, 0xf08040, 0.9); scene.add(sunGlow);
  const orch = fleet.find(isOrch);
  if (orch) { const l = labelSprite(orch.initials, glow, 0.5); l.position.set(0, 1.1, 0); scene.add(l); }

  const brass = { color: BRASS, metalness: 0.95, roughness: 0.3 } as const;
  [[0, 0, 0], [Math.PI / 2, 0, 0], [0, 0, Math.PI / 2]].forEach((r) => {
    const m = new THREE.Mesh(new THREE.TorusGeometry(5.4, 0.035, 10, 160), new THREE.MeshStandardMaterial(brass));
    m.rotation.set(r[0], r[1], r[2]); scene.add(m);
  });

  const specialists = fleet.filter((a) => !isOrch(a));
  const maxTasks = Math.max(1, ...specialists.map((a) => a.tasksToday));

  interface Body { pivot: THREE.Object3D; body: THREE.Mesh; bglow: THREE.Sprite; label: THREE.Sprite; R: number; spd: number; ph: number; }
  const bodies: Body[] = [];

  specialists.forEach((a, i) => {
    const R = 1.7 + i * 0.62;
    const pivot = new THREE.Object3D();
    pivot.rotation.set(1.05 + hash(a.agent) * 0.8, hash(a.agent + "y") * 6.28, hash(a.agent + "z") * 1.2);
    scene.add(pivot);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(R, 0.02, 8, 140), new THREE.MeshStandardMaterial(brass));
    pivot.add(ring);
    const rad = 0.13 + Math.sqrt(Math.max(0, a.share)) * 0.1;
    const working = isWorking(a);
    const active = working || a.tasksToday > 0;
    // cyan spotlight when live, warm ember when merely active, dim when never run
    const bodyColor = working ? SPOTLIGHT : active ? SOFT : 0x5a4838;
    const body = new THREE.Mesh(new THREE.SphereGeometry(rad, 24, 24), new THREE.MeshStandardMaterial({
      color: bodyColor, emissive: working ? 0x0a4a55 : active ? 0x7a3818 : 0x000000,
      roughness: 0.55, metalness: 0.25,
    }));
    pivot.add(body);
    const bglow = glowSprite(glow, rad * 5, working ? SPOTLIGHT : active ? SOFT : 0x6b5847, active ? 0.55 : 0.18);
    pivot.add(bglow);
    const label = labelSprite(a.initials, glow, 0.34); pivot.add(label);
    bodies.push({ pivot, body, bglow, label, R, spd: 0.1 + (a.tasksToday / maxTasks) * 0.42, ph: i * 1.1 });
  });

  let raf = 0; let t0 = 0;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced) controls.autoRotate = false;
  function loop(ms: number) {
    if (!t0) t0 = ms;
    const t = (ms - t0) / 1000;
    const s = 1 + Math.sin(t * 2.1) * 0.05; sun.scale.setScalar(s); sunGlow.scale.setScalar(5.6 * s);
    bodies.forEach((b) => {
      const ang = b.ph + (reduced ? 0 : t * b.spd);
      const px = Math.cos(ang) * b.R, py = Math.sin(ang) * b.R;
      b.body.position.set(px, py, 0);
      b.bglow.position.set(px, py, 0);
      b.label.position.set(px, py + 0.4, 0);
    });
    controls.update();
    renderer.render(scene, camera);
    raf = requestAnimationFrame(loop);
  }
  raf = requestAnimationFrame(loop);
  window.addEventListener("resize", resize);

  return {
    dispose() {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      controls.dispose();
      renderer.dispose();
      scene.traverse((o) => {
        const any = o as unknown as { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] };
        any.geometry?.dispose?.();
        const m = any.material;
        if (Array.isArray(m)) m.forEach((x) => x.dispose()); else m?.dispose?.();
      });
    },
  };
}
