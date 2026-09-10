import { useEffect, useRef, useState } from "react";
import type { State, HealthInfo } from "../types";
import { chatStream, type ChatMessage } from "../api/client";

// Chat — a real conversation with the live gateway agent. Every reply is a genuine agent turn
// streamed token by token from /v1/chat/completions. Requires the gateway (:8642) on the host;
// where it is off, the tab says so instead of pretending.

interface Turn extends ChatMessage {
  streaming?: boolean;
}

export function Chat({ health }: { state: State; health: HealthInfo | null }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<null | (() => void)>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const gatewayUp = health?.gateway?.ok ?? false;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns]);

  const send = () => {
    const text = input.trim();
    if (!text || busy) return;
    const history: Turn[] = [...turns, { role: "user", content: text }];
    setTurns([...history, { role: "assistant", content: "", streaming: true }]);
    setInput("");
    setBusy(true);

    const payload: ChatMessage[] = history.map((t) => ({ role: t.role, content: t.content }));
    abortRef.current = chatStream(payload, {
      onDelta: (d) =>
        setTurns((ts) => {
          const copy = [...ts];
          const last = copy[copy.length - 1];
          if (last?.streaming) last.content += d;
          return copy;
        }),
      onDone: () => {
        setTurns((ts) => ts.map((t) => (t.streaming ? { ...t, streaming: false } : t)));
        setBusy(false);
        abortRef.current = null;
      },
      onError: (e) =>
        setTurns((ts) => {
          const copy = [...ts];
          const last = copy[copy.length - 1];
          if (last?.streaming) {
            last.content = last.content || `⚠ ${e}`;
            last.streaming = false;
          }
          setBusy(false);
          return copy;
        }),
    });
  };

  const stop = () => {
    abortRef.current?.();
    setTurns((ts) => ts.map((t) => (t.streaming ? { ...t, streaming: false } : t)));
    setBusy(false);
  };

  return (
    <div className="chat">
      <section className="chat-head card">
        <div>
          <span className="eyebrow">Comms</span>
          <h1 className="display chat-title">Talk to the <span className="ember">fleet.</span></h1>
          <p className="muted chat-sub">
            Messages run a real agent turn on the gateway and stream back token by token.
          </p>
        </div>
        <span className={`pill ${gatewayUp ? "ok" : "warn"}`}>
          {gatewayUp ? "gateway live" : "gateway off"}
        </span>
      </section>

      {!gatewayUp ? (
        <section className="card chat-unavailable">
          <p>
            The gateway API (<span className="mono">:8642</span>) is not enabled on this host, so
            live chat is unavailable. Enable it in Hermes
            (<span className="mono">API_SERVER_ENABLED=true</span>) to talk to the fleet from here.
          </p>
        </section>
      ) : (
        <section className="card chat-window">
          <div className="chat-messages" ref={scrollRef}>
            {turns.length === 0 && (
              <div className="chat-empty mono">
                Send a message to start a real agent turn.
              </div>
            )}
            {turns.map((t, i) => (
              <div key={i} className={`bubble ${t.role}`}>
                <span className="bubble-role mono">{t.role === "user" ? "you" : "hermes"}</span>
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
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={1}
            />
            {busy ? (
              <button className="btn-primary" onClick={stop}>Stop</button>
            ) : (
              <button className="btn-primary" onClick={send} disabled={!input.trim()}>Send</button>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
