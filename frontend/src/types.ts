// Typed shape of the backend state payload. Mirrors backend/hermes_mc/local_source.build_state().
// This is the shared contract between front and back — see docs/state-contract.md.

export interface Agent {
  agent: string;
  code: string;
  initials: string;
  name: string;
  role: string;
  defaultModel: string;
  provider: string;
  tasksToday: number;
  success: number;
  share: number;
  state: string;
  task: string;
}

export interface AgentLog {
  agent: string;
  task: string;
  time: string;
  model: string;
  status: string;
}

export interface Health {
  gateway_state: string;
  active_agents?: number;
  platforms: Record<string, string>;
  version?: string;
  updated_at?: string;
  gateway_reachable?: boolean;
  gateway_latency_ms?: number;
}

export interface BoardTask {
  id: string;
  title: string;
  status: "todo" | "doing" | "done";
  priority: "P1" | "P2" | "P3";
}

export interface State {
  fleet: Agent[];
  models: { id: string; label: string }[];
  model_usage: { name: string; count: number; pct: number }[];
  routing: {
    total: number;
    models: number;
    premium_calls: number;
    fast_calls: number;
    offload_pct: number;
  };
  agentlogs: AgentLog[];
  agentlogs_stats: { total: number; completed: number; failed: number };
  health: Health;
  vps: { cpu_pct: number; mem_pct: number; disk_pct: number };
  sessions: { totals: { input: number; output: number; messages: number } };
  board: BoardTask[];
  working_agents: string[];
  generated_at: string;
}

export interface HealthInfo {
  ok: boolean;
  mode: "local" | "remote";
  gateway_configured: boolean;
  bridge_configured: boolean | null;
  gateway: { ok: boolean; latency_ms: number; version: string } | null;
}
