// Persistent chat store. Threads live here — outside any component — so they survive tab
// navigation, and are mirrored to localStorage so they survive a page reload too. Per-viewer,
// per-browser: it is a convenience history, not shared state.

import type { ChatMessage, ToolEvent, ApprovalReq, TokenUsage, SubagentEvent } from "../api/client";

export interface Turn extends ChatMessage {
  streaming?: boolean;
  reasoning?: string;
  tools?: ToolEvent[];
  subagents?: SubagentEvent[];
  atts?: { name: string; kind: string }[];
  runId?: string;
  approval?: ApprovalReq | null;
  usage?: TokenUsage;
  ts?: number;
}

const KEY = "hermes-mc-chat-threads-v1";
type Threads = Record<string, Turn[]>;

const EMPTY: Turn[] = [];
let threads: Threads = load();
const listeners = new Set<() => void>();

function load(): Threads {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as Threads;
  } catch {
    /* private mode, cleared storage, or a different browser — start empty */
  }
  return {};
}

function persist(): void {
  try {
    // never persist the transient streaming flag
    const clean: Threads = {};
    for (const k of Object.keys(threads)) {
      clean[k] = threads[k].map((t) => ({ ...t, streaming: false }));
    }
    localStorage.setItem(KEY, JSON.stringify(clean));
  } catch {
    /* storage unavailable — in-memory history still works for this session */
  }
}

function emit(): void {
  threads = { ...threads }; // new top-level ref so useSyncExternalStore re-renders
  listeners.forEach((l) => l());
}

export const chatStore = {
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => { listeners.delete(l); };
  },
  snapshot(): Threads {
    return threads;
  },
  thread(key: string): Turn[] {
    return threads[key] ?? EMPTY;
  },
  setThread(key: string, turns: Turn[]): void {
    threads[key] = turns;
    emit();
  },
  patchLast(key: string, fn: (t: Turn) => void): void {
    const arr = [...(threads[key] ?? [])];
    const last = arr[arr.length - 1];
    if (last) {
      fn(last);
      threads[key] = arr;
      emit();
    }
  },
  clear(key: string): void {
    delete threads[key];
    emit();
    persist();
  },
  persist,
};
