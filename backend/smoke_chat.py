"""Smoke test: real chat against the gateway (benign prompt)."""
import sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from hermes_mc import config
from hermes_mc.gateway import GatewayClient, GatewayError

cfg = config.load()
gw = GatewayClient(cfg.gateway_url, cfg.gateway_key)
print(f"gateway={cfg.gateway_url} key={'set' if cfg.gateway_key else 'MISSING'}", flush=True)

# 1) non-streaming
try:
    t0 = time.time()
    r = gw.chat([{"role": "user", "content": "Reply with exactly: hello from hermes"}])
    ch = r.get("choices", [{}])[0]
    print(f"[non-stream] {time.time()-t0:.1f}s model={r.get('model')}", flush=True)
    print("  content:", (ch.get("message", {}).get("content") or "")[:200], flush=True)
except GatewayError as e:
    print("[non-stream] GatewayError:", e, "status:", getattr(e, "status", None), flush=True)
except Exception as e:
    print("[non-stream] ERR:", type(e).__name__, e, flush=True)

# 2) streaming
try:
    t0 = time.time()
    n = 0; text = ""
    for chunk in gw.chat_stream([{"role": "user", "content": "Reply with exactly: hello again"}]):
        d = (chunk.get("choices", [{}])[0].get("delta", {}) or {}).get("content") or ""
        text += d; n += 1
    print(f"[stream] {time.time()-t0:.1f}s chunks={n} text={text[:120]!r}", flush=True)
except Exception as e:
    print("[stream] ERR:", type(e).__name__, e, flush=True)
