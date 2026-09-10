import { useEffect, useRef, useState } from "react";
import type { State, HealthInfo, Agent } from "../types";
import { api, chatStream, type ChatMessage, type ChatAgents } from "../api/client";

// Chat — the comms surface. Pick an agent on the left, talk to it on the right. Each reply is a
// real streamed agent turn. Per-agent selection uses the gateway's multiplex prefix; when
// multiplexing is off, only the single default gateway agent is reachable and the tab says so.
//
// Layers still to come on this same surface: reasoning stream, tool-call timeline, stop/steer,
// approvals, attachments, and voice (push-to-talk + spoken replies).

interface Turn extends ChatMessage {
  streaming?: boolean;
}

const DEFAULT_KEY = "__default__"; // the single gateway agent when multiplexing is off

export function Chat({ state, health }: { state: State; health: HealthInfo | null }) {
  const [info, setInfo] = useState<ChatAgents | null>(null);
  const [current, setCurrent] = useState<string>(DEFAULT_KEY);
  const [threads, setThreads] = useState<Record<string, Turn[]>>({});
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const abortRef = useRef<null | (() => void)>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const gatewayUp = health?.gateway?.ok ?? false;

  useEffect(() => {
    if (gatewayUp) api.chatAgents().then(setInfo).catch(() => setInfo(null));
  }, [gatewayUp]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [threads, current]);

  const fleetByName: Record<string, Agent> = Object.fromEntries(
    state.fleet.map((a) => [a.agent, a]),
  );

  // roster entries: full fleet when multiplexing is on, else a single gateway agent
  const roster: { key: string; label: string; sub: string; profile: string | null }[] =
    info?.multiplex
      ? info.agents.map((a) => ({
          key: a,
          label: fleetByName[a]?.name ?? a,
          sub: fleetByName[a]?.role || a,
          profile: a,
        }))
      : [{ key: DEFAULT_KEY, label: "Gateway agent", sub: "the profile this gateway serves", profile: null }];

  useEffect(() => {
    // keep a valid selection when the roster resolves
    if (!roster.find((r) => r.key === current)) setCurrent(roster[0]?.key ?? DEFAULT_KEY);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info]);

  const turns = threads[current] ?? [];
  const isBusy = !!busy[current];
  const activeProfile = roster.find((r) => r.key === current)?.profile ?? null;

  const send = () => {
    const text = input.trim();
    if (!text || isBusy) return;
    const key = current;
    const history: Turn[] = [...(threads[key] ?? []), { role: "user", content: text }];
    setThreads((t) => ({ ...t, [key]: [...history, { role: "assistant", content: "", streaming: true }] }));
    setInput("");
    setBusy((b) => ({ ...b, [key]: true }));

    const payload: ChatMessage[] = history.map((t) => ({ role: t.role, content: t.content }));
    const patchLast = (fn: (t: Turn) => void) =>
      setThreads((t) => {
        const copy = [...(t[key] ?? [])];
        const last = copy[copy.length - 1];
        if (last) fn(last);
        return { ...t, [key]: copy };
      });

    abortRef.current = chatStream(payload, activeProfile, {
      onDelta: (d) => patchLast((last) => { if (last.streaming) last.content += d; }),
      onDone: () => {
        patchLast((last) => { last.streaming = false; });
        setBusy((b) => ({ ...b, [key]: false }));
        abortRef.current = null;
      },
      onError: (e) => {
        patchLast((last) => { last.content = last.content || `⚠ ${e}`; last.streaming = false; });
        setBusy((b) => ({ ...b, [key]: false }));
      },
    });
  };

  const stop = () => {
    abortRef.current?.();
    setThreads((t) => {
      const copy = [...(t[current] ?? [])];
      const last = copy[copy.length - 1];
      if (last?.streaming) last.streaming = false;
      return { ...t, [current]: copy };
    });
    setBusy((b) => ({ ...b, [current]: false }));
  };

  if (!gatewayUp) {
    return (
      <div className="chat">
        <ChatHead multiplex={false} />
        <section className="card chat-unavailable">
          <p>
            The gateway API (<span className="mono">:8642</span>) is not enabled on this host, so
            live chat is unavailable. Enable it in Hermes
            (<span className="mono">API_SERVER_ENABLED=true</span>) to talk to the fleet from here.
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="chat">
      <ChatHead multiplex={info?.multiplex ?? false} />
      <div className="chat-layout">
        {/* roster */}
        <aside className="chat-roster card">
          <span className="eyebrow roster-title">
            {info?.multiplex ? `Fleet · ${roster.length}` : "Agent"}
          </span>
          <ul>
            {roster.map((r) => {
              const a = r.profile ? fleetByName[r.profile] : null;
              return (
                <li key={r.key}>
                  <button
                    className={`roster-item ${r.key === current ? "active" : ""}`}
                    onClick={() => setCurrent(r.key)}
                  >
                    <span className="ini">{a ? a.initials : "GW"}</span>
                    <span className="roster-meta">
                      <span className="roster-name">{r.label}</span>
                      <span className="mono muted roster-sub">{r.sub}</span>
                    </span>
                    {busy[r.key] && <span className="roster-busy" />}
                  </button>
                </li>
              );
            })}
          </ul>
          {!info?.multiplex && (
            <p className="mono roster-note">
              Per-agent selection needs multiplexing enabled on the gateway.
            </p>
          )}
        </aside>

        {/* conversation */}
        <section className="card chat-window">
          <div className="chat-messages" ref={scrollRef}>
            {turns.length === 0 && (
              <div className="chat-empty mono">
                Send a message to start a real agent turn
                {activeProfile ? ` with ${fleetByName[activeProfile]?.name ?? activeProfile}` : ""}.
              </div>
            )}
            {turns.map((t, i) => (
              <div key={i} className={`bubble ${t.role}`}>
                <span className="bubble-role mono">
                  {t.role === "user" ? "you" : (activeProfile ? (fleetByName[activeProfile]?.name ?? "hermes") : "hermes")}
                </span>
                <div className="bubble-body">
                  {t.content}
                  {t.streaming && <span className="caret" />}
                </div>
              </div>
            ))}
          </div>
          <div className="chat-input-row">
            <textarea
              className="chat-input"
              placeholder="Message the fleet…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
              }}
              rows={1}
            />
            {isBusy ? (
              <button className="btn-primary" onClick={stop}>Stop</button>
            ) : (
              <button className="btn-primary" onClick={send} disabled={!input.trim()}>Send</button>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function ChatHead({ multiplex }: { multiplex: boolean }) {
  return (
    <section className="chat-head card">
      <div>
        <span className="eyebrow">Comms</span>
        <h1 className="display chat-title">Talk to the <span className="ember">fleet.</span></h1>
        <p className="muted chat-sub">
          Messages run a real agent turn on the gateway and stream back token by token.
        </p>
      </div>
      <span className={`pill ${multiplex ? "ok" : "warn"}`}>
        {multiplex ? "per-agent · live" : "single agent"}
      </span>
    </section>
  );
}
