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

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

// Stream a real agent turn. Calls onDelta per token, onDone at the end, onError on failure.
// Returns an abort function.
export function chatStream(
  messages: ChatMessage[],
  handlers: { onDelta: (t: string) => void; onDone: () => void; onError: (e: string) => void },
): () => void {
  const ctrl = new AbortController();
  (async () => {
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        handlers.onError(`HTTP ${res.status}`);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const frames = buf.split("\n\n");
        buf = frames.pop() ?? "";
        for (const frame of frames) {
          const line = frame.trim();
          if (!line.startsWith("data:")) continue;
          try {
            const obj = JSON.parse(line.slice(5).trim());
            if (obj.delta) handlers.onDelta(obj.delta);
            else if (obj.error) handlers.onError(obj.error);
            else if (obj.done) handlers.onDone();
          } catch {
            /* ignore malformed frame */
          }
        }
      }
      handlers.onDone();
    } catch (e) {
      if ((e as Error).name !== "AbortError") handlers.onError(String(e));
    }
  })();
  return () => ctrl.abort();
}

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
