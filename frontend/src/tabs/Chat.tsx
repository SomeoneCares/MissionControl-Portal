import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { State, HealthInfo, Agent } from "../types";
import { api, chatStream, type ChatMessage, type ChatAgents, type ToolEvent, type Attachment, type ApprovalChoice } from "../api/client";
import { chatStore, type Turn } from "../store/chatStore";

// Approval choices arrive as bare strings (Hermes) or objects (older paths). Normalise both to a
// value we send back and a readable label, and a tone so approve/deny read at a glance.
function choiceValue(c: ApprovalChoice): string {
  return typeof c === "string" ? c : (c.value || c.id || c.label || "");
}
const CHOICE_LABELS: Record<string, string> = {
  once: "Approve once", approve: "Approve", yes: "Approve", allow: "Approve once", accept: "Approve",
  session: "Approve for session", always: "Always allow", all: "Approve all",
  deny: "Deny", reject: "Deny", no: "Deny", cancel: "Deny", decline: "Deny", skip: "Skip",
};
function choiceLabel(c: ApprovalChoice): string {
  const raw = (choiceValue(c) || "").trim();
  return CHOICE_LABELS[raw.toLowerCase()] || raw || "Choose";
}
function choiceTone(val: string): string {
  const v = val.toLowerCase();
  if (/(deny|reject|^no$|cancel|decline)/.test(v)) return "danger";
  if (/(approve|once|yes|allow|accept|always|all|session)/.test(v)) return "ok";
  return "";
}

const TEXT_EXT = /\.(md|markdown|txt|json|csv|tsv|ya?ml|toml|ini|log|xml|html?|css|js|ts|tsx|jsx|py|sh|bash|sql|go|rs|c|cpp|h|java|rb|php)$/i;

async function readAttachment(file: File): Promise<Attachment | null> {
  const isImage = file.type.startsWith("image/");
  const isText = file.type.startsWith("text/") || file.type === "application/json" || TEXT_EXT.test(file.name);
  if (!isImage && !isText) return null;
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onerror = () => resolve(null);
    if (isImage) {
      r.onload = () => resolve({ name: file.name, kind: "image", size: file.size, dataUrl: String(r.result) });
      r.readAsDataURL(file);
    } else {
      r.onload = () => resolve({ name: file.name, kind: "text", size: file.size, text: String(r.result) });
      r.readAsText(file);
    }
  });
}

// Chat — the comms surface. Pick an agent on the left, talk to it on the right. Each reply is a
// real streamed agent turn. Threads persist across tab navigation and page reloads via a store
// backed by localStorage (per-viewer history). Per-agent selection uses the gateway's multiplex
// prefix; when multiplexing is off, only the single default gateway agent is reachable.
//
// Layers still to come on this same surface: tool-call timeline detail, stop/steer, approvals,
// attachments, and voice (push-to-talk + spoken replies).

const DEFAULT_KEY = "__default__"; // the single gateway agent when multiplexing is off

// abort handlers live outside the component so a turn survives leaving and returning to the tab
const aborts: Record<string, () => void> = {};

export function Chat({ state, health }: { state: State; health: HealthInfo | null }) {
  const [info, setInfo] = useState<ChatAgents | null>(null);
  const [current, setCurrent] = useState<string>(DEFAULT_KEY);
  const threads = useSyncExternalStore(chatStore.subscribe, chatStore.snapshot);
  const [input, setInput] = useState("");
  const [draft, setDraft] = useState<Attachment[]>([]);
  const [dropping, setDropping] = useState(false);
  const [attachMsg, setAttachMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const addFiles = async (files: FileList | File[]) => {
    const arr = Array.from(files);
    const read = await Promise.all(arr.map(readAttachment));
    const ok = read.filter((a): a is Attachment => a !== null);
    const skipped = arr.length - ok.length;
    if (ok.length) setDraft((d) => [...d, ...ok]);
    setAttachMsg(skipped > 0 ? `${skipped} file(s) skipped — only text files and images are supported.` : null);
  };

  const onPaste = (e: React.ClipboardEvent) => {
    // let text paste through natively; capture any pasted files/images
    const files = e.clipboardData?.files;
    if (files && files.length > 0) {
      e.preventDefault();
      addFiles(files);
    }
  };

  const isStreaming = (key: string) => {
    const t = threads[key];
    return !!t && t.length > 0 && !!t[t.length - 1].streaming;
  };

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
  const isBusy = isStreaming(current);
  const activeProfile = roster.find((r) => r.key === current)?.profile ?? null;

  const send = () => {
    const text = input.trim();
    if ((!text && draft.length === 0) || isBusy) return;
    const key = current;
    const atts = draft.map((a) => ({ name: a.name, kind: a.kind }));
    const history: Turn[] = [...(threads[key] ?? []),
      { role: "user", content: text, atts: atts.length ? atts : undefined, ts: Date.now() }];
    chatStore.setThread(key, [...history, { role: "assistant", content: "", streaming: true, ts: Date.now() }]);
    chatStore.persist();
    const attachments = draft;
    setInput("");
    setDraft([]);
    setAttachMsg(null);

    const payload: ChatMessage[] = history.map((t) => ({ role: t.role, content: t.content }));
    aborts[key] = chatStream(payload, activeProfile, {
      onRun: (runId) => chatStore.patchLast(key, (last) => { last.runId = runId; }),
      onDelta: (d) => chatStore.patchLast(key, (last) => { if (last.streaming) last.content += d; }),
      onReasoning: (text) => chatStore.patchLast(key, (last) => { last.reasoning = text; }),
      onTool: (t) => chatStore.patchLast(key, (last) => { last.tools = [...(last.tools ?? []), t]; }),
      onApproval: (a) => chatStore.patchLast(key, (last) => { last.approval = a; }),
      onDone: () => {
        chatStore.patchLast(key, (last) => { last.streaming = false; });
        chatStore.persist();
        delete aborts[key];
      },
      onError: (e) => {
        chatStore.patchLast(key, (last) => { last.content = last.content || `⚠ ${e}`; last.streaming = false; });
        chatStore.persist();
        delete aborts[key];
      },
    }, attachments);
  };

  const stop = () => {
    // stop the real run on the gateway, then stop consuming the stream
    const t = threads[current];
    const runId = t?.[t.length - 1]?.runId;
    if (runId) api.stopRun(runId, activeProfile).catch(() => {});
    aborts[current]?.();
    delete aborts[current];
    chatStore.patchLast(current, (last) => { if (last.streaming) last.streaming = false; });
    chatStore.persist();
  };

  const respondApproval = (choice: string) => {
    const t = threads[current];
    const last = t?.[t.length - 1];
    if (!last?.runId) return;
    api.approve(last.runId, choice, activeProfile).catch(() => {});
    chatStore.patchLast(current, (l) => { l.approval = null; });
  };

  const clearThread = () => {
    aborts[current]?.();
    delete aborts[current];
    chatStore.clear(current);
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
                    {isStreaming(r.key) && <span className="roster-busy" />}
                    {!isStreaming(r.key) && (threads[r.key]?.length ?? 0) > 0 && (
                      <span className="roster-count mono">{threads[r.key].length}</span>
                    )}
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
        <section
          className={`card chat-window ${dropping ? "dropping" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setDropping(true); }}
          onDragLeave={() => setDropping(false)}
          onDrop={(e) => { e.preventDefault(); setDropping(false); if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files); }}
        >
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
                {t.role === "assistant" && (t.reasoning || (t.tools && t.tools.length > 0)) && (
                  <Thinking reasoning={t.reasoning} tools={t.tools} live={!!t.streaming} />
                )}
                {(t.content || t.role === "user" || !t.streaming) && (
                  <div className="bubble-body">
                    {t.content || (t.role === "assistant" && !t.streaming ? "(no answer)" : "")}
                    {t.streaming && t.content && <span className="caret" />}
                  </div>
                )}
                {t.atts && t.atts.length > 0 && (
                  <div className="bubble-atts">
                    {t.atts.map((a, j) => (
                      <span key={j} className="att-chip mono">
                        {a.kind === "image" ? "🖼" : "📄"} {a.name}
                      </span>
                    ))}
                  </div>
                )}
                {t.role === "assistant" && t.streaming && !t.content && !t.reasoning && (
                  <div className="bubble-body thinking-dots"><span /><span /><span /></div>
                )}
                {t.role === "assistant" && t.approval && (
                  <div className="approval">
                    <span className="mono approval-label">⚑ approval needed</span>
                    {t.approval.text && <p className="approval-text">{t.approval.text}</p>}
                    <div className="approval-choices">
                      {(t.approval.choices.length ? t.approval.choices : ["approve", "deny"]).map((c, k) => {
                        const val = choiceValue(c);
                        return (
                          <button key={k} className={`approval-btn ${choiceTone(val)}`}
                                  onClick={() => respondApproval(val)}>
                            {choiceLabel(c)}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
          {(draft.length > 0 || attachMsg) && (
            <div className="draft-atts">
              {draft.map((a, i) => (
                <span key={i} className="att-chip mono">
                  {a.kind === "image" ? "🖼" : "📄"} {a.name}
                  <button className="att-remove" onClick={() => setDraft((d) => d.filter((_, j) => j !== i))} aria-label="Remove">✕</button>
                </span>
              ))}
              {attachMsg && <span className="mono att-note">{attachMsg}</span>}
            </div>
          )}
          <div className="chat-input-row">
            {turns.length > 0 && (
              <button className="chat-clear mono" onClick={clearThread} title="Clear this conversation">clear</button>
            )}
            <button className="chat-attach" onClick={() => fileRef.current?.click()} title="Attach files" aria-label="Attach files">＋</button>
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }}
            />
            <textarea
              className="chat-input"
              placeholder="Message the fleet… (attach with ＋, paste, or drop files)"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPaste={onPaste}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
              }}
              rows={1}
            />
            {isBusy ? (
              <button className="btn-primary" onClick={stop}>Stop</button>
            ) : (
              <button className="btn-primary" onClick={send} disabled={!input.trim() && draft.length === 0}>Send</button>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function Thinking({ reasoning, tools, live }: { reasoning?: string; tools?: ToolEvent[]; live: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <div className={`thinking ${live ? "live" : ""}`}>
      <button className="thinking-head mono" onClick={() => setOpen((o) => !o)}>
        <span className="thinking-icon">{live ? "◐" : "◑"}</span>
        {live ? "thinking…" : "thought process"}
        <span className="thinking-toggle">{open ? "hide" : "show"}</span>
      </button>
      {open && (
        <div className="thinking-body">
          {reasoning && <p className="reasoning-text">{reasoning}</p>}
          {tools && tools.length > 0 && (
            <ul className="tool-timeline">
              {tools.map((t, i) => (
                <li key={i} className={`tool-ev ${t.phase}`}>
                  <span className="tool-dot" />
                  <span className="mono tool-name">{t.name}</span>
                  <span className="mono tool-phase">{t.phase}</span>
                  {t.preview && <span className="tool-preview">{t.preview}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
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
