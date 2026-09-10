// API client. Every URL is relative, so the app works against whatever host serves it —
// no hardcoded endpoint, no per-install configuration in the bundle.

import type { State, HealthInfo, BoardTask } from "../types";

// the selected fleet is appended to every request; "primary" is the portal's own host
let fleetId = "primary";
export function setFleet(id: string) { fleetId = id || "primary"; }
export function getFleet() { return fleetId; }
export function withFleet(path: string): string {
  if (fleetId === "primary") return path;
  return path + (path.includes("?") ? "&" : "?") + "fleet=" + encodeURIComponent(fleetId);
}

async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(withFleet(path), { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

async function postJSON<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(withFleet(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export interface FleetInfo {
  id: string; name: string; accent: string; mode: string; primary: boolean; gateway: boolean;
}

export const api = {
  health: () => getJSON<HealthInfo>("/api/health"),
  state: () => getJSON<State>("/api/state"),
  capabilities: () => getJSON<Record<string, unknown>>("/api/capabilities"),
  chatAgents: () => getJSON<ChatAgents>("/api/chat/agents"),
  models: () => getJSON<{ models: ModelOption[]; editable: boolean }>("/api/models"),
  agentFiles: (agent: string) =>
    getJSON<{ files: AgentFile[] }>(`/api/agents/files?agent=${encodeURIComponent(agent)}`),
  agentFile: (agent: string, name: string) =>
    getJSON<{ name: string; exists: boolean; content: string; redacted?: boolean }>(
      `/api/agents/file?agent=${encodeURIComponent(agent)}&name=${encodeURIComponent(name)}`),
  setModel: (agent: string, model: string, provider = "") =>
    postJSON<{ ok: boolean; model: string; backup: string | null }>(
      "/api/agents/model", { agent, model, provider }),
  saveFile: (agent: string, name: string, content: string) =>
    postJSON<{ ok: boolean; size: number; backup: string | null }>(
      "/api/agents/file", { agent, name, content }),
  stopRun: (run: string, agent: string | null) =>
    postJSON<{ ok: boolean }>("/api/runs/stop", { run, agent }),
  steerRun: (run: string, text: string, agent: string | null) =>
    postJSON<{ ok: boolean }>("/api/runs/steer", { run, text, agent }),
  approve: (run: string, choice: string, agent: string | null, request_id?: string) =>
    postJSON<{ ok: boolean }>("/api/runs/approval", { run, choice, agent, request_id }),
  fleets: () => getJSON<{ fleets: FleetInfo[]; current: string }>("/api/fleets"),
  addFleet: (spec: { name: string; accent?: string; bridge_url?: string; bridge_key?: string; gateway_url?: string; gateway_key?: string }) =>
    postJSON<FleetInfo>("/api/fleets", spec),
  removeFleet: (id: string) => postJSON<{ removed: boolean }>("/api/fleets/remove", { id }),
  schedule: () => getJSON<{ jobs: CronJob[] }>("/api/schedule"),
  content: () => getJSON<{ docs: ContentDoc[] }>("/api/content"),
  contentRead: (p: string) =>
    getJSON<{ path: string; exists: boolean; content: string }>(
      `/api/content/read?path=${encodeURIComponent(p)}`),
  contentSave: (p: string, content: string) =>
    postJSON<{ ok: boolean; size: number }>("/api/content/save", { path: p, content }),
  contentCreate: (agent: string, title: string) =>
    postJSON<{ ok: boolean; path: string }>("/api/content/create", { agent, title }),
  contentDelete: (p: string) => postJSON<{ ok: boolean }>("/api/content/delete", { path: p }),
  contentDownloadUrl: (p: string) => withFleet(`/api/content/download?path=${encodeURIComponent(p)}`),
  contentWordUrl: (p: string) => withFleet(`/api/content/word?path=${encodeURIComponent(p)}`),
  createAgent: (spec: { name: string; role?: string; model?: string; provider?: string }) =>
    postJSON<{ ok: boolean; agent: string; name: string }>("/api/agents/create", spec),
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

export interface ChatAgents {
  gateway: boolean;
  multiplex: boolean;
  agents: string[];
}

export interface ModelOption {
  id: string;
  model: string;
  provider: string;
  label: string;
  source: string;
}

export interface AgentFile {
  name: string;
  exists: boolean;
  size: number;
}

export interface CronJob {
  id: string;
  name: string;
  enabled: boolean;
  state: string;
  schedule: string;
  next_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  deliver: string | null;
  model: string;
  prompt: string;
}

export interface ContentDoc {
  agent: string;
  filename: string;
  path: string;
  title: string;
  modified_at: string;
  size: number;
}

export interface ToolEvent {
  phase: "started" | "completed";
  name: string;
  preview: string;
}

export interface ApprovalReq {
  choices: { label?: string; value?: string; id?: string }[];
  text: string;
}

export interface ChatHandlers {
  onDelta: (t: string) => void;
  onReasoning?: (text: string) => void;
  onTool?: (t: ToolEvent) => void;
  onRun?: (runId: string) => void;
  onApproval?: (a: ApprovalReq) => void;
  onDone: () => void;
  onError: (e: string) => void;
}

export interface Attachment {
  name: string;
  kind: "text" | "image";
  size: number;
  text?: string;     // for text files: the content
  dataUrl?: string;  // for images: a data: URL
}

// Stream a real agent turn to a specific agent (profile) via the runs API. Surfaces the agent's
// reasoning and tool activity alongside the answer. Returns an abort function.
export function chatStream(
  messages: ChatMessage[],
  agent: string | null,
  handlers: ChatHandlers,
  attachments?: Attachment[],
): () => void {
  const ctrl = new AbortController();
  (async () => {
    try {
      const res = await fetch(withFleet("/api/chat"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages, agent, attachments: attachments ?? [] }),
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
            else if (obj.reasoning !== undefined) handlers.onReasoning?.(obj.reasoning);
            else if (obj.tool) handlers.onTool?.(obj.tool);
            else if (obj.run) handlers.onRun?.(obj.run);
            else if (obj.approval) handlers.onApproval?.(obj.approval);
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
    es = new EventSource(withFleet("/events"));
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
