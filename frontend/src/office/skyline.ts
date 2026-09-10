// Faithful port of the original Hermes office skyline — same scene, buildings, silhouettes,
// instanced windows, rooftop monuments, cars, lamps, clouds, DOM labels, hover-lift and
// click-select — generated for any number of agents instead of a hardcoded five.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { FleetAgent, SceneController, SceneOpts } from "./scene";

const EMBER = "#e25822";
const EMBER_SOFT = "#f59e6b";
const INK = "#1a1410";
const INK_2 = "#241a13";
const SPOTLIGHT = "#00e5ff";

type Sil = "stepped" | "twin" | "slab" | "tower";
type Mon = "conductor" | "scout" | "scribe" | "herald" | "smith";

interface Spec {
  code: string; name: string; role: string; state: string; hq: boolean;
  position: [number, number, number]; size: [number, number, number];
  floors: number; windowCols: number; silhouette: Sil; monument: Mon; accent: string;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967295;
}
function isOrch(a: FleetAgent) { return a.agent === "orchestrator" || /orchestrat/i.test(a.agent); }

// Expanding concentric rings — fill the inner ring, then grow outward.
function ringLayout(n: number, baseR: number, gap: number, spacing: number): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  let placed = 0, ring = 0;
  while (placed < n) {
    const r = baseR + ring * gap;
    const cap = Math.max(1, Math.floor((2 * Math.PI * r) / spacing));
    const count = Math.min(cap, n - placed);
    const off = ring * 0.4;
    for (let i = 0; i < count; i++) {
      const ang = (i / count) * Math.PI * 2 + off;
      out.push({ x: Math.cos(ang) * r, z: Math.sin(ang) * r });
    }
    placed += count; ring++;
  }
  return out;
}

function specs(fleet: FleetAgent[]): Spec[] {
  const maxTasks = Math.max(1, ...fleet.map((a) => a.tasksToday));
  const orch = fleet.find(isOrch);
  const specialists = fleet.filter((a) => !isOrch(a));
  const out: Spec[] = [];
  if (orch) {
    out.push({
      code: orch.agent, name: orch.name, role: orch.role || "Orchestrator", state: orch.state,
      hq: true, position: [0, 0, 0], size: [3.6, 6.4, 3.6], floors: 15, windowCols: 6,
      silhouette: "stepped", monument: "conductor", accent: EMBER,
    });
  }
  const SIL: Sil[] = ["tower", "slab", "twin", "tower"];
  const MON: Mon[] = ["scout", "scribe", "herald", "smith"];
  const pos = ringLayout(specialists.length, 8, 6.5, 6.2);
  specialists.forEach((a, i) => {
    const hs = hash(a.agent);
    const load = a.tasksToday / maxTasks;
    out.push({
      code: a.agent, name: a.name, role: a.role || a.agent, state: a.state, hq: false,
      position: [pos[i].x, 0, pos[i].z],
      size: [2.4 + hs * 0.6, 3.6 + load * 3.2, 2.3 + hs * 0.5],
      floors: 8 + Math.round(load * 9),
      windowCols: 4 + Math.round(hs * 2),
      silhouette: SIL[Math.floor(hash(a.agent + "s") * SIL.length)],
      monument: MON[Math.floor(hash(a.agent + "m") * MON.length)],
      accent: EMBER,
    });
  });
  return out;
}

export function buildSkyline(canvas: HTMLCanvasElement, fleet: FleetAgent[], opts: SceneOpts = {}): SceneController {
  const wrap = canvas.parentElement!;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.6));
  renderer.setSize(wrap.clientWidth, wrap.clientHeight, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#120c08");
  scene.fog = new THREE.Fog("#120c08", 26, 70);

  const camera = new THREE.PerspectiveCamera(38, wrap.clientWidth / wrap.clientHeight, 0.1, 300);
  camera.position.set(18, 13, 18);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enablePan = false; controls.enableDamping = true; controls.dampingFactor = 0.08;
  controls.minDistance = 10; controls.maxDistance = 60;
  controls.minPolarAngle = Math.PI / 6; controls.maxPolarAngle = Math.PI / 2.25;
  controls.autoRotate = true; controls.autoRotateSpeed = 0.45;

  scene.add(new THREE.AmbientLight("#f3c79a", 0.35));
  const d1 = new THREE.DirectionalLight("#f59e6b", 0.9); d1.position.set(-12, 14, 6); scene.add(d1);
  const d2 = new THREE.DirectionalLight("#8a5a3a", 0.35); d2.position.set(10, 8, -10); scene.add(d2);

  const sky = new THREE.Mesh(new THREE.SphereGeometry(120, 32, 32),
    new THREE.MeshBasicMaterial({ side: THREE.BackSide, color: "#1a1410" }));
  scene.add(sky);
  const horizon = new THREE.Mesh(
    new THREE.SphereGeometry(105, 32, 16, 0, Math.PI * 2, Math.PI * 0.4, Math.PI * 0.18),
    new THREE.MeshBasicMaterial({ side: THREE.BackSide, color: EMBER, toneMapped: false, transparent: true, opacity: 0.35 }));
  horizon.position.y = -2; scene.add(horizon);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200),
    new THREE.MeshStandardMaterial({ color: INK_2, roughness: 0.95 }));
  ground.rotation.x = -Math.PI / 2; scene.add(ground);
  const disc = new THREE.Mesh(new THREE.CircleGeometry(6, 64),
    new THREE.MeshStandardMaterial({ color: "#2a1f17", roughness: 0.8 }));
  disc.rotation.x = -Math.PI / 2; disc.position.y = 0.005; scene.add(disc);
  const ring = new THREE.Mesh(new THREE.RingGeometry(5.6, 5.85, 96),
    new THREE.MeshBasicMaterial({ color: EMBER, toneMapped: false, transparent: true, opacity: 0.55 }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.012; scene.add(ring);

  const built = specs(fleet);
  const specialists = built.filter((s) => !s.hq);

  // streets + lamps + cars, one radial per specialist
  const lampMat = new THREE.MeshStandardMaterial({ color: INK_2 });
  const lampGlow = new THREE.MeshStandardMaterial({ color: "#000", emissive: new THREE.Color(EMBER_SOFT), emissiveIntensity: 3.2, toneMapped: false });
  const carMat = new THREE.MeshStandardMaterial({ color: "#000", emissive: new THREE.Color(EMBER), emissiveIntensity: 3.5, toneMapped: false });
  const cars: THREE.Mesh[] = [];
  specialists.forEach((a, i) => {
    const dx = a.position[0], dz = a.position[2];
    const len = Math.hypot(dx, dz);
    const angle = Math.atan2(dx, dz);
    const street = new THREE.Mesh(new THREE.PlaneGeometry(1.2, len), new THREE.MeshStandardMaterial({ color: "#1f1611", roughness: 0.9 }));
    street.rotation.x = -Math.PI / 2; street.rotation.z = -angle; street.position.set(dx / 2, 0.008, dz / 2);
    scene.add(street);
    [0.35, 0.7].forEach((tp) => {
      const g = new THREE.Group();
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.2, 8), lampMat); post.position.y = 0.6; g.add(post);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 12), lampGlow); bulb.position.y = 1.25; g.add(bulb);
      const pl = new THREE.PointLight(EMBER_SOFT, 1.6, 4); pl.position.y = 1.25; g.add(pl);
      g.position.set(dx * tp + 0.7, 0, dz * tp); scene.add(g);
    });
    const from = new THREE.Vector3(dx * 0.55, 0.08, dz * 0.55);
    const center = new THREE.Vector3(0, 0.08, 0);
    const to = new THREE.Vector3(dx * 0.1, 0.08, dz * 0.1);
    const end = new THREE.Vector3(dx, 0.08, dz);
    ([[from, center], [to, end]] as [THREE.Vector3, THREE.Vector3][]).forEach((path, k) => {
      const car = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.08, 0.12), carMat);
      car.position.copy(path[0]);
      car.userData = { path, speed: 0.18 + ((i * 2 + k) % 3) * 0.05, offset: (i * 2 + k) * 0.13 };
      scene.add(car); cars.push(car);
    });
  });

  const clouds: THREE.Mesh[] = [];
  function addCloud(pos: [number, number, number], radius: number, color: string, opacity: number, floatIntensity: number, speed: number) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(radius, 16, 16), new THREE.MeshBasicMaterial({ color, transparent: true, opacity }));
    m.position.set(...pos); m.userData = { baseY: pos[1], floatIntensity, speed }; scene.add(m); clouds.push(m);
  }
  addCloud([-10, 10, -8], 2.2, "#2a1d14", 0.6, 1.2, 0.6);
  addCloud([11, 12, -6], 3.0, "#1f160f", 0.55, 1.4, 0.5);

  function buildShell(a: Spec): THREE.Group {
    const [w, h, d] = a.size;
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: INK, roughness: 0.55, metalness: 0.25 });
    const acc = new THREE.Color(a.accent);
    const trim = new THREE.MeshStandardMaterial({ color: INK_2, emissive: acc.clone(), emissiveIntensity: 0.4, toneMapped: false });
    if (a.silhouette === "stepped") {
      const m1 = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m1.position.y = h / 2; g.add(m1);
      const m2 = new THREE.Mesh(new THREE.BoxGeometry(w * 0.7, 0.7, d * 0.7), mat); m2.position.y = h + 0.35; g.add(m2);
      const m3 = new THREE.Mesh(new THREE.BoxGeometry(w * 0.45, 0.5, d * 0.45), mat); m3.position.y = h + 0.8; g.add(m3);
      const tm = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 1.0, 0.1, 24), new THREE.MeshStandardMaterial({ color: INK_2, emissive: acc.clone(), emissiveIntensity: 0.5, toneMapped: false }));
      tm.position.y = h + 1.1; g.add(tm);
    } else if (a.silhouette === "twin") {
      const m1 = new THREE.Mesh(new THREE.BoxGeometry(w * 0.45, h, d), mat); m1.position.set(-w * 0.27, h / 2, 0); g.add(m1);
      const m2 = new THREE.Mesh(new THREE.BoxGeometry(w * 0.45, h + 1.2, d), mat); m2.position.set(w * 0.27, h / 2 + 0.6, 0); g.add(m2);
      const bridge = new THREE.Mesh(new THREE.BoxGeometry(w * 0.7, 0.18, d * 0.5), new THREE.MeshStandardMaterial({ color: INK_2, emissive: acc.clone(), emissiveIntensity: 0.4, toneMapped: false }));
      bridge.position.y = h * 0.55; g.add(bridge);
    } else if (a.silhouette === "slab") {
      const m1 = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m1.position.y = h / 2; g.add(m1);
      const cap = new THREE.Mesh(new THREE.BoxGeometry(w + 0.2, 0.3, d + 0.2), new THREE.MeshStandardMaterial({ color: INK_2, emissive: acc.clone(), emissiveIntensity: 0.35, toneMapped: false }));
      cap.position.y = h + 0.15; g.add(cap);
    } else {
      const m1 = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m1.position.y = h / 2; g.add(m1);
      const cap = new THREE.Mesh(new THREE.BoxGeometry(w + 0.15, 0.16, d + 0.15), trim); cap.position.y = h + 0.08; g.add(cap);
    }
    return g;
  }

  interface Inst { pos: THREE.Vector3; rot: THREE.Euler; seed: number; }
  function buildWindows(a: Spec): THREE.InstancedMesh {
    const [w, h, d] = a.size;
    const yStep = h / (a.floors + 1);
    const yStart = a.silhouette === "stepped" ? yStep : -h / 2 + yStep;
    const list: Inst[] = [];
    const xStepFB = w / (a.windowCols + 1);
    for (let f = 0; f < a.floors; f++) for (let c = 0; c < a.windowCols; c++) {
      const x = -w / 2 + (c + 1) * xStepFB; const y = yStart + f * yStep;
      list.push({ pos: new THREE.Vector3(x, y, d / 2 + 0.01), rot: new THREE.Euler(0, 0, 0), seed: Math.random() });
      list.push({ pos: new THREE.Vector3(x, y, -d / 2 - 0.01), rot: new THREE.Euler(0, Math.PI, 0), seed: Math.random() });
    }
    const sideCols = Math.max(2, Math.round(a.windowCols * (d / Math.max(w, 0.001))));
    const zStepLR = d / (sideCols + 1);
    for (let f = 0; f < a.floors; f++) for (let c = 0; c < sideCols; c++) {
      const z = -d / 2 + (c + 1) * zStepLR; const y = yStart + f * yStep;
      list.push({ pos: new THREE.Vector3(w / 2 + 0.01, y, z), rot: new THREE.Euler(0, Math.PI / 2, 0), seed: Math.random() });
      list.push({ pos: new THREE.Vector3(-w / 2 - 0.01, y, z), rot: new THREE.Euler(0, -Math.PI / 2, 0), seed: Math.random() });
    }
    const accent = new THREE.Color(a.accent);
    const mesh = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshStandardMaterial({ color: "#000", emissive: accent.clone(), emissiveIntensity: 1.8, toneMapped: false, side: THREE.DoubleSide }),
      list.length);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(list.length * 3), 3);
    mesh.userData = { instances: list, accent, dim: accent.clone().multiplyScalar(0.2), state: a.state };
    return mesh;
  }

  function stateIntensity(state: string, seed: number, t: number): number {
    if (state === "EXECUTING" || state === "PROCESSING_NOW" || state === "TASK_IN_PROGRESS") return 0.85 + 0.15 * Math.sin(t * 2 + seed * 6.28);
    if (state === "THINKING") { const on = (seed * 17) % 1 > 0.4 ? 1 : 0; return on * (0.55 + 0.25 * Math.sin(t * 1.1 + seed * 4)); }
    if (state === "RETRY") { const fl = Math.sin(t * 18 + seed * 9); const on = (seed * 13) % 1 > 0.55 ? 1 : 0; return on * (0.5 + 0.5 * (fl > 0 ? 1 : 0.2)); }
    const on = (seed * 31) % 1 > 0.82 ? 1 : 0; return on * 0.35; // IDLE
  }

  function stone() { return new THREE.MeshStandardMaterial({ color: "#e8d8b4", roughness: 0.7, metalness: 0.05 }); }
  function stoneDark() { return new THREE.MeshStandardMaterial({ color: "#a8946f", roughness: 0.8 }); }
  function buildMonument(a: Spec): THREE.Group {
    const g = new THREE.Group();
    const acc = new THREE.Color(a.accent);
    const sm = stone(), sd = stoneDark();
    const glow = (i = 3.2) => new THREE.MeshStandardMaterial({ color: "#000", emissive: acc.clone(), emissiveIntensity: i, toneMapped: false });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.95, 0.24, 24), new THREE.MeshStandardMaterial({ color: "#3a2b20", roughness: 0.85 }));
    base.position.y = 0.12; g.add(base);
    const trim = new THREE.Mesh(new THREE.TorusGeometry(0.82, 0.025, 12, 48), new THREE.MeshStandardMaterial({ color: "#000", emissive: acc.clone(), emissiveIntensity: 2.6, toneMapped: false }));
    trim.position.y = 0.26; trim.rotation.x = Math.PI / 2; g.add(trim);
    const slab = new THREE.Mesh(new THREE.CylinderGeometry(0.78, 0.78, 0.08, 24), new THREE.MeshStandardMaterial({ color: "#5a4232", roughness: 0.8 }));
    slab.position.y = 0.32; g.add(slab);
    const pl = new THREE.PointLight(a.accent, 2.4, 4.5); pl.position.y = 0.55; g.add(pl);
    const fig = new THREE.Group();
    const sphere = (r: number, y: number, x = 0, z = 0) => { const m = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 16), sm); m.position.set(x, y, z); return m; };
    const cone = (r: number, hh: number, y: number) => { const m = new THREE.Mesh(new THREE.ConeGeometry(r, hh, 16), sm); m.position.set(0, y, 0); return m; };
    if (a.monument === "conductor") {
      fig.add(cone(0.42, 0.85, 0.72)); fig.add(sphere(0.26, 1.18)); fig.add(sphere(0.20, 1.50));
      const crown = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.03, 8, 24), glow(3)); crown.position.set(0, 1.66, 0); crown.rotation.x = Math.PI / 2; fig.add(crown);
      const a1 = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.4, 6, 12), sm); a1.position.set(-0.28, 1.3, 0); a1.rotation.z = 0.9; fig.add(a1);
      const a2 = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.4, 6, 12), sm); a2.position.set(0.28, 1.3, 0); a2.rotation.z = -0.9; fig.add(a2);
      const baton = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.6, 8), glow(4)); baton.position.set(0.73, 1.62, 0); baton.rotation.z = -0.4; fig.add(baton);
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 12), glow(5)); tip.position.set(0.9, 1.75, 0); fig.add(tip);
    } else if (a.monument === "scout") {
      fig.add(sphere(0.32, 0.68)); fig.add(sphere(0.20, 1.02, 0.12, 0.05));
      const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.04, 16), sd); brim.position.set(0.12, 1.18, 0.05); fig.add(brim);
      const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.32, 6, 12), sm); arm.position.set(0.32, 1.0, 0.2); arm.rotation.z = -0.5; fig.add(arm);
      const spy = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.08, 0.38, 16), glow(4.5)); spy.position.set(0.5, 1.05, 0.32); spy.rotation.set(0, 0.4, Math.PI / 2); fig.add(spy);
      const lens = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 12), glow(5)); lens.position.set(0.66, 1.07, 0.4); fig.add(lens);
    } else if (a.monument === "scribe") {
      fig.add((() => { const m = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.55, 0.55, 20), sm); m.position.set(0, 0.6, 0); return m; })());
      fig.add(sphere(0.32, 1.05, 0, -0.05)); fig.add(sphere(0.22, 1.42, 0, -0.05));
      const book = new THREE.Group(); book.position.set(0, 0.95, 0.32); book.rotation.x = -0.4;
      book.add(new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.06, 0.4), sd));
      book.add((() => { const m = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.02, 0.38), glow(3.4)); m.position.set(0, 0.04, 0); return m; })());
      fig.add(book);
      const quill = new THREE.Mesh(new THREE.ConeGeometry(0.025, 0.4, 8), glow(3)); quill.position.set(0.35, 1.18, 0.35); quill.rotation.z = -0.6; fig.add(quill);
    } else if (a.monument === "herald") {
      fig.add(cone(0.38, 0.85, 0.72)); fig.add(sphere(0.26, 1.18)); fig.add(sphere(0.20, 1.5));
      const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.35, 6, 12), sm); arm.position.set(0.18, 1.32, 0.18); arm.rotation.set(-0.6, 0.4, 0); fig.add(arm);
      const trumpet = new THREE.Group(); trumpet.position.set(0.25, 1.46, 0.4); trumpet.rotation.set(-Math.PI / 2.6, 0, -0.2);
      trumpet.add(new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.55, 12), glow(4)));
      trumpet.add((() => { const m = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.24, 16, 1, true), glow(5)); m.position.set(0, 0.36, 0); return m; })());
      fig.add(trumpet);
    } else {
      fig.add(cone(0.4, 0.85, 0.7)); fig.add(sphere(0.28, 1.2)); fig.add(sphere(0.22, 1.55));
      const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.45, 6, 12), sm); arm.position.set(-0.3, 1.15, 0); arm.rotation.z = 0.3; fig.add(arm);
      const arm2 = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.5, 6, 12), sm); arm2.position.set(0.18, 1.5, 0); arm2.rotation.z = -1.4; fig.add(arm2);
      const wrench = new THREE.Group(); wrench.position.set(0.32, 2.0, 0);
      wrench.add(new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.55, 10), glow(4)));
      wrench.add((() => { const m = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.12, 0.08), glow(5)); m.position.set(0, 0.32, 0); return m; })());
      fig.add(wrench);
    }
    g.add(fig);
    return g;
  }

  const monumentMountY = (a: Spec) => ({ stepped: a.size[1] + 1.15, twin: a.size[1] + 1.2, slab: a.size[1] + 0.3, tower: a.size[1] + 0.16 }[a.silhouette]);
  const monumentMountX = (a: Spec) => (a.silhouette === "twin" ? a.size[0] * 0.27 : 0);

  // label overlay
  const labelLayer = document.createElement("div");
  labelLayer.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:5;overflow:hidden;";
  wrap.appendChild(labelLayer);

  interface Built { a: Spec; root: THREE.Group; inner: THREE.Group; windows: THREE.InstancedMesh; halo: THREE.Mesh; label: HTMLDivElement; accentMats: THREE.MeshStandardMaterial[]; }
  const buildings: Built[] = [];
  built.forEach((a) => {
    const root = new THREE.Group(); root.position.set(...a.position);
    const shell = buildShell(a); const windows = buildWindows(a); const monument = buildMonument(a);
    monument.position.set(monumentMountX(a), monumentMountY(a), 0);
    const rad = Math.max(a.size[0], a.size[2]);
    const halo = new THREE.Mesh(new THREE.RingGeometry(rad * 0.7, rad * 0.85, 64),
      new THREE.MeshBasicMaterial({ color: a.accent, transparent: true, opacity: 0.85, toneMapped: false }));
    halo.rotation.x = -Math.PI / 2; halo.position.y = 0.02; halo.visible = false;
    const inner = new THREE.Group(); inner.add(shell); inner.add(windows); inner.add(monument);
    root.add(inner); root.add(halo);
    shell.traverse((o) => { o.userData.code = a.code; });
    (windows as THREE.Object3D).userData.code = a.code;

    const label = document.createElement("div");
    label.style.cssText = "position:absolute;transform:translate(-50%,-50%);white-space:nowrap;text-align:center;pointer-events:none;";
    label.innerHTML = `<div style="font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.25em;text-transform:uppercase;color:rgba(247,240,225,.6)">${a.hq ? "Hermes · HQ" : a.role}</div>`
      + `<div style="font-family:'Instrument Serif',serif;color:#f7f0e1;font-size:16px;line-height:1;margin-top:2px;text-shadow:0 2px 8px rgba(0,0,0,.6)">${a.name}</div>`;
    labelLayer.appendChild(label);

    const accentMats: THREE.MeshStandardMaterial[] = [];
    root.traverse((o) => {
      if (o === windows) return;
      const anyO = o as unknown as { material?: THREE.Material | THREE.Material[] };
      const ms = anyO.material ? (Array.isArray(anyO.material) ? anyO.material : [anyO.material]) : [];
      ms.forEach((m) => { const sm2 = m as THREE.MeshStandardMaterial; if (sm2 && sm2.emissive && sm2.emissive.getHex() !== 0) accentMats.push(sm2); });
    });
    buildings.push({ a, root, inner, windows, halo, label, accentMats });
    scene.add(root);
  });

  const WORK_COL = new THREE.Color(SPOTLIGHT), IDLE_COL = new THREE.Color(EMBER);
  const workingSet = new Set(fleet.filter((a) => a.state === "EXECUTING" || a.state === "PROCESSING_NOW" || a.state === "TASK_IN_PROGRESS").map((a) => a.agent));

  let selected: string | null = null;
  let hovered: string | null = null;
  const ray = new THREE.Raycaster();
  const mouse = new THREE.Vector2();
  let downX = 0, downY = 0;
  function pick(e: PointerEvent): Built | null {
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    ray.setFromCamera(mouse, camera);
    const meshes: THREE.Object3D[] = [];
    buildings.forEach((b) => b.inner.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o); }));
    const hit = ray.intersectObjects(meshes, false)[0];
    if (!hit) return null;
    const code = hit.object.userData.code as string;
    return buildings.find((b) => b.a.code === code) ?? null;
  }
  const onDown = (e: PointerEvent) => { downX = e.clientX; downY = e.clientY; };
  const onUp = (e: PointerEvent) => {
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) return;
    const b = pick(e);
    selected = b ? b.a.code : null;
    opts.onSelect?.(b ? b.a.code : null);
  };
  const onMove = (e: PointerEvent) => { const b = pick(e); hovered = b ? b.a.code : null; renderer.domElement.style.cursor = b ? "pointer" : "default"; };
  renderer.domElement.addEventListener("pointerdown", onDown);
  renderer.domElement.addEventListener("pointerup", onUp);
  renderer.domElement.addEventListener("pointermove", onMove);
  renderer.domElement.addEventListener("start", () => { controls.autoRotate = false; });
  controls.addEventListener("start", () => { controls.autoRotate = false; });
  controls.addEventListener("end", () => { window.setTimeout(() => { controls.autoRotate = true; }, 2500); });

  function resize() {
    const w = wrap.clientWidth, h = wrap.clientHeight;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  window.addEventListener("resize", resize);

  const tmpObj = new THREE.Object3D(), tmpCol = new THREE.Color(), vec = new THREE.Vector3();
  const clock = new THREE.Clock();
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced) controls.autoRotate = false;
  let raf = 0;
  function animate() {
    const t = clock.getElapsedTime();
    cars.forEach((c) => {
      const u = (t * c.userData.speed + c.userData.offset) % 1;
      const tt = u < 0.5 ? u * 2 : (1 - u) * 2;
      c.position.lerpVectors(c.userData.path[0], c.userData.path[1], tt);
    });
    clouds.forEach((c) => { c.position.y = c.userData.baseY + Math.sin(t * c.userData.speed) * c.userData.floatIntensity; c.rotation.y += 0.0008; });
    buildings.forEach((b) => {
      const sel = selected === b.a.code, hov = hovered === b.a.code;
      const target = sel || hov ? 0.35 : 0;
      b.inner.position.y += (target - b.inner.position.y) * 0.12;
      b.halo.visible = sel || hov;
      const working = workingSet.has(b.a.code);
      const col = working ? WORK_COL : IDLE_COL;
      const wd = b.windows.userData as { accent: THREE.Color; dim: THREE.Color; instances: Inst[]; state: string };
      wd.accent.copy(col);
      (b.windows.material as THREE.MeshStandardMaterial).emissive.copy(col);
      (b.halo.material as THREE.MeshBasicMaterial).color.copy(col);
      b.accentMats.forEach((m) => m.emissive.copy(col));
      const list = wd.instances, accent = wd.accent, dim = wd.dim;
      const state = working ? "EXECUTING" : wd.state;
      for (let i = 0; i < list.length; i++) {
        const inst = list[i];
        tmpObj.position.copy(inst.pos); tmpObj.rotation.copy(inst.rot);
        tmpObj.scale.set(0.16, 0.22, 1); tmpObj.updateMatrix();
        b.windows.setMatrixAt(i, tmpObj.matrix);
        const intensity = stateIntensity(state, inst.seed, t);
        tmpCol.copy(dim).lerp(accent, intensity);
        b.windows.setColorAt(i, tmpCol);
      }
      b.windows.instanceMatrix.needsUpdate = true;
      if (b.windows.instanceColor) b.windows.instanceColor.needsUpdate = true;
      vec.set(b.a.position[0], monumentMountY(b.a) + 2.2 + b.inner.position.y, b.a.position[2]);
      vec.project(camera);
      const x = (vec.x * 0.5 + 0.5) * wrap.clientWidth, y = (-vec.y * 0.5 + 0.5) * wrap.clientHeight;
      if (vec.z < 1) { b.label.style.display = ""; b.label.style.left = x + "px"; b.label.style.top = y + "px"; }
      else b.label.style.display = "none";
    });
    controls.update();
    renderer.render(scene, camera);
    raf = requestAnimationFrame(animate);
  }
  animate();

  return {
    dispose() {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      renderer.domElement.removeEventListener("pointerdown", onDown);
      renderer.domElement.removeEventListener("pointerup", onUp);
      renderer.domElement.removeEventListener("pointermove", onMove);
      controls.dispose();
      labelLayer.remove();
      renderer.dispose();
      scene.traverse((o) => {
        const any = o as unknown as { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] };
        any.geometry?.dispose?.();
        const m = any.material; if (Array.isArray(m)) m.forEach((x) => x.dispose()); else m?.dispose?.();
      });
    },
  };
}
