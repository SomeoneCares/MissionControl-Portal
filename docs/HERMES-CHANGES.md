# Hermes-side changes (host configuration & fleet instructions)

Changes made **outside the portal code**, on the Hermes host — profile configs
under `~/.hermes/profiles/` and the fleet instruction files under
`~/pentest-fleet/` and `~/soc-fleet/`. These are not in the portal's git history,
so they are recorded here. Only changes that had a real, verified effect are listed.

Every edited file was backed up next to itself as `<name>.bak-kanban`.

---

## 1. Orchestrator → fleet-member delegation via Kanban

**Goal:** let an orchestrator assign a task to a real specialist profile
(`pt-scanner`, `soc-analyst`, …) so the actual profile runs it — visible in the
portal Tasks tab and reflected in the Agents/Office status — instead of
`delegate_task`, which only spawns a generic in-process child that is *not* the
named profile.

**How it works:** the orchestrator calls the `kanban_create` tool with
`assignee = <profile name>`. The Hermes gateway's **built-in Kanban dispatcher**
(`kanban.dispatch_in_gateway`, on by default, ~60s tick) claims the `ready` task
and spawns that real profile to work it (setting `HERMES_KANBAN_TASK`, which
auto-enables the worker's kanban tools). The specialist finishes with
`kanban_complete`. No extra service is started; nothing else was needed to run
workers — the dispatcher already existed.

### 1a. Enable the kanban tools on each orchestrator

The kanban toolset is opt-in and, on the multiplex `/p/<profile>/` API path the
portal uses, requires **two** settings in the orchestrator's own
`~/.hermes/profiles/<orch>/config.yaml`. Both are required together:

- a flat `toolsets:` grant — flips the kanban tools' visibility gate
  (`tools/kanban_tools.py`: `"kanban" in load_config().toolsets`), and
- `platform_toolsets.api_server` including `kanban` — puts kanban in the
  toolset actually resolved for the `api_server` (multiplex) platform. Using the
  `hermes-api-server` composite keeps every tool the profile had before and only
  adds kanban.

Applied to **`pt-orchestrator`** and **`soc-orchestrator`**:

```yaml
# near the top, as a top-level key:
toolsets:
  - kanban

# inside the existing platform_toolsets: block, add:
platform_toolsets:
  api_server:
    - hermes-api-server
    - kanban
  # ... existing cli/desktop/web/api/gateway/subagent entries unchanged ...
```

Requires a gateway restart (`hermes gateway restart`) to take effect.

> Why both keys: with only one, the tool stays hidden. Verified — with a single
> key the orchestrator answers "NO_KANBAN_TOOL"; with both, `kanban_list` /
> `kanban_create` are available. (Enabling kanban in the *root*
> `~/.hermes/config.yaml` does **not** work for a profile on this path.)

### 1b. Fleet routing rewritten to the Kanban model

- **`~/pentest-fleet/ROUTING.md`** — "Native delegation (`delegate_task`)"
  replaced with "Delegation via the Kanban board": the orchestrator creates one
  `kanban_create` task per stage with `assignee` = `pt-scanner` / `pt-validator`
  / `pt-reporter`, then waits for `done` before the next stage. A profile name IS
  the delegation destination. `delegate_task` is explicitly disallowed for role
  work.
- **`~/pentest-fleet/AGENTS.md`** — "Routing and performance" and the
  "Delegation gate" updated: assign with `kanban_create` (assignee = profile);
  removed the old "never treat a profile name as a delegation destination" rule,
  which contradicts the Kanban model.
- **`~/soc-fleet/ROUTING.md`** — same rewrite for the SOC fleet: assign via
  `kanban_create` to `soc-analyst` / `soc-hunter` / `soc-assessment` /
  `soc-response`; the routing table now lists the profile name per request type.

### 1d. Auto-advancing pipeline (no manual nudge between stages)

The first live run required asking the orchestrator for status after each stage so
it would fire the next one. Fixed with Kanban **task dependencies**: both ROUTING
files now tell the orchestrator to build the whole chain in ONE turn, giving each
later stage a `parents` list with the previous stage's task id. A task whose
parent is not `done` sits in `todo`; the dispatcher automatically promotes and
runs it the moment the parent finishes. Verified on this host — a child created
with `--parent <id>` lands in `todo` (gated) while the parent is `ready`, then
auto-runs on parent completion. So `pt-scanner -> pt-validator -> pt-reporter`
runs start-to-finish with no human nudging between stages.

### 1c. Durable, shared artifacts (each kanban task has an isolated ephemeral scratch workspace)

A kanban task runs in its own scratch workspace that is not shared between stages
and does not survive — the first live run's `pt-reporter` generated a PDF there,
failed to attach it, blocked, and the file was lost. Both ROUTING files now
require workers to read inputs and write deliverables to **absolute paths under a
shared durable folder** (pentest: `~/pentest-fleet/content/<engagement>/`; SOC:
the `soc_write` case store or `~/soc-fleet/cases/<case>/`), which the orchestrator
names in every `kanban_create` body. Workers must not rely on the scratch
workspace or base64 `kanban_attach`. For pentest this folder is what the portal
Content tab points at, so deliverables show up there.

### Verified end-to-end

Assigning a task to a profile (via `kanban_create` or `hermes kanban create`)
was confirmed to: appear in the portal Tasks tab; be claimed by the dispatcher
(`status: running`); spawn the real profile (a new session with `source: kanban`
in that profile's `state.db`); do the work; and reach `status: done`. Both
`pt-orchestrator` and `soc-orchestrator` were confirmed to have the
`kanban_create` / `kanban_list` tools after the config change.

---

## 2. Portal-side companion change (for reference)

Not a Hermes-side change, but required for the live status: the portal already
derived per-agent EXECUTING/ASSIGNED state from the Kanban board; it now also
folds Kanban-`EXECUTING` agents into `working_agents` so the Agents tab and
Office light up while a member is running. (In `backend/hermes_mc/server.py`,
tracked in the portal repo.)

---

## Notes / caveats

- The two-key enablement is a workaround for how the multiplex `api_server` path
  resolves toolsets (see Hermes issue #91415). If a future Hermes version changes
  this, re-verify that the orchestrators still expose `kanban_create`.
- Backups: `*.bak-kanban` beside each edited file
  (`~/.hermes/profiles/pt-orchestrator/config.yaml.bak-kanban`,
  `~/.hermes/profiles/soc-orchestrator/config.yaml.bak-kanban`,
  `~/pentest-fleet/ROUTING.md.bak-kanban`, `~/pentest-fleet/AGENTS.md.bak-kanban`,
  `~/soc-fleet/ROUTING.md.bak-kanban`).
- To reproduce on a new fleet: add the two config keys to that fleet's
  orchestrator profile, write its `ROUTING.md` to assign via `kanban_create` to
  the fleet's profile names, and restart the gateway. Kanban is gateway-wide, so
  the portal Tasks tab and per-agent status pick it up with no portal changes.
