# Hermes Workflow Studio — Product Plan & Research

**Status:** draft — decision pending
**Verdict:** conditional go (the condition is narrow; see §5)
**Date:** 2026-09-11

---

## 1. What I want to build

A **generic graphical fleet-and-workflow management tool for Hermes Agent**, built as a
product rather than as internal tooling.

Hermes can run a fleet of specialised agent profiles and coordinate them through a
shared Kanban board. What it has no graphical surface for is **designing, testing and
debugging the workflows those agents run**. Today a multi-stage pipeline is authored
either in prose inside a profile's SOUL/ROUTING files, or by asking an LLM to emit a
series of `kanban_create` calls. Both are unreliable, neither is testable, and when a
run goes wrong the only diagnostic path is tailing worker logs and reading the Hermes
source.

The tool would provide:

- **Visual workflow authoring** — build a multi-agent pipeline as a graph, with
  conditions, branches and error paths, instead of hoping a model emits three correct
  tool calls in sequence.
- **Step-level testing** — pin inputs to a node and run just that node, rather than
  executing an entire live pipeline to exercise one branch.
- **Fleet-wide observability** — see every profile, worker, run and task across the whole
  fleet in one place, not one session at a time.
- **Agent-level debugging** — for any node execution, the reasoning trace, every tool
  call with arguments and results, the resolved prompt, the skills and toolsets actually
  loaded, and token usage.
- **LLM-assisted authoring** — describe a workflow in natural language and generate the
  graph; have an agent read a failed run and propose the fix.

The existing **Mission Control portal** is a candidate seed for this. It already
aggregates state across every profile in the fleet, which — per the research below — is
something first-party Hermes does **not** do.

### Why this problem, and why now

The motivation is not theoretical. It comes from a single day operating a two-fleet
Hermes deployment (pentest + SOC), during which a three-stage pipeline
(scanner → validator → reporter) failed repeatedly. Every failure was catalogued with
its artifact. **None of them were in the work itself** — the scan engine, PDF renderer
and charting all worked once a genuine script bug was fixed. Every failure was in
**control flow** or **agent judgment**:

| Failure observed | Category |
|---|---|
| Stage 2 created with `workspace_path: './?'` and no parent | LLM emitting structured params |
| Only 1 of 3 chain tasks created; stage 3 never created at all | LLM sequencing tool calls |
| Path written with backslashes — rejected at dispatch | LLM composing strings |
| Path written with a U+2011 hyphen — silently created a phantom directory; the only PDF landed there | LLM composing strings |
| `timeout: 600000` (milliseconds for seconds) → auto-backgrounded → output unreachable | LLM process lifecycle |
| Called `process(...)`; the registered tool is `process_manage` | Tool-name mismatch |
| Preflight success reported as scan success | LLM judging completion |
| Block reason emitted as degenerate token repetition | LLM output quality |

The defining incident: a scanner agent ran a dependency check, ran **no scan
whatsoever**, and closed its task with:

> "The preflight check completed successfully. All required scanner tools are available
> and ready for the authorized scan. The task has been marked as complete."
> — pt-scanner, task `t_b789c190`, zero bytes of scan output produced

A downstream agent then "validated" the fabricated findings, and a third rendered a
clean PDF of nothing. Two structural failures compounded it:

- **The chain stranded silently.** A worker-initiated block is sticky and never satisfies
  a child's dependency gate, so two downstream tasks sat in `todo` indefinitely with no
  signal. This was only discovered by reading `recompute_ready` in the Hermes source.
- **No error path existed.** There is nowhere to express "on scanner failure, abort the
  chain and notify" — because the substrate cannot express it.

---

## 2. Research: Hermes first-party capability (go/no-go)

*Source inspected: `/home/basem/.hermes/hermes-agent` at commit `564aef2`. Read-only.*

### 2.1 What the CLI subcommands actually are — **verified**

| Command | Reality |
|---|---|
| `hermes portal` | **Not a GUI.** Nous Portal auth/onboarding CLI (`login`, `info`, `open`, `tools`). |
| `hermes dashboard` | FastAPI + React web app on `:9119` — config, API keys, sessions, logs, analytics, cron, profiles, skills, MCP, webhooks. Hosts dashboard plugins. |
| `hermes serve` | The **same server**, headless. `serve` forwards to `cmd_dashboard` (`hermes_cli/main.py:2947-2971`). |
| `hermes desktop` | Builds/launches the Electron app. |
| `hermes gui` | **Deprecated alias** for `desktop` (`hermes_cli/main.py:3286-3287`). |

### 2.2 Is there already a first-party fleet or workflow UI?

**A Kanban board GUI already exists — verified**, in two places backed by the same REST
router:

- **Web dashboard plugin** — `plugins/kanban/dashboard/plugin_api.py`, mounted at
  `/api/plugins/kanban`. ~45 endpoints. Columns per status, drag-drop, detail drawer with
  a dependency editor (parent/child chip lists), comments, last 20 events, worker log
  tail, run inspect/terminate, bulk actions, dispatcher "Nudge", board export/import.
- **Desktop plugin** — `apps/desktop/src/plugins/kanban/` (~6.4k lines TSX), a pure
  SDK-consumer over the same router. **Ships OFF by default.**

**What does NOT exist — verified by grep across both plugins:**

- **No graph / DAG / canvas view.** Dependencies appear only as chip lists in the drawer
  and a `link_counts` badge on cards. The only `d3-force` usage in desktop is the
  "starmap" memory visualisation, not tasks.
- **No workflow builder.** Task graphs are created via CLI, the `kanban_create` tool, the
  LLM decomposer, or `hermes kanban swarm`.
- **No fleet-wide observability.** "Fleet" in Desktop means *multi-gateway connection
  switching* (a profile picker across registered gateways), not fleet observability.
- Agent-level observability exists only **per session** (Desktop "Live subagents" panel).
  Kanban worker observability is log tail + task events + run inspect, per task, with no
  cross-worker timeline.

**Kanban RFC #16102 explicitly lists as deliberately out of v1:** *"approval gates, fleet
dashboards, org-chart types"* — characterised as "user-space (plugins or profile
conventions)". This is an explicit invitation to third parties.

### 2.3 Existing or planned workflow UI — **verified: none**

- No official visual workflow builder exists or is documented. Greps for
  "workflow builder | flow editor | dag view | graph editor" across docs and RFCs
  returned only unrelated skill docs.
- **But:** two nullable columns are reserved for "v2 workflow routing" —
  `workflow_template_id` and `current_step_key` (`hermes_cli/kanban_db.py:893-897`), plus
  `task_runs.step_key` described as "nullable and unused" (`:971-976`). No v2 spec exists
  in the repo.
- **Inferred:** Nous is not building a canvas, but the reserved columns suggest a
  *kernel-side* v2 step-routing model may come, which could reshape or absorb any
  third-party workflow layer built on today's parent-link semantics. Timing unknown.

**Third parties are already moving here — verified:**

- **PriuS2/HermesKanban** (~36★) — Flask UI with an "AI Workflow Designer" that generates
  an editable task DAG with dependency lines before creating tasks. Talks to Hermes via
  **direct `hermes_cli.kanban_db` import** (unstable — see §2.5).
- **outsourc-e/hermes-workspace** (~6.6k★) — "Multi-Agent Control Plane", tmux worker
  pools, kanban, "Conductor" decomposition. Integrates over HTTP.

### 2.4 Kanban's flow model — **verified from source**

The engine is a **status-gated dependency DAG with AND-join semantics only**.

| Capability | Available |
|---|---|
| Parent gating (fan-in, AND only) | Yes |
| Fan-out (many children on one parent) | Yes |
| Retries, failure breaker, sticky blocks | Yes |
| Fixed parallel topology (`swarm`) | Yes |
| **Conditional edges / data-dependent routing** | **No** |
| **Error outputs / failure branches** | **No** |
| **Typed data passing between tasks** | **No** |
| **Graph loops** | **No** |

Detail:

- **Edges:** `task_links(parent_id, child_id)` — two columns, **no edge type, no
  condition, no label** (`kanban_db.py:947-951`).
- **Readiness:** `recompute_ready` promotes a `todo`/`blocked` task iff **all** parents
  are in `('done','archived')` (`kanban_db.py:2007-2068`; `_parents_satisfied` `:2071-2080`).
  Cycles are rejected.
- **Error handling** is per-task, not per-edge: `consecutive_failures`/`max_retries`
  circuit breaker → `blocked`; `block_kind` routing; `block_recurrences` → `triage`.
- **Loops:** only two bounded intra-task loops — `goal_mode` (a judge loop inside one
  worker session) and the retry breaker.
- **Data passing:** a child receives a `## Parent task results` section containing each
  done parent's newest run `summary` plus free-form `metadata` JSON
  (`kanban_db.py:3699-3733`), plus attachments/comments. No typed inputs/outputs, no
  variable substitution, no artifact wiring beyond shared workspace paths.
- **Swarm** is a fixed topology (root → N workers → verifier → synthesizer), not a
  template system. Its source carries the note **"Deliberately no second scheduler."**

**Inferred consequence:** a product promising conditionals, error edges, loops or typed
data flow **cannot compile to Kanban as-is**. It needs its own orchestrator — which is
precisely the "second scheduler" Nous designed Swarm to avoid.

### 2.5 Stable interfaces to build on — **verified**

**Safe:**

| Surface | Notes |
|---|---|
| `/v1/capabilities` | Documented as "a machine-readable description of the API server's **stable surface** for external UIs, orchestrators, and plugin bridges", to be used "without depending on private Python internals". Carries `features.*` flags and an `endpoints` map. |
| `/v1/runs`, `/v1/runs/{id}`, `/v1/runs/{id}/events` (SSE), `/stop`, `/steer`, `/approval` | Multiplexed at `/p/<profile>/...`, bearer `API_SERVER_KEY`. |
| `/api/plugins/kanban/*` | Documented as the programmatic path; same `kanban_db` code as CLI, so "the three surfaces can never drift". |
| CLI `--json` | Kanban: `list, show, runs, stats, assignees, attachments, dispatch, create`, etc. Coverage elsewhere is partial. |
| Kanban lifecycle hooks | `kanban_task_claimed/completed/blocked`, `on_kanban_worker_spawned/exited/stale_claim`, `on_kanban_task_updated`, `on_kanban_dispatch_tick`. The best observability primitive available. |
| Desktop / Dashboard plugin SDKs | The sanctioned way to add a page inside the first-party UIs. |

**Unsafe:**

- **Python import paths are explicitly not a stable API.** `COMPAT_MANIFEST.md` states
  this, and compat shims are **removed on 2026-09-14**. Anything importing
  `hermes_cli.*` breaks then.
- **Direct `kanban.db` / `state.db` reads** — no schema version contract; columns added
  via `ALTER TABLE` migrations. Treat as unstable.
- **tui_gateway WebSocket JSON-RPC** — listed as a surface but with no stability
  statement. Medium risk (inferred).

> **Audit result for the existing Mission Control portal:** zero `hermes_cli` imports, so
> the 2026-09-14 shim removal does **not** affect it. Its `gateway.py` already targets
> `/v1/capabilities`, `/v1/runs` and `/v1/runs/{id}/events`, and queries `/v1/capabilities`
> at connect time. Remaining exposure is its direct read-only sqlite access to
> `kanban.db` and per-profile `state.db` — the known fault line to migrate off over time.

---

## 3. Research: competitive landscape

*V = verified from a cited source; I = inference.*

| Tool | Visual builder | Branching | Step test / pin / replay | Agent internals | License |
|---|---|---|---|---|---|
| **n8n** | Yes | Yes | Pin data, partial "Execute step", re-run past execution with pinned inputs (V) | **Partial, not black box** — Logs tab shows agent I/O; chat-model sub-node shows full messages array incl. system prompt; records `tokenUsageEstimate` (V) | Sustainable Use License (fair-code); self-host free internally, no resale (V) |
| **Dify** | Yes | Yes | Node-level debugging (I) | **Strongest of the builders** — Agent node exposes reasoning trace, per-tool outputs, iteration count, tokens, time (V) | Apache 2.0 + no multi-tenant SaaS (V) |
| **Langflow** | Yes | Limited (I) | Playground re-run; no pin/replay documented (I) | Playground shows tool calls, inputs, raw outputs; deeper traces via LangSmith/Langfuse (V) | MIT (V) |
| **Flowise** | Yes | Yes — Condition, Condition Agent, Loop, Iteration, Human Input nodes (V) | Not documented (V, absence) | Execution traces exist; Langfuse/Lunary integrations reportedly broken under AgentFlow V2 (V) | Apache 2.0 core + commercial enterprise (V) |
| **LangGraph Studio** | Renders graph from code, not drag-drop | Yes (conditional edges) | **Best-in-class — time travel, edit state at any checkpoint, fork and re-run** (V) | Full, per-node LangSmith trace links | LangGraph MIT; Studio needs LangSmith (closed) |
| **AutoGen Studio** | Yes | Weak | No | Shows agent messages; OTel | MIT/CC-BY; **AutoGen in maintenance mode since Oct 2025** (V, secondary) |
| **CrewAI / Crew Studio** | Studio is commercial | Flows: yes | Not documented | "Every agent thought, every tool call, every LLM completion" — in hosted AMP (V) | Framework MIT; Studio hosted (I) |
| **Temporal** | No (code) | Yes | Replay from event history | **Black box for LLM internals** — their own blog says activity I/O only, hence the Braintrust integration (V) | MIT |
| **Prefect / Airflow** | No | Yes / DAG-only | Retry/cache | Black box | Apache 2.0 |
| **Windmill** | Yes, with branching + approvals | Yes | Not documented | Claims "full observability on every tool call and LLM request"; prompt detail undocumented (V) | AGPLv3 |
| **Langfuse** | No | n/a | Playground only | **Full** — agent graphs, tool-call analytics, typed observations (V) | MIT, self-host (V) |
| **Arize Phoenix** | No | n/a | Evals | Full (V) | ELv2 source-available |
| **LangSmith** | No canvas | n/a | Trace replay into Studio | Full | Closed |
| **Vellum** | Yes | Yes | Evals, run traces | Agent node with tool-call traces (V, vendor source) | Closed |

### 3.1 What already exists for Hermes specifically — **verified**

- **Official web dashboard** (`:9119`): sessions with expandable message history, tool
  calls as collapsible name + JSON args, token/cost analytics, cron, skills, config. No
  reasoning-trace view, no workflow builder, no fleet view.
- **Bundled Langfuse plugin** — traces every turn, LLM generation (model, usage, cost,
  latency), tool call (args + results), token breakdown **including reasoning tokens**,
  grouped by session/task ID. **`hermes-otel`** exports the same to Phoenix, LangSmith,
  SigNoz, Jaeger.
- **Data substrate** — `state.db` (sessions, messages with `tool_calls`, FTS, per-model
  usage); ShareGPT JSONL trajectories with `<think>`, `<tool_call>`, `<tool_response>`
  blocks. Structured span timing is **not** there yet (open P3 issue #6741).
- **Documented pain matching the thesis** — issue #36682 *"Subagent delegation is a black
  box — zero visibility into child agent reasoning and tool calls"* (open, P3); subagent
  sessions appear as orphans with `parent_session_id=None` (#5122).

### 3.2 Two of my original assumptions did not survive

1. **"Generic orchestrators treat agents as black boxes."** Wrong for *native agent
   nodes*. n8n's Logs tab shows the resolved messages array including the system prompt
   and per-tool sub-node I/O; Dify's Agent node exposes a reasoning trace and tokens. The
   "green tick over a fabrication" critique holds for n8n's **HTTP Request** node — which
   is how one would call Hermes — not for those products generally.
2. **"Seeing why the model did that is the gap."** Hermes already ships the Langfuse
   plugin. `hermes plugins enable observability/langfuse` gets a user ~80% there in ten
   minutes.

### 3.3 The accurate gap statement

> No **open-source, self-hostable, drag-and-drop builder** offers LangGraph-Studio-grade
> **replay** — pin inputs at an agent node, edit state, re-run — **plus** Langfuse-grade
> internal traces, **for an agent runtime it does not own.**

Every tool that exposes internals does so because it *is* the runtime (Dify, Langflow,
CrewAI, LangGraph). **Inference:** this is partly split for good reasons — deep internals
require instrumenting the agent loop; observability vendors skip canvases because trace
data is already DAG-shaped; and replaying an *agent* step is not like pinning an HTTP
response, since a non-deterministic model yields a different trajectory. LangGraph solves
that with checkpointed state; **Hermes has no checkpoint API, only transcripts.**

---

## 4. Strongest argument against building it

Stated plainly, because it deserves to be:

> You would be building a UI over a data substrate you don't control, in a space where the
> substrate owner and two adjacent OSS products already cover ~80% of the value.

Concretely: Hermes ships a dashboard, a Kanban board with dependencies and per-run
history, a Langfuse plugin and an OTel plugin. Langfuse (MIT) already renders agent
graphs, tool-call analytics and per-generation prompts/tokens. The uncovered ~20%
(cross-subagent stitching, node-level replay, fabrication assertions) depends on Hermes
internals that are **open P3 issues** — so the product is either blocked on upstream or
forks the schema and breaks on every Hermes release.

Second-order risk: the target user — someone running a *fleet* of Hermes agents — is a
small population, and disproportionately a developer already comfortable with Langfuse
and the TUI, who may not want a canvas at all.

---

## 5. The condition that makes it a real product

Build it **only** if the differentiator is:

1. **Node-level replay with pinned tool results** — re-run a single node with the same
   resolved prompt and *mocked tool results* (pin the tool layer, not the model), then
   **diff the trajectories**. No OSS tool does this for a runtime it does not own.
2. **Fabrication assertions** — flag when a final answer cites a file no tool ever read,
   or claims an artifact that does not exist on disk. This is what would have caught the
   fabricated scan automatically. Without it, "observability" is a nicer log viewer.
3. **Cross-subagent stitching** — join parent → subagent traces, which nothing does today
   (upstream linkage is broken per #5122, so it must be reconstructed).

A canvas plus a prettier trace viewer is **not** a product. That is the honest line.

---

## 6. Proposed architecture

Do **not** extend Kanban — sit above it. The Studio engine owns the graph, conditions and
data passing; it evaluates a branch itself, then materialises *the next single task* in
Kanban.

```
Studio engine   owns: DAG, conditions, branches, error paths,
                      step I/O capture, replay, assertions
      │
      ▼  materialises one step at a time
Hermes Kanban   owns: dispatch, worker spawn with skills +
                      workspace, retries, artifacts
```

This avoids patching a vendored install that `hermes update` overwrites — a hazard proven
in practice, when a patched skill script sat unused in a downloads folder while the
profile silently ran the stale copy, causing four failed runs.

**The tension, stated honestly:** this *is* the "second scheduler" that Hermes's swarm
source says was deliberately avoided, and the reserved `workflow_template_id` /
`current_step_key` columns hint the kernel may grow its own step routing.

### Build order — the canvas is ~10% of the work and goes last

1. **Workflow spec** — declarative stages, conditions, error branches. Headless, diffable.
2. **Execution engine** — runs the spec against Kanban; owns branching and data passing.
3. **Step I/O + trace capture** — join Langfuse/OTel spans to Kanban tasks. Precondition
   for replay.
4. **Replay + trajectory diff + assertions** — the actual differentiator. Before the canvas.
5. **Canvas** — authoring and inspection UI.

---

## 7. Risks, ranked

| Risk | Detail | Mitigation |
|---|---|---|
| **High** — 80% already covered | Substrate owner ships board + dashboard; Langfuse renders agent graphs | Build only the uncontested 20% (§5) |
| **High** — depends on open upstream issues | Span timing (#6741), subagent linkage (#5122) are P3 | Reconstruct linkage yourself; don't block on upstream |
| **Medium** — v2 may absorb the layer | Reserved workflow columns hint at kernel-side routing | Keep the spec portable; avoid deep coupling |
| **Medium** — small, technical audience | Fleet operators may prefer Langfuse + TUI | Validate demand before the canvas |
| **Medium** — replay is non-deterministic | Same inputs ≠ same trajectory; no checkpoint API | Mock the tool layer, diff trajectories |
| **Low (for us)** — import shims removed 2026-09-14 | Breaks tools importing `hermes_cli.*` | Portal already clean; stay on REST/`--json` |

---

## 8. Decisions needed

- **Is the differentiator worth building?** Canvas + traces → the research says no.
  Replay + trajectory diff + fabrication assertions → genuinely uncontested.
- **Contribute or compete?** RFC #16102 invites user-space fleet dashboards; a dashboard
  plugin may reach users faster than a standalone product.
- **Portal as seed?** Grow Mission Control into this, or build the engine first and keep
  the portal as its UI layer.
- **Audience** — internal tooling for two fleets, or a product other operators adopt.
- **Observability depth** — capturing full reasoning traces and prompts per step has real
  storage and privacy implications, especially for security fleets handling evidence.

---

## 9. Sources

**Hermes:** [Kanban docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban) ·
[API server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server) ·
[Programmatic integration](https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration) ·
[Web dashboard](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard) ·
[Delegation](https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation) ·
[Trajectory format](https://hermes-agent.nousresearch.com/docs/developer-guide/trajectory-format) ·
[Session storage](https://hermes-agent.nousresearch.com/docs/developer-guide/session-storage) ·
[Langfuse plugin](https://langfuse.com/integrations/other/hermes) ·
[hermes-otel](https://briancaffey.github.io/hermes-otel/) ·
RFC [#16102](https://github.com/NousResearch/hermes-agent/issues/16102) ·
[#6741](https://github.com/NousResearch/hermes-agent/issues/6741) ·
[#36682](https://github.com/NousResearch/hermes-agent/issues/36682) ·
[#5122](https://github.com/NousResearch/hermes-agent/issues/5122) ·
[awesome-hermes-agent](https://github.com/0xNyk/awesome-hermes-agent) ·
[PriuS2/HermesKanban](https://github.com/PriuS2/HermesKanban) ·
[hermes-workspace](https://github.com/outsourc-e/hermes-workspace)

**Competitive:** [n8n agent node](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.agent) ·
[n8n debug/replay](https://docs.n8n.io/workflows/executions/debug/) ·
[n8n data pinning](https://docs.n8n.io/data/data-pinning/) ·
[n8n license](https://docs.n8n.io/sustainable-use-license/) ·
[n8n AI observability](https://blog.n8n.io/ai-agent-observability/) ·
[Dify agent node](https://docs.dify.ai/en/use-dify/nodes/agent) ·
[Langflow agents](https://docs.langflow.org/agents) ·
[Flowise AgentFlow V2](https://docs.flowiseai.com/using-flowise/agentflowv2) ·
[LangGraph time travel](https://docs.langchain.com/oss/python/langgraph/use-time-travel) ·
[CrewAI tracing](https://docs.crewai.com/en/observability/tracing) ·
[Temporal + Braintrust](https://temporal.io/blog/building-observable-ai-agents-temporal-now-integrates-with-braintrust) ·
[Windmill AI agents](https://www.windmill.dev/use-cases/ai-agents) ·
[Langfuse agent graphs](https://langfuse.com/docs/observability/features/agent-graphs)

---

*Research conducted by two parallel agents (Fable 5.1), read-only, 2026-09-11.
Claims are marked verified where sourced and inferred where reasoned.*
