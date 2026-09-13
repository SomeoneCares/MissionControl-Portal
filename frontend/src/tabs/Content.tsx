import { useEffect, useMemo, useState } from "react";
import { api, type ContentDoc, type FleetGroupsView } from "../api/client";

// Content — everything the fleet has written. Browse by author (colour-coded) or fleet, read text
// documents inline, and preview binary ones (PDF/DOCX/PPTX/XLSX) as rendered page images with an
// "Original" download of the source file.

const TEXT_KINDS = new Set(["md", "txt", "html", "htm", "csv", "json", "log", ""]);
const isTextDoc = (d: ContentDoc) => TEXT_KINDS.has((d.kind ?? "md").toLowerCase());
const isMarkdown = (d: ContentDoc) => (d.kind ?? "md").toLowerCase() === "md";

// a stable colour + initials per author, so agents read consistently across the list and chips
function agentColor(a: string): string {
  let h = 0;
  for (let i = 0; i < a.length; i++) h = (h * 31 + a.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 52% 52%)`;
}
function agentInitials(a: string): string {
  return (a || "—").replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase() || "—";
}
function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!t) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  const d = Math.floor(s / 86400);
  if (d > 0) return `${d}d ago`;
  const h = Math.floor(s / 3600);
  if (h > 0) return `${h}h ago`;
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ago` : "just now";
}
function fmtSize(b: number): string {
  return b >= 1024 ? `${(b / 1024).toFixed(1)} KB` : `${b} B`;
}

interface PreviewInfo { supported: boolean; pages: number; reason?: string; }

export function Content() {
  const [docs, setDocs] = useState<ContentDoc[] | null>(null);
  const [groups, setGroups] = useState<FleetGroupsView | null>(null);
  const [agent, setAgent] = useState("all");
  const [open, setOpen] = useState<ContentDoc | null>(null);
  const [body, setBody] = useState<string>("");
  const [loadingDoc, setLoadingDoc] = useState(false);
  const [editing, setEditing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [preview, setPreview] = useState<PreviewInfo | null>(null);

  const reload = () => api.content().then((d) => setDocs(d.docs));
  useEffect(() => { reload(); }, []);
  useEffect(() => { api.fleets().then(setGroups).catch(() => setGroups(null)); }, []);

  const agents = useMemo(
    () => ["all", ...Array.from(new Set((docs ?? []).map((d) => d.agent).filter(Boolean)))],
    [docs],
  );
  const list = (docs ?? []).filter((d) => agent === "all" || d.agent === agent);

  // group the doc list by the fleet whose content folder each doc came from (source-based),
  // only when not already narrowed to a single author
  const docSections: { name: string; accent: string; docs: ContentDoc[] }[] | null =
    agent === "all" && (groups?.fleets.length ?? 0) > 0
      ? [
          ...groups!.fleets.map((f) => ({
            name: f.name, accent: f.accent,
            docs: list.filter((d) => d.fleet === f.id),
          })),
          {
            name: "Ungrouped", accent: "",
            docs: list.filter((d) => !d.fleet || !groups!.fleets.some((f) => f.id === d.fleet)),
          },
        ].filter((s) => s.docs.length > 0)
      : null;

  const openDoc = async (d: ContentDoc) => {
    setOpen(d); setBody(""); setEditing(false); setMsg(null); setPreview(null);
    setLoadingDoc(true);
    if (isTextDoc(d)) {
      try { const r = await api.contentRead(d.path); setBody(r.content); } catch { setBody("(failed to load)"); }
    } else {
      // binary → ask for a rendered page-image preview; the server falls back to unsupported
      try { setPreview(await api.contentPreview(d.path)); }
      catch { setPreview({ supported: false, pages: 0, reason: "preview unavailable" }); }
    }
    setLoadingDoc(false);
  };

  const save = async () => {
    if (!open) return;
    try { await api.contentSave(open.path, body); setEditing(false); setMsg("Saved."); reload(); }
    catch (e) { setMsg(String(e)); }
  };

  const remove = async () => {
    if (!open || !confirm(`Delete "${open.title}"?`)) return;
    try { await api.contentDelete(open.path); setOpen(null); reload(); }
    catch (e) { setMsg(String(e)); }
  };

  const createDoc = async (a: string, title: string) => {
    try {
      const r = await api.contentCreate(a, title);
      setCreating(false);
      await reload();
      const d = (await api.content()).docs.find((x) => x.path === r.path);
      if (d) openDoc(d);
    } catch (e) { setMsg(String(e)); }
  };

  const renderDocItem = (d: ContentDoc) => (
    <li key={d.path}>
      <button className={`content-item doc-row ${open?.path === d.path ? "active" : ""}`} onClick={() => openDoc(d)}>
        <span className="doc-avatar" style={{ background: agentColor(d.agent || "?") }} title={d.agent}>{agentInitials(d.agent)}</span>
        <span className="doc-meta">
          <span className="content-item-title">{d.title}</span>
          <span className="mono muted doc-sub">{relTime(d.modified_at)} · {(d.kind || "md").toUpperCase()} · {fmtSize(d.size)}</span>
        </span>
        <span className="content-kind mono doc-badge">{(d.kind || "md").toUpperCase()}</span>
      </button>
    </li>
  );

  return (
    <div className="content-tab">
      <section className="content-head card">
        <div>
          <span className="eyebrow">Agent output</span>
          <h1 className="display content-title">The <span className="ember">library.</span></h1>
        </div>
        <div className="content-head-right">
          <button className="btn-primary" onClick={() => setCreating(true)}>+ New doc</button>
        </div>
      </section>

      {docs && docs.length > 0 && (
        <section className="content-stats">
          <div className="card stat-tile">
            <span className="eyebrow">Total docs</span>
            <div className="display stat-tile-num tabular">{docs.length}</div>
          </div>
          <div className="card stat-tile">
            <span className="eyebrow">Agents writing</span>
            <div className="display stat-tile-num tabular">{new Set(docs.map((d) => d.agent).filter(Boolean)).size}</div>
          </div>
          <div className="card stat-tile stat-tile-latest">
            <span className="eyebrow">Latest</span>
            <div className="stat-latest-title">{docs[0].title}</div>
            <span className="mono muted stat-latest-sub">{docs[0].agent || "—"} · {relTime(docs[0].modified_at)}</span>
          </div>
        </section>
      )}

      {creating && <NewDocModal agents={agents} onClose={() => setCreating(false)} onCreate={createDoc} />}

      {docs === null ? (
        <p className="mono muted pane-loading">loading…</p>
      ) : docs.length === 0 ? (
        <div className="card"><p className="empty-block mono">No documents written yet on this host.</p></div>
      ) : (
        <div className="content-layout">
          <aside className="content-list-pane card">
            <div className="content-filter">
              {agents.map((a) => (
                <button key={a} className={`filter-btn ${a === agent ? "active" : ""}`} onClick={() => setAgent(a)}>
                  {a !== "all" && <span className="chip-dot" style={{ background: agentColor(a) }} />}
                  {a}
                </button>
              ))}
            </div>
            {docSections ? (
              docSections.map((sec) => (
                <div key={sec.name} className="content-group">
                  <div className="content-group-head">
                    <span className={`fleet-swatch ${sec.name === "Ungrouped" ? "ungrouped" : ""}`}
                          style={sec.name === "Ungrouped" ? undefined : { background: sec.accent || "var(--ember)" }} />
                    <span className="mono content-group-name">{sec.name}</span>
                    <span className="mono muted content-group-count">{sec.docs.length}</span>
                  </div>
                  <ul className="content-list">{sec.docs.map(renderDocItem)}</ul>
                </div>
              ))
            ) : (
              <ul className="content-list">{list.map(renderDocItem)}</ul>
            )}
          </aside>
          <section className="content-reader card">
            {!open ? (
              <p className="empty-block mono">Select a document to read it.</p>
            ) : loadingDoc ? (
              <p className="mono muted pane-loading">loading…</p>
            ) : (
              <>
                <div className="content-reader-head">
                  <div className="reader-iden">
                    <span className="doc-author-badge" style={{ background: agentColor(open.agent || "?") }}>{(open.agent || "—").toUpperCase()}</span>
                    <span className="content-kind mono">{(open.kind || "md").toUpperCase()}</span>
                    <span className="reader-title">{open.title}</span>
                  </div>
                  <div className="content-tools">
                    {editing ? (
                      <>
                        <button className="content-tool" onClick={save}>Save</button>
                        <button className="content-tool" onClick={() => { setEditing(false); openDoc(open); }}>Cancel</button>
                      </>
                    ) : (
                      <>
                        {isTextDoc(open) && <button className="content-tool" onClick={() => setEditing(true)}>Edit</button>}
                        <a className="content-tool" href={api.contentDownloadUrl(open.path)} download>Download</a>
                        {isMarkdown(open) && <a className="content-tool" href={api.contentWordUrl(open.path)}>Word</a>}
                        <button className="content-tool danger" onClick={remove}>Delete</button>
                      </>
                    )}
                    <button className="content-tool" onClick={() => setOpen(null)} aria-label="Close">✕</button>
                  </div>
                </div>
                {msg && <p className="pane-msg mono">{msg}</p>}
                {!isTextDoc(open) ? (
                  preview?.supported ? (
                    <div className="doc-preview">
                      <div className="doc-preview-bar">
                        <span className="mono muted">
                          {(open.kind || "").toUpperCase()} PREVIEW · {preview.pages} {preview.pages === 1 ? "PAGE" : "PAGES"}
                          <span className="doc-preview-note"> · rendered preview; download uses the original source file</span>
                        </span>
                        <a className="btn-primary doc-original" href={api.contentDownloadUrl(open.path)} download>↓ Original</a>
                      </div>
                      <div className="doc-pages">
                        {Array.from({ length: preview.pages }, (_, i) => (
                          <img key={i} className="doc-page" loading="lazy"
                               src={api.contentPreviewImageUrl(open.path, i + 1)} alt={`page ${i + 1}`} />
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="content-binary empty-block mono">
                      {(open.kind || "file").toUpperCase()} document · {fmtSize(open.size)}
                      {preview?.reason && <><br /><span className="muted">{preview.reason}</span></>}
                      <br />
                      <a className="content-tool" href={api.contentDownloadUrl(open.path)} download>Download to view</a>
                    </div>
                  )
                ) : editing ? (
                  <textarea className="content-editor mono" value={body} onChange={(e) => setBody(e.target.value)} spellCheck={false} />
                ) : isMarkdown(open) ? (
                  <div className="content-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }} />
                ) : (
                  <pre className="content-body content-plain mono">{body}</pre>
                )}
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function NewDocModal({ agents, onClose, onCreate }: { agents: string[]; onClose: () => void; onCreate: (a: string, t: string) => void }) {
  const authors = agents.filter((a) => a !== "all");
  const [agent, setAgent] = useState(authors[0] ?? "");
  const [title, setTitle] = useState("");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="drawer-scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="display modal-title">New document</span>
          <button className="drawer-x" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <label className="pane-label">Author</label>
        <select className="model-select mono" value={agent} onChange={(e) => setAgent(e.target.value)}>
          {authors.length === 0 && <option value="">(no agents)</option>}
          {authors.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <label className="pane-label">Title</label>
        <input className="add-input" value={title} autoFocus placeholder="Document title" onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && title.trim() && onCreate(agent, title.trim())} />
        <div className="modal-actions">
          <button className="btn-primary" onClick={() => title.trim() && onCreate(agent, title.trim())} disabled={!title.trim()}>Create</button>
        </div>
      </div>
    </div>
  );
}

// minimal, safe markdown → HTML (escape first, then a few block/inline rules)
function renderMarkdown(src: string): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
  const lines = esc(src).replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inCode = false;
  for (const line of lines) {
    if (line.startsWith("```")) { out.push(inCode ? "</code></pre>" : "<pre><code>"); inCode = !inCode; continue; }
    if (inCode) { out.push(line); continue; }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { const n = h[1].length; out.push(`<h${n}>${inline(h[2])}</h${n}>`); continue; }
    if (/^\s*[-*]\s+/.test(line)) { out.push(`<li>${inline(line.replace(/^\s*[-*]\s+/, ""))}</li>`); continue; }
    if (line.trim() === "") { out.push(""); continue; }
    out.push(`<p>${inline(line)}</p>`);
  }
  return out.join("\n").replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`);
}
function inline(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`(.+?)`/g, "<code>$1</code>")
    .replace(/\[(.+?)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}
