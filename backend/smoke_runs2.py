"""Test the runs API through a profile prefix (multiplexed)."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from hermes_mc import config
from hermes_mc.gateway import GatewayClient, GatewayError

cfg = config.load()
gw = GatewayClient(cfg.gateway_url, cfg.gateway_key)
prof = "soc-analyst"
print("submit via prefix…", flush=True)
try:
    rid = gw.submit_run("answer in one line: what is triage?", profile=prof,
                        model_options={"reasoning": {"enabled": True, "effort": "low"}})
    print("run_id:", rid, flush=True)
except Exception as e:
    print("submit err:", type(e).__name__, e); sys.exit()

print("stream events via prefix…", flush=True)
kinds = {}
try:
    shown = 0
    for ev in gw.run_events(rid, profile=prof):
        if shown < 4:
            print("  RAW:", str(ev)[:200], flush=True); shown += 1
        t = ev.get("type") or ev.get("name") or "?"
        kinds[t] = kinds.get(t, 0) + 1
        if t == "reasoning.available":
            print("  REASONING:", str(ev.get("text", ""))[:120], flush=True)
        if t.startswith("run.") and any(s in t for s in ("completed", "failed", "interrupted")):
            break
except Exception as e:
    print("events err:", type(e).__name__, e, flush=True)
print("kinds:", kinds, flush=True)
