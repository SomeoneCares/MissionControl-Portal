// API client. Every URL is relative, so the app works against whatever host serves it —
// no hardcoded endpoint, no per-install configuration in the bundle.

import type { State, HealthInfo, BoardTask, KanbanTask, TaskStage } from "../types";

// the selected connection (Hermes host) is appended to every request; "primary" is the portal's
// own host. Persisted so the choice survives the page reload the connection switcher triggers.
const CONNECTION_KEY = "hermes-mc-connection";
let connId = (() => {
  try { return localStorage.getItem(CONNECTION_KEY) || localStorage.getItem("hermes-mc-fleet") || "primary"; }
  catch { return "primary"; }
})();
export function setConnection(id: string) {
  connId = id || "primary";
  try { localStorage.setItem(CONNECTION_KEY, connId); } catch { /* private mode */ }
}
export function getConnection() { return connId; }
export function withConnection(path: string): string {
  if (connId === "primary") return path;
  return path + (path.includes("?") ? "&" : "?") + "connection=" + encodeURIComponent(connId);
}

async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(withConnection(path), { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

async function postJSON<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(withConnection(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // Surface the backend's own message (e.g. why Hermes rejected a task move) instead of a
    // bare status code. Read the body once; fall back to the status if it isn't JSON.
    let detail = "";
    try { const j = await res.json(); detail = (j && (j.error || j.message)) || ""; } catch { /* not json */ }
    throw new Error(detail || `${path} → HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export interface ConnectionInfo {
  id: string; name: string; accent: string; mode: string; primary: boolean; gateway: boolean;
}

export interface FleetGroup {
  id: string; name: string; accent: string;
  members: string[];        // profile names assigned to this fleet (may include ones not live)
  live_members?: string[];  // members currently present on the connection
}
export interface FleetGroupsView {
  fleets: FleetGroup[];
  ungrouped: string[];      // live profiles not in any fleet
  profiles: string[];       // all live profiles on the connection
}

export interface AuthStatus {
  authed: boolean;
  required: boolean;
  username: string;
  is_default: boolean;   // still on the seeded default password
  editable: boolean;     // false when credentials come from environment variables
}

export const api = {
  health: () => getJSON<HealthInfo>("/api/health"),
  authStatus: () => getJSON<AuthStatus>("/api/auth/status"),
  login: (username: string, password: string) =>
    postJSON<{ ok: boolean }>("/api/auth/login", { username, password }),
  logout: () => postJSON<{ ok: boolean }>("/api/auth/logout", {}),
  changePassword: (username: string, current_password: string, new_password: string) =>
    postJSON<{ ok: boolean }>("/api/auth/password", { username, current_password, new_password }),
  state: () => getJSON<State>("/api/state"),
  capabilities: () => getJSON<Record<string, unknown>>("/api/capabilities"),
  toolsets: () => getJSON<{ data: { name: string }[] }>("/api/toolsets"),
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
  branding: () => getJSON<{ name: string; accent: string }>("/api/branding"),
  setBranding: (spec: { name: string; accent: string }) =>
    postJSON<{ name: string; accent: string }>("/api/branding", spec),
  // profile-group "fleets" — portal-side grouping over the selected connection's profiles
  fleets: () => getJSON<FleetGroupsView>("/api/fleets"),
  createFleet: (spec: { name: string; accent?: string }) => postJSON<FleetGroup>("/api/fleets", spec),
  updateFleet: (id: string, patch: { name?: string; accent?: string }) =>
    postJSON<FleetGroup>("/api/fleets/update", { id, ...patch }),
  assignFleet: (profile: string, fleet: string) =>
    postJSON<{ ok: boolean; error?: string }>("/api/fleets/assign", { profile, fleet }),
  removeFleet: (id: string) => postJSON<{ removed: boolean }>("/api/fleets/remove", { id }),
  connections: () => getJSON<{ connections: ConnectionInfo[]; current: string }>("/api/connections"),
  addConnection: (spec: { name: string; accent?: string; bridge_url?: string; bridge_key?: string; gateway_url?: string; gateway_key?: string }) =>
    postJSON<ConnectionInfo>("/api/connections", spec),
  removeConnection: (id: string) => postJSON<{ removed: boolean }>("/api/connections/remove", { id }),
  schedule: () => getJSON<{ jobs: CronJob[] }>("/api/schedule"),
  tasks: () => getJSON<{ tasks: KanbanTask[]; stages: TaskStage[]; editable: boolean }>("/api/tasks"),
  taskDetail: (id: string) => getJSON<TaskDetail>(`/api/tasks/detail?id=${encodeURIComponent(id)}`),
  moveTask: (id: string, to: string, from: string) =>
    postJSON<{ ok: boolean; message: string }>("/api/tasks/move", { id, to, from }),
  content: () => getJSON<{ docs: ContentDoc[] }>("/api/content"),
  contentDir: () => getJSON<ContentDirInfo>("/api/content/dir"),
  setContentDir: (p: string) => postJSON<ContentDirInfo>("/api/content/dir", { path: p }),
  contentRead: (p: string) =>
    getJSON<{ path: string; exists: boolean; content: string }>(
      `/api/content/read?path=${encodeURIComponent(p)}`),
  contentSave: (p: string, content: string) =>
    postJSON<{ ok: boolean; size: number }>("/api/content/save", { path: p, content }),
  contentCreate: (agent: string, title: string) =>
    postJSON<{ ok: boolean; path: string }>("/api/content/create", { agent, title }),
  contentDelete: (p: string) => postJSON<{ ok: boolean }>("/api/content/delete", { path: p }),
  contentDownloadUrl: (p: string) => withConnection(`/api/content/download?path=${encodeURIComponent(p)}`),
  contentWordUrl: (p: string) => withConnection(`/api/content/word?path=${encodeURIComponent(p)}`),
  createAgent: (spec: { name: string; role?: string; model?: string; provider?: string }) =>
    postJSON<{ ok: boolean; agent: string; name: string }>("/api/agents/create", spec),
  agentSkills: (agent: string) =>
    getJSON<{ installed: { name: string; description: string }[]; disabled_toolsets: string[] }>(
      `/api/agents/skills?agent=${encodeURIComponent(agent)}`),
  setToolset: (agent: string, toolset: string, enabled: boolean) =>
    postJSON<{ ok: boolean }>("/api/agents/toolset", { agent, toolset, enabled }),
  board: {
    list: () => getJSON<{ tasks: BoardTask[] }>("/api/board"),
    create: (t: { title: string; priority?: string; status?: string }) =>
      postJSON<BoardTask>("/api/board", t),
    update: (id: string, fields: Partial<BoardTask>) =>
      postJSON<BoardTask>("/api/board/update", { id, ...fields }),
    remove: (id: string) => postJSON<{ deleted: boolean }>("/api/board/delete", { id }),
  },
};

export interface TaskDetail {
  id: string;
  title: string;
  assignee: string;
  status: string;
  stage: string;
  priority: number;
  created_at: number | null;
  started_at: number | null;
  completed_at: number | null;
  running: boolean;
  error: string;
  body: string;
  result: string;
  comments: { author: string; body: string; at: number | null }[];
  runs: { profile: string; status: string; summary: string; error: string; started_at: number | null; finished_at: number | null }[];
}

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
  agent?: string;
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

export interface ContentDirInfo {
  path: string | null;
  exists?: boolean;
  writable?: boolean;
  docs?: number;
  default?: string;
  editable: boolean;
  env_locked?: boolean;
  reason?: string;
}

export interface ContentDoc {
  agent: string;
  filename: string;
  path: string;
  title: string;
  kind?: string;   // file extension without the dot: "md" | "pdf" | "txt" | …
  modified_at: string;
  size: number;
}

export interface ToolEvent {
  phase: "started" | "completed";
  name: string;
  preview: string;
  duration?: number;   // seconds, on completed
  error?: boolean;     // on completed
}

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

// Hermes sends approval choices as plain strings (e.g. "once" | "session" | "deny"); older
// paths may send objects. Accept both.
export type ApprovalChoice = string | { label?: string; value?: string; id?: string };
export interface ApprovalReq {
  choices: ApprovalChoice[];
  text: string;
}

export interface SubagentEvent {
  phase: "start" | "complete";
  id?: string;         // delegation_id / child_session_id — pairs start with complete
  goal?: string;       // what the child was asked to do (its effective identity)
  model?: string;
  status?: string;
  duration?: number;   // seconds (from duration_seconds)
  tokens?: number;     // input_tokens + output_tokens
  summary?: string;    // the child's result summary
  output_tail?: string; // tail of the child's output
}

export interface ChatHandlers {
  onDelta: (t: string) => void;
  onReasoning?: (text: string) => void;
  onTool?: (t: ToolEvent) => void;
  onSubagent?: (s: SubagentEvent) => void;
  onRun?: (runId: string) => void;
  onApproval?: (a: ApprovalReq) => void;
  onDone: (usage?: TokenUsage) => void;
  onError: (e: string) => void;
}

export interface Attachment {
  name: string;
  kind: "text" | "image" | "file";
  size: number;
  text?: string;     // for text files: the content
  dataUrl?: string;  // for images and files (PDF/docx/…): a base64 data: URL; the backend extracts structured Markdown
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
      const res = await fetch(withConnection("/api/chat"), {
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
            else if (obj.subagent) handlers.onSubagent?.(obj.subagent);
            else if (obj.run) handlers.onRun?.(obj.run);
            else if (obj.approval) handlers.onApproval?.(obj.approval);
            else if (obj.error) handlers.onError(obj.error);
            else if (obj.done) handlers.onDone(obj.usage);
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
    es = new EventSource(withConnection("/events"));
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
