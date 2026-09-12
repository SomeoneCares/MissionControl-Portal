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

---

## 2. Stop reflexive tool calls on greetings (AGENTS + skill de-dup)

**Symptom:** on a bare "hi", orchestrators reflexively called `kanban_show`
(fails — no task id) and `pt-scanner` reflexively called `skill_view` on the
`vulnerability-scan` skill (the first call failed on an ambiguous id).

**Root cause (Hermes core, not editable):**
- `agent/prompt_builder.py:1319` injects a `## Skills` block into every profile
  that has a skill installed: *"Before replying … you MUST load it with
  skill_view(name)."* Every profile has at least the `hermes-agent` skill, so
  the reflex is fleet-wide; `pt-scanner` / `soc-assessment` also have
  `vulnerability-scan`.
- Same class as the earlier injected Kanban worker-guidance (`KANBAN_GUIDANCE`)
  that hit the orchestrators.

**Fixes (host-side):**
- Removed a byte-identical duplicate skill install nested at
  `~/.hermes/profiles/pt-scanner/skills/vulnerability-scan/vulnerability-scan/`
  (leftover from the v3 re-install). It made the `vulnerability-scan` id
  ambiguous, which is why the first `skill_view` failed. Backup:
  `~/.hermes-mc/skill-dup-backup-*/vulnerability-scan`.
- Added a **"## Greetings and non-tasks"** section to every profile AGENTS.md
  (pt-orchestrator; pt-worker file shared by pt-scanner/validator/reporter; soc
  file shared by all 5 soc profiles): a greeting/status/capability question with
  no concrete authorized target is not work — reply in plain language and call
  NO tool first; `## Skills` and Kanban "load/execute before replying" apply
  only once a real in-scope task exists.
- Removed stale native-delegation guidance that conflicted with the Kanban model:
  pt-orchestrator AGENTS.md "one delegate_task call at a time" -> "delegate via
  kanban_create … not delegate_task"; pt-worker AGENTS.md -> "workers do not
  delegate"; soc AGENTS.md "read specialist SOUL through soc_role before
  delegating / native workers inherit tools" -> Kanban-model wording.

**Scope note:** worker profiles legitimately get the injected Kanban worker
protocol when the dispatcher spawns them with `HERMES_KANBAN_TASK` (correct —
they are the assigned worker), so only the *chat/portal* path needed the
greeting guard. The two orchestrators already carry the "you have no assigned
task, never call kanban_show" override from section 1.

**Follow-up — broadened the orchestrator greeting guard (SOUL):** the first guard
only said "do not call any *kanban* tool first," so pt-orchestrator still read
`scope.json`/`ROUTING.md` on "hi" and once tried a confabulated
`execute_code` with `from hermes_tools import read_file, write_file, ...`
(ImportError — Hermes tools are not importable in the code sandbox). Broadened
both orchestrators' SOUL greeting clause to "call NO tool first — not kanban,
read_file, or execute_code; do not read scope.json/ROUTING.md," added an explicit
"execute_code is a plain Python sandbox; never `from hermes_tools import ...`"
note, and made pt-orchestrator's "Read ROUTING.md" / "read scope.json before
acting" imperatives conditional on there being real work. Backups:
`SOUL.md.bak-kanban3` for both orchestrators.

**Verified:** `pt-scanner` on "hi" -> `TOOLS CALLED: []`; `pt-orchestrator` on
"hi" -> `TOOLS CALLED: []`, clean replies.

**Backups:** `AGENTS.md.bak-kanban2` beside each of the 9 edited files;
`pt-scanner/SOUL.md.bak-kanban2`; `{pt,soc}-orchestrator/SOUL.md.bak-kanban3`.

---

## 3. pt-reporter reporting skill (colour PDF + charts)

**Goal:** ROUTING says the Reporter writes `report.pdf`, but pt-reporter had no
skill installed and nothing documented how a PDF should actually be rendered.

**Verified toolchain on this host** (the agent installs nothing):
- `pandoc` with `--pdf-engine=xelatex`
- TeX Live: `xcolor`, `colortbl`, `booktabs`, `longtable`, `fontspec`
- `matplotlib` 3.6.3 — Basem ran `apt install python3-matplotlib`; used headless (`Agg`)

Note: `python3-venv`/`ensurepip` are absent and PEP 668 marks the interpreter
externally managed, so apt is the correct install route here, not pip.

**Added** `~/.hermes/profiles/pt-reporter/skills/pentest-report/`:
- `SKILL.md` — frontmatter per the official "Creating Skills" contract;
  `requires_toolsets: [terminal, file]` (both of which pt-reporter has, so the
  skill is never hidden by `_skill_should_show`)
- `scripts/make_charts.py` — severity-distribution + top-priority charts
- `scripts/build_report.py` — colour-coded Markdown -> `report.pdf` via pandoc/xelatex

`hermes --profile pt-reporter skills list` reports it as local / enabled.

**Verified on a fixture run folder:** `report.md` 3,631 B; `severity_distribution.png`
21,545 B; `top_priority.png` 55,856 B; `report.pdf` 108,393 B. A finding title
containing `&`, `%`, `_` and `#` rendered without breaking LaTeX. `build_report.py`
exits non-zero when no PDF is produced, so a failed render cannot be reported as
success (matches the reporter SOUL rule "never claim a PDF exists until the file
is generated and verified").

**ROUTING.md** — the Reporter stage now points at `build_report.py` instead of
leaving the PDF step undefined.

**Known ambiguity (flagged, NOT changed):** `run_scan.py` also writes `report.md`
into the run folder, and ROUTING assigns `report.md` to both the Scanner and the
Reporter stage — so the Reporter's report overwrites the scanner's raw one.
Needs a decision (e.g. rename one of them) before the next full engagement.

---

## 4. First end-to-end test: two real defects found and fixed

A live run (`scan xlabsinnovations.com, safe profile`) failed. Two independent
root causes, both now fixed.

### 4a. The scanner skill was running unpatched code

`run_scan.py` does `json.loads(preflight.sh --json)` (lines 34-36), so a bad
preflight is fatal. The **deployed** `preflight.sh` was the original, unpatched
file — the fix written earlier had been applied only to the copy under
`C:\Users\basem\Downloads\...` and never deployed to the profile. Two defects in
the deployed copy:

- `set -euo pipefail` + `version() { ... | head -n1 }` — `head` exits early, the
  upstream tool takes SIGPIPE, `pipefail` propagates it and `set -e` aborts the
  script mid-`printf`, producing truncated JSON and **exit 141**.
- nuclei/testssl.sh emit **ANSI escape codes** (measured: 5 and 1 control chars)
  straight into the JSON, so it will not parse even when complete.

Reproduced both directly: with `pipefail` the run aborts at nuclei and returns
141; without it, it survives with exit 0.

Deployed the patched `preflight.sh` (1609 -> 2085 B) and `bootstrap.sh`
(5698 -> 8068 B) into the profile; backups kept as `*.bak-predeploy`. Verified
after: **exit 0, JSON VALID, `required_ready: true`**.

Checked first whether Hermes has a managed update path — it does not for this
skill: `hermes skills list` reports it `source: local`, `list-modified` says
nothing is tracked, and `skills diff` errors with *"not a tracked bundled skill"*.
`update`/`reset`/`diff`/`repair-official` apply only to bundled/hub skills, so
replacing the files on disk is the correct mechanism here.

Note: `soc-assessment` holds the same stale scripts, but its config disables
`skills`, `terminal` and `file`, so it can never execute them (see the vestigial
skill noted in the profile check-up).

### 4b. The orchestrator did not decompose the work

It created **one** task instead of the three-stage chain, and never read
ROUTING.md. Consequences: the scanner's body also demanded the report (the
reporter's job); no run folder was set; the title/body contained non-ASCII U+2011
hyphens; and its first `kanban_create` failed outright with
*"completion_contract must be local-only, OWNER/REPO, or an exact GitHub PR URL"*.

Verified against the schema (`tools/kanban_tools_schemas.py`) and dispatcher
source before changing anything:

- `workspace_kind` enum is `scratch|dir|worktree`; **`scratch` is deleted on
  completion**, so results would have been destroyed even on success.
- A `dir` workspace is **never** garbage-collected — `kanban_ops.py:305` skips any
  `workspace_kind != "scratch"` — and dispatch sets `TERMINAL_CWD` to it, so it
  becomes the worker's cwd. Nothing **creates** it, so it must exist beforehand.
- `skills` force-loads a skill into the worker, but names "must match skills
  installed on the assignee's profile".
- `completion_contract` defaults to `local-only`; anything else is rejected.
- Swarm is explicitly for parallel workers -> verifier -> synthesizer; a
  sequential chain should use individual `kanban_create` calls with `parents`.

Changes: ROUTING.md gained the `workspace_kind`/`workspace_path`/`skills` contract,
an updated three-call template, a corrected argument-rules block, and a rewritten
"Artifacts & output" section (it previously asserted every workspace was ephemeral).
pt-orchestrator's SOUL gained a 6-point MANDATORY pre-delegation checklist —
read ROUTING.md, `mkdir -p` the run folder, create all three linked tasks in one
turn, give each stage only its own job, omit `completion_contract`, ASCII only.

**Not yet verified end-to-end** — the fixes are deployed and the gateway restarted,
but no new scan has been run since.
