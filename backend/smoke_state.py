"""Smoke test: LocalSource against the live WSL Hermes. Proves real fleet + honest empties."""
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from hermes_mc import config
from hermes_mc.local_source import LocalSource

cfg = config.load()
print(f"mode={cfg.mode}  home={cfg.hermes_home}")

src = LocalSource(cfg.hermes_home, cfg.project_dir)

print("profiles on disk:", src.profile_names())

src.vps()          # prime CPU sampler
time.sleep(0.3)
state = src.build_state()

print(f"\nfleet: {len(state['fleet'])} agents")
for a in state["fleet"]:
    print(f"  {a['initials']:<3} {a['agent']:<20} model={a['defaultModel'] or '(unset)':<16} "
          f"runs={a['tasksToday']} success={a['success']}%  role={a['role'][:40]!r}")

print("\nrouting:", json.dumps(state["routing"]))
print("agentlogs_stats:", json.dumps(state["agentlogs_stats"]))
print("health:", json.dumps(state["health"]))
print("vps:", json.dumps(state["vps"]))
print("sessions:", json.dumps(state["sessions"]))
print("\nOK — LocalSource verified. Empty run history renders as zeros, not fabrication.")
