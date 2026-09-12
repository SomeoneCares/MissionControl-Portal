import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { State, HealthInfo, Agent } from "../types";
import { api, chatStream, type ChatMessage, type ChatAgents, type ToolEvent, type Attachment, type ApprovalChoice, type SubagentEvent, type FleetGroupsView } from "../api/client";
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
  if (file.size > 20 * 1024 * 1024) return null; // 20 MB cap — base64 stays under the 32 MB request-body limit
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onerror = () => resolve(null);
    if (isImage) {
      r.onload = () => resolve({ name: file.name, kind: "image", size: file.size, dataUrl: String(r.result) });
      r.readAsDataURL(file);
    } else if (isText) {
      r.onload = () => resolve({ name: file.name, kind: "text", size: file.size, text: String(r.result) });
      r.readAsText(file);
    } else {
      // PDF, Office docs, etc — send the bytes; the backend converts to structured Markdown.
      r.onload = () => resolve({ name: file.name, kind: "file", size: file.size, dataUrl: String(r.result) });
      r.readAsDataURL(file);
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
  const [groups, setGroups] = useState<FleetGroupsView | null>(null);
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
    setAttachMsg(skipped > 0 ? `${skipped} file(s) skipped — each file must be under 20 MB.` : null);
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

  useEffect(() => { api.fleets().then(setGroups).catch(() => setGroups(null)); }, []);

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

  // group the roster by fleet (only when multiplexing shows the full profile roster)
  type RosterEntry = (typeof roster)[number];
  const rosterSections: { name: string; accent: string; items: RosterEntry[] }[] | null =
    info?.multiplex && (groups?.fleets.length ?? 0) > 0
      ? [
          ...groups!.fleets.map((f) => ({
            name: f.name,
            accent: f.accent,
            items: roster.filter((r) => r.profile && f.members.includes(r.profile)),
          })),
          {
            name: "Ungrouped",
            accent: "",
            items: roster.filter((r) => !r.profile || !groups!.fleets.some((f) => f.members.includes(r.profile!))),
          },
        ].filter((s) => s.items.length > 0)
      : null;

  const renderRosterItem = (r: RosterEntry) => {
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
  };

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
      onReasoning: (text) => chatStore.patchLast(key, (last) => {
        // accumulate reasoning blocks: keep the full chain of thought rather than replacing.
        const prev = last.reasoning || "";
        if (!prev) last.reasoning = text;
        else if (text.startsWith(prev) || prev.endsWith(text)) last.reasoning = text.length >= prev.length ? text : prev;
        else last.reasoning = prev + "\n\n" + text;
      }),
      onTool: (t) => chatStore.patchLast(key, (last) => { last.tools = [...(last.tools ?? []), t]; }),
      onSubagent: (s) => chatStore.patchLast(key, (last) => { last.subagents = [...(last.subagents ?? []), s]; }),
      onApproval: (a) => chatStore.patchLast(key, (last) => { last.approval = a; }),
      onDone: (usage) => {
        chatStore.patchLast(key, (last) => { last.streaming = false; if (usage) last.usage = usage; });
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
          {rosterSections ? (
            rosterSections.map((sec) => (
              <div key={sec.name} className="roster-group">
                <div className="roster-group-head">
                  <span className={`fleet-swatch ${sec.name === "Ungrouped" ? "ungrouped" : ""}`}
                        style={sec.name === "Ungrouped" ? undefined : { background: sec.accent || "var(--ember)" }} />
                  <span className="mono roster-group-name">{sec.name}</span>
                </div>
                <ul>{sec.items.map(renderRosterItem)}</ul>
              </div>
            ))
          ) : (
            <ul>{roster.map(renderRosterItem)}</ul>
          )}
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
          <div className="chat-conv-head">
            <span className="mono chat-conv-agent">
              {activeProfile ? (fleetByName[activeProfile]?.name ?? activeProfile) : "Fleet"}
              {turns.length > 0 && <span className="chat-conv-count"> · {turns.length} msg{turns.length === 1 ? "" : "s"}</span>}
            </span>
            <button className="chat-newchat mono" onClick={clearThread}
                    disabled={turns.length === 0}
                    title="Start a fresh conversation — clears this agent's thread so past turns don't bias the next one">
              ✚ New chat
            </button>
          </div>
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
                {t.role === "assistant" && (reasoningIsDistinct(t.reasoning, t.content) || (t.tools && t.tools.length > 0) || (t.subagents && t.subagents.length > 0)) && (
                  <Thinking reasoning={t.reasoning} content={t.content} tools={t.tools} subagents={t.subagents} live={!!t.streaming} />
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
                {t.role === "assistant" && !t.streaming && t.usage && (t.usage.total_tokens || t.usage.input_tokens) && (
                  <div className="turn-usage mono">
                    {(t.usage.total_tokens ?? ((t.usage.input_tokens ?? 0) + (t.usage.output_tokens ?? 0))).toLocaleString()} tokens
                    {t.usage.input_tokens != null && t.usage.output_tokens != null
                      ? ` (${t.usage.input_tokens.toLocaleString()} in · ${t.usage.output_tokens.toLocaleString()} out)` : ""}
                  </div>
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

interface ToolRow { name: string; command: string; status: "running" | "done" | "error"; duration?: number; }
function pairTools(tools: ToolEvent[]): ToolRow[] {
  const rows: ToolRow[] = [];
  for (const t of tools) {
    if (t.phase === "started") {
      rows.push({ name: t.name, command: t.preview, status: "running" });
    } else {
      const r = [...rows].reverse().find((x) => x.name === t.name && x.status === "running");
      if (r) { r.status = t.error ? "error" : "done"; r.duration = t.duration; if (!r.command && t.preview) r.command = t.preview; }
      else rows.push({ name: t.name, command: t.preview, status: t.error ? "error" : "done", duration: t.duration });
    }
  }
  return rows;
}

interface SubRow { id: string; goal: string; model?: string; status: string; duration?: number; tokens?: number; summary?: string; tail?: string; }
function pairSubagents(subs: SubagentEvent[]): SubRow[] {
  const rows: SubRow[] = [];
  for (const s of subs) {
    if (s.phase === "start") {
      rows.push({ id: s.id || "", goal: s.goal || "", model: s.model, status: "running" });
    } else {
      const r = [...rows].reverse().find((x) => (s.id && x.id === s.id) || x.status === "running");
      const patch = { status: s.status || "completed", duration: s.duration, tokens: s.tokens, summary: s.summary, tail: s.output_tail, goal: r?.goal || s.goal || "" };
      if (r) Object.assign(r, patch);
      else rows.push({ id: s.id || "", model: s.model, ...patch });
    }
  }
  return rows;
}

// The runs API sometimes mirrors the final answer into the reasoning channel (local gpt-oss does
// this — there is no separate analysis stream). When the "thinking" text is really just the answer
// again, treat it as not-distinct so it is never rendered a second time.
export function reasoningIsDistinct(reasoning?: string, answer?: string): boolean {
  const r = (reasoning ?? "").replace(/\s+/g, " ").trim();
  if (!r) return false;
  const a = (answer ?? "").replace(/\s+/g, " ").trim();
  if (!a) return true;                       // answer not in yet — show what we have
  if (r === a || a.includes(r) || r.includes(a)) return false;  // one contains the other → dup
  const n = Math.min(r.length, a.length);
  let i = 0;
  while (i < n && r[i] === a[i]) i++;
  return i / n <= 0.9;                        // >90% shared prefix → treat as a duplicate
}

function Thinking({ reasoning, content, tools, subagents, live }: { reasoning?: string; content?: string; tools?: ToolEvent[]; subagents?: SubagentEvent[]; live: boolean }) {
  const [open, setOpen] = useState(true);
  const rows = pairTools(tools ?? []);
  const subs = pairSubagents(subagents ?? []);
  const showReasoning = reasoningIsDistinct(reasoning, content);
  return (
    <div className={`thinking ${live ? "live" : ""}`}>
      <button className="thinking-head mono" onClick={() => setOpen((o) => !o)}>
        <span className="thinking-icon">{live ? "◐" : "◑"}</span>
        {live ? "thinking…" : "thought process"}
        {subs.length > 0 && <span className="thinking-count"> · {subs.length} delegated</span>}
        {rows.length > 0 && <span className="thinking-count"> · {rows.length} tool{rows.length === 1 ? "" : "s"}</span>}
        <span className="thinking-toggle">{open ? "hide" : "show"}</span>
      </button>
      {open && (
        <div className="thinking-body">
          {showReasoning && reasoning && <pre className="reasoning-text">{reasoning}</pre>}
          {subs.length > 0 && (
            <ul className="subagent-timeline">
              {subs.map((s, i) => (
                <li key={i} className={`subagent-ev ${s.status === "running" ? "running" : s.status.includes("fail") ? "error" : "done"}`}>
                  <div className="subagent-row1">
                    <span className="subagent-icon">⇩</span>
                    <span className="mono subagent-name">delegated worker{s.model ? ` · ${s.model}` : ""}</span>
                    <span className="subagent-meta mono">
                      {s.status === "running" ? "running…" : s.status}
                      {typeof s.duration === "number" ? ` · ${s.duration.toFixed(1)}s` : ""}
                      {typeof s.tokens === "number" ? ` · ${s.tokens.toLocaleString()} tok` : ""}
                    </span>
                  </div>
                  {s.goal && <div className="subagent-goal">{s.goal}</div>}
                  {(s.summary || s.tail) && <div className="subagent-result">{s.summary || s.tail}</div>}
                </li>
              ))}
            </ul>
          )}
          {rows.length > 0 && (
            <ul className="tool-timeline">
              {rows.map((r, i) => (
                <li key={i} className={`tool-ev ${r.status}`}>
                  <span className={`tool-dot ${r.status}`} />
                  <span className="mono tool-name">{r.name}</span>
                  {r.command && <code className="tool-cmd">{r.command}</code>}
                  <span className="tool-meta mono">
                    {r.status === "running" ? "running…" : r.status === "error" ? "failed" : "ok"}
                    {typeof r.duration === "number" ? ` · ${r.duration.toFixed(2)}s` : ""}
                  </span>
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
