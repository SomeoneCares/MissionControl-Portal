"""Client for the Hermes gateway API (the OpenAI-compatible server on port 8642).

Every endpoint used here was verified live against hermes-agent 0.21.0:

    GET  /health                     public
    GET  /health/detailed            bearer
    GET  /v1/capabilities            bearer  → the machine-readable feature manifest
    GET  /v1/models                  bearer
    GET  /v1/skills                  bearer
    GET  /v1/toolsets                bearer
    POST /v1/chat/completions        bearer  (stream optional)
    POST /v1/runs                    bearer
    GET  /v1/runs/{id}               bearer
    GET  /v1/runs/{id}/events        bearer  (SSE)
    POST /v1/runs/{id}/stop|steer|approval

The portal asks ``/v1/capabilities`` at connect time and lights up features per host, rather
than assuming any endpoint exists. ``audio_api`` and ``realtime_voice`` report ``false`` on a
stock gateway, which is why voice is not wired here.

stdlib only — ``urllib`` — so the backend has no third-party dependency to install.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Iterator, Optional


class GatewayError(RuntimeError):
    def __init__(self, message: str, *, status: int = 0):
        super().__init__(message)
        self.status = status


@dataclass
class GatewayHealth:
    ok: bool
    status_code: int
    latency_ms: int
    version: str = ""
    error: str = ""


class GatewayClient:
    """Thin, synchronous client. One instance per connected Hermes host."""

    def __init__(self, base_url: str, api_key: str = "", *, timeout: float = 10.0):
        self.base = (base_url or "").rstrip("/")
        self.key = api_key or ""
        self.timeout = timeout

    # -- low level -------------------------------------------------------------

    def _headers(self, extra: Optional[dict] = None) -> dict:
        h = {"Accept": "application/json"}
        if self.key:
            h["Authorization"] = f"Bearer {self.key}"
        if extra:
            h.update(extra)
        return h

    def _request(self, method: str, path: str, *, body: Optional[dict] = None,
                 timeout: Optional[float] = None) -> Any:
        url = f"{self.base}{path}"
        data = None
        headers = self._headers()
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout or self.timeout) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode("utf-8")[:500]
            except Exception:
                pass
            raise GatewayError(f"HTTP {e.code} for {method} {path}: {detail}", status=e.code)
        except urllib.error.URLError as e:
            raise GatewayError(f"cannot reach gateway at {url}: {e.reason}")
        except (TimeoutError, json.JSONDecodeError) as e:
            raise GatewayError(f"bad response from {url}: {e}")

    # -- health & discovery ----------------------------------------------------

    def health(self) -> GatewayHealth:
        """Unauthenticated liveness probe plus latency. Never raises."""
        start = time.perf_counter()
        try:
            req = urllib.request.Request(f"{self.base}/health", headers={"Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                latency = int((time.perf_counter() - start) * 1000)
                raw = resp.read().decode("utf-8")
                data = json.loads(raw) if raw else {}
                return GatewayHealth(True, resp.status, latency, str(data.get("version", "")))
        except urllib.error.HTTPError as e:
            return GatewayHealth(False, e.code, int((time.perf_counter() - start) * 1000),
                                 error=f"HTTP {e.code}")
        except Exception as e:  # noqa: BLE001 — health must never raise
            return GatewayHealth(False, 0, int((time.perf_counter() - start) * 1000), error=str(e))

    def capabilities(self) -> dict:
        """The feature manifest. Drives which portal features light up for this host."""
        return self._request("GET", "/v1/capabilities") or {}

    def models(self) -> list[dict]:
        data = self._request("GET", "/v1/models") or {}
        return list(data.get("data", []))

    def skills(self) -> list[dict]:
        data = self._request("GET", "/v1/skills") or {}
        return list(data.get("data", []))

    def toolsets(self) -> list[dict]:
        data = self._request("GET", "/v1/toolsets") or {}
        return list(data.get("data", []))

    # -- chat ------------------------------------------------------------------

    def chat(self, messages: list[dict], *, model: str = "hermes-agent",
             temperature: float = 0.7) -> dict:
        """Non-streaming chat completion. Returns the parsed OpenAI-shaped response."""
        return self._request("POST", "/v1/chat/completions", body={
            "model": model, "messages": messages,
            "temperature": temperature, "stream": False,
        }, timeout=120.0)

    def chat_stream(self, messages: list[dict], *, model: str = "hermes-agent",
                    temperature: float = 0.7) -> Iterator[dict]:
        """Streaming chat completion. Yields parsed SSE ``data:`` chunks until ``[DONE]``."""
        url = f"{self.base}/v1/chat/completions"
        payload = json.dumps({
            "model": model, "messages": messages,
            "temperature": temperature, "stream": True,
        }).encode("utf-8")
        headers = self._headers({"Content-Type": "application/json", "Accept": "text/event-stream"})
        req = urllib.request.Request(url, data=payload, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=180.0) as resp:
                for line in resp:
                    line = line.decode("utf-8").strip()
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        yield json.loads(data)
                    except json.JSONDecodeError:
                        continue
        except urllib.error.HTTPError as e:
            raise GatewayError(f"HTTP {e.code} on chat stream", status=e.code)
        except urllib.error.URLError as e:
            raise GatewayError(f"cannot reach gateway: {e.reason}")

    # -- runs (live telemetry & control) --------------------------------------

    def run_status(self, run_id: str) -> dict:
        return self._request("GET", f"/v1/runs/{run_id}") or {}

    def run_events(self, run_id: str) -> Iterator[dict]:
        """SSE stream of a run's event trace. Yields parsed events until the stream closes."""
        url = f"{self.base}/v1/runs/{run_id}/events"
        headers = self._headers({"Accept": "text/event-stream"})
        req = urllib.request.Request(url, headers=headers, method="GET")
        with urllib.request.urlopen(req, timeout=300.0) as resp:
            for line in resp:
                line = line.decode("utf-8").strip()
                if line.startswith("data:"):
                    data = line[5:].strip()
                    try:
                        yield json.loads(data)
                    except json.JSONDecodeError:
                        continue

    def run_stop(self, run_id: str) -> dict:
        return self._request("POST", f"/v1/runs/{run_id}/stop") or {}

    def run_steer(self, run_id: str, text: str) -> dict:
        return self._request("POST", f"/v1/runs/{run_id}/steer", body={"text": text}) or {}
