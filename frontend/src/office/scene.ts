// Shared office types + helpers, and the Armillary view. The Skyline lives in skyline.ts.
// Both views share one palette, driven by the portal accent: cool near-black ground/sky,
// silver structure, a blue idle glow and a green "processing now" pulse — matching the
// original deployed skyline ("green pulse = processing, blue glow = assigned, dim = idle").

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { settings } from "../store/settings";

// The city colour follows the portal's accent (Settings). With no accent chosen it falls back
// to the original skyline's royal blue, so the fleet reads blue out of the box.
export function officeAccentHex(): string {
  const a = settings.get().accent;
  return a && /^#?[0-9a-f]{6}$/i.test(a) ? (a[0] === "#" ? a : "#" + a) : "#3b6bff";
}
export function officeAccent(): number {
  return parseInt(officeAccentHex().slice(1), 16);
}
export function mixWhiteHex(hex: string, amt: number): string {
  const c = new THREE.Color(hex);
  c.lerp(new THREE.Color("#ffffff"), amt);
  return "#" + c.getHexString();
}

export interface FleetAgent {
  agent: string;
  initials: string;
  name: string;
  role: string;
  tasksToday: number;
  success: number;
  share: number;
  state: string;
  fleetAccent?: string;   // this agent's fleet accent hex ("" → the global portal accent)
}

// The agent's own colour: its fleet accent when set and valid, else the global portal accent.
export function agentAccentHex(a: FleetAgent): string {
  const fa = a.fleetAccent;
  if (fa && /^#?[0-9a-f]{6}$/i.test(fa)) return fa[0] === "#" ? fa : "#" + fa;
  return officeAccentHex();
}

export interface SceneOpts {
  onSelect?: (agent: string | null) => void;
}

export interface SceneController {
  dispose: () => void;
}

// shared office palette (accent-driven, cool)
const SPOTLIGHT = 0x37e08a; // processing-now pulse (green), like the original
const ASSIGNED = 0xee8a2f;  // task-assigned glow (orange)
const BG = 0x0a0b10;        // cool near-black sky
const RING = 0x8b95a3;      // silver armature, matching the grey monuments

// HQ / core = the ROOT agent (Hermes "default"; older hosts "orchestrator"). Profile agents
// such as "pt-orchestrator" are specialists — match the exact root name, not a substring.
function isOrch(a: FleetAgent): boolean {
  return a.agent === "default" || a.agent === "orchestrator";
}
function isWorking(a: FleetAgent): boolean {
  return a.state === "EXECUTING" || a.state === "PROCESSING_NOW" || a.state === "TASK_IN_PROGRESS";
}
function isAssigned(a: FleetAgent): boolean {
  return a.state === "ASSIGNED" || a.state === "TASK_ASSIGNED";
}

function glowTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const x = c.getContext("2d")!;
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.4, "rgba(255,255,255,0.45)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  x.fillStyle = g;
  x.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}
function glowSprite(tex: THREE.Texture, size: number, color: number, opacity: number): THREE.Sprite {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  s.scale.set(size, size, 1);
  return s;
}
function labelSprite(text: string, size = 0.5): THREE.Sprite {
  const c = document.createElement("canvas");
  c.width = 160; c.height = 80;
  const x = c.getContext("2d")!;
  x.font = "500 40px 'JetBrains Mono', monospace";
  x.textAlign = "center"; x.textBaseline = "middle";
  x.fillStyle = "rgba(247,240,225,0.85)";
  x.fillText(text, 80, 42);
  const m = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, depthTest: false });
  const s = new THREE.Sprite(m);
  s.scale.set(size * 2, size, 1);
  return s;
}

interface Mote { sprite: THREE.Sprite; from: THREE.Vector3; to: THREE.Vector3; u: number; }
function makeMotes(scene: THREE.Scene, tex: THREE.Texture) {
  const motes: Mote[] = [];
  return {
    emit(from: THREE.Vector3, to: THREE.Vector3) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, color: SPOTLIGHT, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      s.scale.set(0.7, 0.7, 1); s.position.copy(from); scene.add(s);
      motes.push({ sprite: s, from: from.clone(), to: to.clone(), u: 0 });
    },
    tick(dt: number) {
      for (let i = motes.length - 1; i >= 0; i--) {
        const m = motes[i]; m.u += dt * 0.9;
        if (m.u >= 1) { scene.remove(m.sprite); m.sprite.material.dispose(); motes.splice(i, 1); continue; }
        m.sprite.position.lerpVectors(m.from, m.to, m.u);
        m.sprite.material.opacity = 1 - m.u * 0.4;
      }
    },
    dispose() { motes.forEach((m) => { scene.remove(m.sprite); m.sprite.material.dispose(); }); },
  };
}

function baseScene(canvas: HTMLCanvasElement) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.6));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BG);
  scene.fog = new THREE.FogExp2(BG, 0.02);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 300);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.08; controls.enablePan = false;
  controls.autoRotate = true; controls.autoRotateSpeed = 0.5;
  controls.minDistance = 6; controls.maxDistance = 90; controls.maxPolarAngle = Math.PI * 0.49;
  controls.addEventListener("start", () => { controls.autoRotate = false; });
  controls.addEventListener("end", () => { window.setTimeout(() => { controls.autoRotate = true; }, 2500); });
  const resize = () => {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  };
  resize();
  return { renderer, scene, camera, controls, resize };
}

export function buildArmillary(canvas: HTMLCanvasElement, fleet: FleetAgent[], opts: SceneOpts = {}): SceneController {
  const { renderer, scene, camera, controls, resize } = baseScene(canvas);
  const EMBER = officeAccent();
  const glow = glowTexture();
  const motes = makeMotes(scene, glow);
  camera.position.set(0, 3, 14);
  controls.target.set(0, 0, 0);
  controls.autoRotateSpeed = 0.8;

  scene.add(new THREE.AmbientLight(0x2a2f3a, 0.8));
  const core = new THREE.PointLight(EMBER, 4.5, 50); scene.add(core);
  const d1 = new THREE.DirectionalLight(0xdfe6ef, 0.6); d1.position.set(-10, 12, 8); scene.add(d1);

  const sun = new THREE.Mesh(new THREE.SphereGeometry(0.62, 32, 32),
    new THREE.MeshBasicMaterial({ color: mixWhiteHex(officeAccentHex(), 0.5), toneMapped: false }));
  scene.add(sun);
  const sunGlow = glowSprite(glow, 5.6, EMBER, 0.9); scene.add(sunGlow);
  const orch = fleet.find(isOrch);
  if (orch) { const l = labelSprite(orch.initials, 0.5); l.position.set(0, 1.1, 0); sun.userData.agent = orch.agent; scene.add(l); }

  const ringMat = { color: RING, metalness: 0.9, roughness: 0.35 } as const;
  [[0, 0, 0], [Math.PI / 2, 0, 0], [0, 0, Math.PI / 2]].forEach((r) => {
    const m = new THREE.Mesh(new THREE.TorusGeometry(5.4, 0.035, 10, 160), new THREE.MeshStandardMaterial(ringMat));
    m.rotation.set(r[0], r[1], r[2]); scene.add(m);
  });

  const specialists = fleet.filter((a) => !isOrch(a));
  const maxTasks = Math.max(1, ...specialists.map((a) => a.tasksToday));

  interface Body { pivot: THREE.Object3D; body: THREE.Mesh; bglow: THREE.Sprite; label: THREE.Sprite; agent: FleetAgent; R: number; spd: number; ph: number; working: boolean; }
  const bodies: Body[] = [];
  const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967295; };

  specialists.forEach((a, i) => {
    const R = 1.7 + i * 0.62;
    const pivot = new THREE.Object3D();
    pivot.rotation.set(1.05 + hash(a.agent) * 0.8, hash(a.agent + "y") * 6.28, hash(a.agent + "z") * 1.2);
    scene.add(pivot);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(R, 0.02, 8, 140), new THREE.MeshStandardMaterial(ringMat));
    pivot.add(ring);
    const rad = 0.13 + Math.sqrt(Math.max(0, a.share)) * 0.1;
    const working = isWorking(a);       // executing → green
    const assigned = isAssigned(a);     // task assigned → orange
    const active = working || assigned;
    // idle bodies wear their fleet's accent; live state (green/orange) still overrides
    const aHex = agentAccentHex(a);
    const aNum = parseInt(aHex.slice(1), 16);
    const aSoft = parseInt(mixWhiteHex(aHex, 0.34).slice(1), 16);
    const bodyColor = working ? SPOTLIGHT : assigned ? ASSIGNED : aSoft; // green / orange / fleet accent (idle)
    const body = new THREE.Mesh(new THREE.SphereGeometry(rad, 24, 24), new THREE.MeshStandardMaterial({
      color: bodyColor, emissive: working ? 0x0d5a34 : assigned ? ASSIGNED : aNum, emissiveIntensity: active ? 0.5 : 0.16, roughness: 0.55, metalness: 0.25,
    }));
    body.userData.agent = a.agent;
    pivot.add(body);
    const bglow = glowSprite(glow, rad * 5, working ? SPOTLIGHT : assigned ? ASSIGNED : aNum, active ? 0.55 : 0.2);
    pivot.add(bglow);
    const label = labelSprite(a.initials, 0.34); pivot.add(label);
    bodies.push({ pivot, body, bglow, label, agent: a, R, spd: 0.1 + (a.tasksToday / maxTasks) * 0.42, ph: i * 1.1, working });
  });

  // click-select (drag-aware raycast)
  const ray = new THREE.Raycaster(); const mouse = new THREE.Vector2();
  let downX = 0, downY = 0;
  const onDown = (e: PointerEvent) => { downX = e.clientX; downY = e.clientY; };
  const onUp = (e: PointerEvent) => {
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) return;
    const rect = canvas.getBoundingClientRect();
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    ray.setFromCamera(mouse, camera);
    const targets: THREE.Object3D[] = [sun, ...bodies.map((b) => b.body)];
    const hit = ray.intersectObjects(targets, false)[0];
    opts.onSelect?.(hit ? (hit.object.userData.agent as string) : null);
  };
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointerup", onUp);

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced) controls.autoRotate = false;
  const working = bodies.filter((b) => b.working);
  let raf = 0, t0 = 0, last = 0;
  const worldPos = new THREE.Vector3();
  function loop(ms: number) {
    if (!t0) t0 = ms;
    const t = (ms - t0) / 1000;
    const dt = last ? Math.min(0.05, (ms - last) / 1000) : 0; last = ms;
    const s = 1 + Math.sin(t * 2.1) * 0.05; sun.scale.setScalar(s); sunGlow.scale.setScalar(5.6 * s);
    bodies.forEach((b) => {
      const ang = b.ph + (reduced ? 0 : t * b.spd);
      const px = Math.cos(ang) * b.R, py = Math.sin(ang) * b.R;
      b.body.position.set(px, py, 0); b.bglow.position.set(px, py, 0); b.label.position.set(px, py + 0.4, 0);
    });
    motes.tick(dt);
    if (!reduced && working.length && Math.random() < 0.04) {
      const b = working[Math.floor(Math.random() * working.length)];
      b.body.getWorldPosition(worldPos);
      motes.emit(new THREE.Vector3(0, 0, 0), worldPos.clone());
    }
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
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      motes.dispose();
      controls.dispose();
      renderer.dispose();
      scene.traverse((o) => {
        const any = o as unknown as { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] };
        any.geometry?.dispose?.();
        const m = any.material; if (Array.isArray(m)) m.forEach((x) => x.dispose()); else m?.dispose?.();
      });
    },
  };
}
