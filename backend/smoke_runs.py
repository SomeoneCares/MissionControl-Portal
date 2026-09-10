"""Smoke test: the runs API — submit a run, stream its events, show reasoning + tools."""
import json, sys, urllib.request
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from hermes_mc import config

def log(*a):
    print(*a, flush=True)

cfg = config.load()
base, key = cfg.gateway_url, cfg.gateway_key
log(f"gateway={base} key={'set' if key else 'MISSING'}")
H = {"Authorization": f"Bearer {key}", "Content-Type": "application/json", "Accept": "application/json"}

# 1) submit a run (reasoning requested)
body = json.dumps({
    "input": "Think briefly, then answer in one line: why keep a runbook?",
    "model_options": {"reasoning": {"enabled": True, "effort": "low"}},
    "stream": True,
}).encode()
req = urllib.request.Request(f"{base}/v1/runs", data=body, headers=H, method="POST")
try:
    with urllib.request.urlopen(req, timeout=30) as r:
        sub = json.loads(r.read())
except urllib.error.HTTPError as e:
    log("submit HTTPError", e.code, e.read().decode()[:300]); sys.exit()
except Exception as e:
    log("submit ERR", type(e).__name__, e); sys.exit()
run_id = sub.get("run_id") or sub.get("id") or (sub.get("run") or {}).get("id")
log("submitted run:", run_id, "| keys:", list(sub.keys()))
if not run_id:
    log("no run_id — response:", json.dumps(sub)[:400]); sys.exit()

# 2) stream events
req = urllib.request.Request(f"{base}/v1/runs/{run_id}/events",
                            headers={"Authorization": f"Bearer {key}", "Accept": "text/event-stream"})
kinds = {}
answer = ""
n = 0
with urllib.request.urlopen(req, timeout=120) as r:
    for raw in r:
        line = raw.decode("utf-8").strip()
        if not line.startswith("data:"):
            continue
        try:
            ev = json.loads(line[5:].strip())
        except ValueError:
            continue
        t = ev.get("type") or ev.get("event") or ev.get("name") or "?"
        kinds[t] = kinds.get(t, 0) + 1
        n += 1
        if t == "reasoning.available":
            log(f"  [REASONING] {str(ev.get('text',''))[:200]!r}")
        elif t == "message.delta":
            answer += ev.get("delta", "")
        elif t.startswith("tool."):
            log(f"  [{t}] {ev.get('tool') or ev.get('name') or ''} {str(ev.get('preview',''))[:80]}")
        elif t.startswith("run."):
            log(f"  [{t}] { {k: ev[k] for k in ev if k in ('status','total_tokens','reasoning_tokens')} }")
        if t.startswith("run.") and ("completed" in t or "failed" in t or "interrupted" in t):
            break
        if n > 200:
            break
log("answer:", answer[:200])
log("event kinds seen:", kinds)
