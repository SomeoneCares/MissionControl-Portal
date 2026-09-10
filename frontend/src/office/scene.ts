// Office scenes — Skyline and Armillary — both generated from the live fleet. Any number of
// agents. Each agent gets a stable visual (derived from its name), so the scene does not reshuffle
// between reloads and a new agent simply appears. Ink/ember palette, drifting camera.

import * as THREE from "three";

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

const EMBER = 0xe25822;
const SOFT = 0xf59e6b;
const BRASS = 0x9a7448;

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
  renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; resize: () => void;
} {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0e0a06);
  scene.fog = new THREE.FogExp2(0x0e0a06, 0.032);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 220);
  const resize = () => {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();
  return { renderer, scene, camera, resize };
}

// ---------------------------------------------------------------------------
// Skyline — a tower per agent, HQ (orchestrator) at the centre.
// ---------------------------------------------------------------------------

export function buildSkyline(canvas: HTMLCanvasElement, fleet: FleetAgent[]): SceneController {
  const { renderer, scene, camera, resize } = baseScene(canvas);
  const glow = glowTexture();
  camera.position.set(0, 7, 15);

  scene.add(new THREE.AmbientLight(0x40301f, 0.6));
  const key = new THREE.PointLight(EMBER, 2.2, 40); key.position.set(0, 8, 0); scene.add(key);
  scene.add(new THREE.HemisphereLight(0x40301f, 0x0a0705, 0.5));

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(120, 120),
    new THREE.MeshStandardMaterial({ color: 0x120d09, roughness: 0.96 }));
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
      new THREE.MeshStandardMaterial({ color: hq ? 0x241a13 : 0x1d160f, roughness: 0.85, metalness: 0.2 }));
    body.position.set(x, h / 2, z);
    scene.add(body);

    // windows as a point cloud on the four faces; lit share ~ activity
    const cols = Math.max(2, Math.round(w * 2));
    const rows = Math.max(3, Math.round(h * 1.6));
    const pts: number[] = [];
    const colors: number[] = [];
    const lit = a.state === "EXECUTING" || a.state === "PROCESSING_NOW" || a.state === "TASK_IN_PROGRESS";
    const litShare = lit ? 0.85 : 0.18 + (a.tasksToday / maxTasks) * 0.4;
    const cLit = new THREE.Color(hq ? EMBER : SOFT);
    const cDark = new THREE.Color(0x3a2c20);
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
      size: 0.14, vertexColors: true, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    scene.add(windows);

    if (hq) { const g = glowSprite(glow, 5, EMBER, 0.5); g.position.set(x, h + 0.5, z); scene.add(g); }
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

  let raf = 0; let t0 = 0;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  function loop(ms: number) {
    if (!t0) t0 = ms;
    const t = (ms - t0) / 1000;
    const rad = R + 10;
    camera.position.set(Math.sin(t * 0.06) * rad, 7 + Math.sin(t * 0.12) * 1.5, Math.cos(t * 0.06) * rad);
    camera.lookAt(0, 3, 0);
    renderer.render(scene, camera);
    if (!reduced) raf = requestAnimationFrame(loop);
  }
  raf = requestAnimationFrame(loop);
  window.addEventListener("resize", resize);

  return {
    dispose() {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
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
  const { renderer, scene, camera, resize } = baseScene(canvas);
  scene.background = new THREE.Color(0x0c0906);
  scene.fog = new THREE.FogExp2(0x0c0906, 0.03);
  const glow = glowTexture();
  camera.position.set(0, 3, 13);

  scene.add(new THREE.AmbientLight(0x3a2a1c, 0.6));
  const core = new THREE.PointLight(0xffa265, 3.0, 40); scene.add(core);

  const sun = new THREE.Mesh(new THREE.SphereGeometry(0.62, 32, 32), new THREE.MeshBasicMaterial({ color: 0xffb37a }));
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
    const lit = a.tasksToday > 0;
    const body = new THREE.Mesh(new THREE.SphereGeometry(rad, 24, 24), new THREE.MeshStandardMaterial({
      color: lit ? SOFT : 0x5a4838, emissive: lit ? 0x7a3818 : 0x000000, roughness: 0.55, metalness: 0.25,
    }));
    pivot.add(body);
    const bglow = glowSprite(glow, rad * 5, lit ? SOFT : 0x6b5847, lit ? 0.55 : 0.18); pivot.add(bglow);
    const label = labelSprite(a.initials, glow, 0.34); pivot.add(label);
    bodies.push({ pivot, body, bglow, label, R, spd: 0.1 + (a.tasksToday / maxTasks) * 0.42, ph: i * 1.1 });
  });

  let raf = 0; let t0 = 0;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  function loop(ms: number) {
    if (!t0) t0 = ms;
    const t = (ms - t0) / 1000;
    camera.position.set(Math.sin(t * 0.085) * 12, 2.4 + Math.sin(t * 0.16) * 1.6, Math.cos(t * 0.085) * 12);
    camera.lookAt(0, 0, 0);
    const s = 1 + Math.sin(t * 2.1) * 0.05; sun.scale.setScalar(s); sunGlow.scale.setScalar(5.6 * s);
    bodies.forEach((b) => {
      const ang = b.ph + t * b.spd;
      const px = Math.cos(ang) * b.R, py = Math.sin(ang) * b.R;
      b.body.position.set(px, py, 0);
      b.bglow.position.set(px, py, 0);
      b.label.position.set(px, py + 0.4, 0);
    });
    renderer.render(scene, camera);
    if (!reduced) raf = requestAnimationFrame(loop);
  }
  raf = requestAnimationFrame(loop);
  window.addEventListener("resize", resize);

  return {
    dispose() {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
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
