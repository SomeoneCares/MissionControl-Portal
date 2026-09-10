"""Smoke test: prove the gateway client against a live Hermes host. Real data only."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from hermes_mc import config
from hermes_mc.gateway import GatewayClient

cfg = config.load()
print(f"mode={cfg.mode}  gateway={cfg.gateway_url}  key={'set' if cfg.gateway_key else 'MISSING'}")

gw = GatewayClient(cfg.gateway_url, cfg.gateway_key)

h = gw.health()
print(f"health: ok={h.ok} status={h.status_code} latency={h.latency_ms}ms version={h.version!r}")
if not h.ok:
    print("gateway not reachable — stopping"); sys.exit(1)

caps = gw.capabilities()
feats = caps.get("features", {})
on = [k for k, v in feats.items() if v is True]
off = [k for k, v in feats.items() if v is False]
print(f"capabilities: {len(on)} on, {len(off)} off")
print("  live :", ", ".join(sorted(on)[:8]), "…")
print("  off  :", ", ".join(k for k in ("audio_api", "realtime_voice", "admin_config_rw", "jobs_admin") if k in off))

models = gw.models()
print(f"models: {[m.get('id') for m in models]}")

skills = gw.skills()
print(f"skills: {len(skills)} — first: {skills[0].get('name') if skills else '(none)'}")

tsets = gw.toolsets()
print(f"toolsets: {[t.get('name') for t in tsets][:6]}")
print("\nOK — gateway client verified against real data.")
