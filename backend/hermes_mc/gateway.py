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

    def profile_reachable(self, profile: str) -> bool:
        """True if the gateway serves ``profile`` at its multiplex prefix (i.e. multiplexing is
        on and this profile is in the served set). A single-profile gateway returns 404 here."""
        try:
            req = urllib.request.Request(
                f"{self.base}/p/{profile}/v1/models", headers=self._headers())
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return resp.status == 200
        except Exception:  # noqa: BLE001 — any failure means not reachable
            return False

    def toolsets(self) -> list[dict]:
        data = self._request("GET", "/v1/toolsets") or {}
        return list(data.get("data", []))

    # -- chat ------------------------------------------------------------------

    @staticmethod
    def _chat_path(profile: Optional[str]) -> str:
        """Route to a specific profile via the multiplex prefix, or the default profile."""
        return f"/p/{profile}/v1/chat/completions" if profile else "/v1/chat/completions"

    def chat(self, messages: list[dict], *, model: str = "hermes-agent",
             temperature: float = 0.7, profile: Optional[str] = None) -> dict:
        """Non-streaming chat completion. Returns the parsed OpenAI-shaped response."""
        return self._request("POST", self._chat_path(profile), body={
            "model": model, "messages": messages,
            "temperature": temperature, "stream": False,
        }, timeout=120.0)

    def chat_stream(self, messages: list[dict], *, model: str = "hermes-agent",
                    temperature: float = 0.7, profile: Optional[str] = None) -> Iterator[dict]:
        """Streaming chat completion. Yields parsed SSE ``data:`` chunks until ``[DONE]``."""
        url = f"{self.base}{self._chat_path(profile)}"
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

    @staticmethod
    def _p(profile: Optional[str], path: str) -> str:
        return f"/p/{profile}{path}" if profile else path

    def submit_run(self, user_input: str, *, profile: Optional[str] = None,
                   conversation_history: Optional[list] = None,
                   model_options: Optional[dict] = None) -> str:
        """Start an agent run. Returns the run id. History threads the conversation; model_options
        can request reasoning (``{"reasoning": {"enabled": True, "effort": "low"}}``)."""
        body: dict = {"input": user_input, "stream": True}
        if conversation_history:
            body["conversation_history"] = conversation_history
        if model_options:
            body["model_options"] = model_options
        data = self._request("POST", self._p(profile, "/v1/runs"), body=body, timeout=30.0) or {}
        return data.get("run_id") or data.get("id") or ""

    def run_status(self, run_id: str, *, profile: Optional[str] = None) -> dict:
        return self._request("GET", self._p(profile, f"/v1/runs/{run_id}")) or {}

    def run_events(self, run_id: str, *, profile: Optional[str] = None) -> Iterator[dict]:
        """SSE stream of a run's event trace. Yields parsed events until the run ends."""
        url = f"{self.base}{self._p(profile, f'/v1/runs/{run_id}/events')}"
        headers = self._headers({"Accept": "text/event-stream"})
        req = urllib.request.Request(url, headers=headers, method="GET")
        try:
            resp = urllib.request.urlopen(req, timeout=300.0)
        except urllib.error.HTTPError as e:
            raise GatewayError(f"HTTP {e.code} on run events", status=e.code)
        except urllib.error.URLError as e:
            raise GatewayError(f"cannot reach run events: {e.reason}")
        with resp:
            for line in resp:
                line = line.decode("utf-8").strip()
                if line.startswith("data:"):
                    data = line[5:].strip()
                    try:
                        yield json.loads(data)
                    except json.JSONDecodeError:
                        continue

    def run_stop(self, run_id: str, *, profile: Optional[str] = None) -> dict:
        return self._request("POST", self._p(profile, f"/v1/runs/{run_id}/stop")) or {}

    def run_steer(self, run_id: str, text: str, *, profile: Optional[str] = None) -> dict:
        return self._request("POST", self._p(profile, f"/v1/runs/{run_id}/steer"),
                             body={"input": text}) or {}
