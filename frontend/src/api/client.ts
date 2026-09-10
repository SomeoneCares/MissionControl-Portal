// API client. Every URL is relative, so the app works against whatever host serves it —
// no hardcoded endpoint, no per-install configuration in the bundle.

import type { State, HealthInfo, BoardTask } from "../types";

async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

async function postJSON<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  health: () => getJSON<HealthInfo>("/api/health"),
  state: () => getJSON<State>("/api/state"),
  capabilities: () => getJSON<Record<string, unknown>>("/api/capabilities"),
  board: {
    list: () => getJSON<{ tasks: BoardTask[] }>("/api/board"),
    create: (t: { title: string; priority?: string; status?: string }) =>
      postJSON<BoardTask>("/api/board", t),
    update: (id: string, fields: Partial<BoardTask>) =>
      postJSON<BoardTask>("/api/board/update", { id, ...fields }),
    remove: (id: string) => postJSON<{ deleted: boolean }>("/api/board/delete", { id }),
  },
};

// Subscribe to live state via SSE, falling back to polling if the stream drops.
export function subscribeState(onState: (s: State) => void): () => void {
  let es: EventSource | null = null;
  let poll: number | null = null;

  const startPolling = () => {
    if (poll != null) return;
    poll = window.setInterval(async () => {
      try {
        onState(await api.state());
      } catch {
        /* keep trying */
      }
    }, 6000);
  };

  try {
    es = new EventSource("/events");
    es.addEventListener("state", (e) => {
      try {
        onState(JSON.parse((e as MessageEvent).data));
      } catch {
        /* ignore malformed frame */
      }
    });
    es.onerror = () => startPolling();
  } catch {
    startPolling();
  }

  return () => {
    es?.close();
    if (poll != null) window.clearInterval(poll);
  };
}
