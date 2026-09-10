// Portal settings — branding (name + accent colour), theme. Per-viewer, persisted to
// localStorage, and applied to the document at runtime so the whole portal recolours live.

const KEY = "hermes-mc-settings-v1";

export interface Settings {
  portalName: string;   // "" = default "Hermes"
  accent: string;       // "" = the built-in ember; else a hex the accent is set to
  theme: "system" | "light" | "dark";
}

const DEFAULTS: Settings = { portalName: "", accent: "", theme: "system" };

let current: Settings = load();
const listeners = new Set<() => void>();

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    /* private mode / cleared */
  }
  return { ...DEFAULTS };
}
function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* ignore */ }
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function lighten(hex: string, amt: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const [r, g, b] = rgb.map((v) => Math.round(v + (255 - v) * amt));
  return `rgb(${r}, ${g}, ${b})`;
}
function rgba(hex: string, a: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a})`;
}

export function applySettings() {
  const root = document.documentElement;
  if (current.theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", current.theme);

  if (current.accent && hexToRgb(current.accent)) {
    root.style.setProperty("--ember", current.accent);
    root.style.setProperty("--ember-soft", lighten(current.accent, 0.28));
    root.style.setProperty("--ember-bg", rgba(current.accent, 0.11));
    root.style.setProperty("--ember-glow", rgba(current.accent, 0.2));
  } else {
    root.style.removeProperty("--ember");
    root.style.removeProperty("--ember-soft");
    root.style.removeProperty("--ember-bg");
    root.style.removeProperty("--ember-glow");
  }
}

export const settings = {
  get(): Settings { return current; },
  set(patch: Partial<Settings>) { current = { ...current, ...patch }; persist(); applySettings(); listeners.forEach((l) => l()); },
  subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
};

// accent presets offered in Settings
export const ACCENT_PRESETS: { name: string; value: string }[] = [
  { name: "Ember", value: "" },
  { name: "Verto blue", value: "#1db4d8" },
  { name: "Deep teal", value: "#0d7a94" },
  { name: "Violet", value: "#7c5cff" },
  { name: "Green", value: "#3faa5a" },
];
