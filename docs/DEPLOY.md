# Deploying Hermes Mission Control

The portal runs **beside a Hermes host** (local mode: direct DB + gateway access) or **against a
remote one** (remote mode: through a token-authed bridge + the gateway API). This guide covers a
fresh-host install and a smoke-test checklist for the first run.

> **Version note.** The portal reads Hermes' on-disk state (`~/.hermes/kanban.db`,
> `agent-logs.db`, `gateway_state.json`) and the gateway's `/p/<profile>/…` endpoints. It is
> developed against **hermes-agent 0.21.x**. On a different major/minor, watch the Runs, Tasks,
> and Chat surfaces first — schema/endpoint drift shows up there. Confirm with `hermes --version`.

---

## Prerequisites

- **Python 3.10+** (the backend is pure standard library — no runtime pip packages for core features).
- **Node 18+ / npm** — only to build the front end (the built bundle is not committed).
- A reachable **Hermes gateway** (local `http://127.0.0.1:8642` by default) with its `API_SERVER_KEY`.
- *Optional, for PDF/Word document attachments and Word export:* `pymupdf4llm`, `pypdf`,
  `python-docx` (pip) and `pandoc` (OS package). Absent, those features degrade gracefully.
- *Optional, for the in-reader document preview* (rendered page images): `poppler-utils`
  (`pdftoppm`, small — needed for **PDF** preview) and **LibreOffice** (`soffice`, large — needed
  for **DOCX/PPTX/XLSX** preview). Without them the reader falls back to a download link.

---

## Quick start (one command)

```bash
git clone <this-repo> hermes-mission-control
cd hermes-mission-control
installer/install.sh --content-deps
```

`install.sh` builds the front end, (with `--content-deps`) installs the optional extras, sets up a
service, and prints the URL. Flags:

| Flag | Effect |
| :-- | :-- |
| `--content-deps` | also pip-install the PDF/Word extras (and check for `pandoc`) |
| `--system` | install a **system-wide** systemd unit (needs `sudo`) instead of a `--user` unit |
| `--no-service` | just build — run it yourself with `installer/run-portal.sh` |
| `--no-build` | skip the front-end build (requires an existing `frontend/dist`) |

Environment (all optional): `HMC_HOST` (default `0.0.0.0`), `HMC_PORT` (default `51770`).

Then open `http://<host-ip>:51770` and sign in with **admin / admin** — change it immediately in
**Settings → Access**.

---

## Manual bootstrap (no installer)

```bash
# 1. build the front end
cd frontend && npm install && npm run build && cd ..

# 2. (optional) content extras
python3 -m pip install --user pymupdf4llm pypdf python-docx   # + install pandoc from your OS

# 3. run it (foreground)
cd backend && HMC_HOST=0.0.0.0 HMC_PORT=51770 python3 -m hermes_mc.server
```

Or detached, restartable: `bash installer/run-portal.sh` (stop with
`pkill -f 'python3 -u -m hermes_mc.server'`).

---

## Modes & configuration

Mode is auto-detected: a readable `~/.hermes/gateway_state.json` ⇒ **local**, else **remote**.
All settings are environment variables (or set in the UI where noted):

| Var | Meaning | Default |
| :-- | :-- | :-- |
| `HMC_HOST` / `HMC_PORT` | bind address / port | `0.0.0.0` / `51770` |
| `HMC_MODE` | force `local` or `remote` | auto |
| `HMC_GATEWAY_URL` | Hermes gateway base URL | `http://127.0.0.1:8642` |
| `API_SERVER_KEY` | gateway bearer key | read from `~/.hermes/.env` (local) |
| `HMC_PROJECT_DIR` | where the portal keeps its own files | `~/.hermes-mc` |
| `CONTENT_DIR` | default content library folder | `<project_dir>/content` |
| `HMC_KANBAN_DB` / `HMC_AGENT_LOGS_DB` | override the Hermes DB paths | `~/.hermes/kanban.db`, project dir |
| `HMC_PORTAL_USER` / `HMC_PORTAL_PASSWORD` | fix credentials via env (disables in-UI change) | seeded `admin`/`admin` |

The portal creates `~/.hermes-mc/` on first run (`connections.json`, `fleet-groups.json`,
`branding.json`, `portal-settings.json`, `board.db`). Nothing there is committed.

Remote mode: add each host in **Settings → Connections** (bridge URL for dashboard data and/or
gateway URL for chat, each with its own token). Content and writes are read-only over a bare
gateway; full read/write needs local mode or the host-side bridge.

---

## First-run smoke test

Run these on the fresh host and note anything that isn't right. Tail the log alongside:
`tail -f ~/.hermes-mc/portal.log`.

1. **Boots & serves.** `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:51770/api/health` → `200`.
   Page loads; you can sign in; you changed the admin password.
2. **Overview.** Health strip shows the gateway **live** (or an honest **down**); CPU/RAM real; no
   `NaN`/blank tiles.
3. **Agents.** The card count matches the host's real profiles (`hermes profile list`). Auto-seed
   grouped them by name prefix (or everything is **Ungrouped** — both are valid). Open one → its
   Model/Files/Skills load.
4. **Fleets.** Create a fleet, rename/recolour it, assign a profile via the drawer, decommission it
   — the profile falls back to Ungrouped and no real profile was touched.
5. **Chat.** If the gateway multiplexes, the roster lists profiles grouped by fleet; send a message
   and get a **streamed** reply with reasoning/tool events. If not multiplexed, a single gateway
   agent answers.
6. **Runs.** Real runs appear from `agent-logs`; failed rows render; a run's detail opens.
7. **Tasks.** The live kanban board loads its columns/cards (Hermes `kanban`).
8. **Content.** Documents list (or an honest empty state) with stat tiles + colour-coded authors.
   Set a per-fleet folder in **Settings → Fleet content libraries**; the tab groups by fleet. Open a
   markdown doc (renders inline); open a **PDF/DOCX** — with poppler/LibreOffice installed you get a
   rendered page-image preview + an **Original** download, otherwise a download link (both correct).
9. **Office.** Skyline + Armillary render N buildings/bodies for the real fleet; with distinct fleet
   accents set, the fleets read as different colours; executing agents pulse green.
10. **LAN reach.** Open `http://<host-ip>:51770` from another device on the network.

Watch the log for tracebacks throughout — every screen should trace to real data or say it's empty.

---

## Troubleshooting

- **Blank page / "run: cd frontend && npm run build".** The front end isn't built — run the build
  step (or `install.sh`).
- **Gateway "down".** Check `HMC_GATEWAY_URL` and that `API_SERVER_KEY` matches `~/.hermes/.env`;
  confirm the gateway is up (`curl -H "Authorization: Bearer <key>" $HMC_GATEWAY_URL/v1/models`).
- **Runs/Tasks empty or erroring.** Likely a Hermes version/schema mismatch — confirm 0.21.x, and
  point `HMC_KANBAN_DB` / `HMC_AGENT_LOGS_DB` at the right files if non-standard.
- **Can't reach it over the LAN.** The portal binds `0.0.0.0`; the block is usually the host
  firewall. (On WSL2 mirrored networking, add an inbound rule for the port.)
- **Service didn't start.** `systemctl --user status hermes-mc` (or `sudo systemctl status
  hermes-mc` for `--system`), or run `installer/run-portal.sh` and read `~/.hermes-mc/portal.log`.
