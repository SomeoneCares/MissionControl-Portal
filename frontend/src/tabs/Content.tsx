import { useEffect, useMemo, useState } from "react";
import { api, type ContentDoc, type FleetGroupsView } from "../api/client";

// Content — everything the fleet has written. Browse by author agent (grouped by the author's
// fleet), read text documents, download the binary ones (PDF, Word) that agents also produce.

const TEXT_KINDS = new Set(["md", "txt", "html", "htm", "csv", "json", "log", ""]);
const isTextDoc = (d: ContentDoc) => TEXT_KINDS.has((d.kind ?? "md").toLowerCase());
const isMarkdown = (d: ContentDoc) => (d.kind ?? "md").toLowerCase() === "md";

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

  const reload = () => api.content().then((d) => setDocs(d.docs));
  useEffect(() => { reload(); }, []);
  useEffect(() => { api.fleets().then(setGroups).catch(() => setGroups(null)); }, []);

  const agents = useMemo(
    () => ["all", ...Array.from(new Set((docs ?? []).map((d) => d.agent).filter(Boolean)))],
    [docs],
  );
  const list = (docs ?? []).filter((d) => agent === "all" || d.agent === agent);

  // group the doc list by the author's fleet (only when not already narrowed to one author)
  const docSections: { name: string; accent: string; docs: ContentDoc[] }[] | null =
    agent === "all" && (groups?.fleets.length ?? 0) > 0
      ? [
          ...groups!.fleets.map((f) => ({
            name: f.name, accent: f.accent,
            docs: list.filter((d) => d.agent && f.members.includes(d.agent)),
          })),
          {
            name: "Ungrouped", accent: "",
            docs: list.filter((d) => !d.agent || !groups!.fleets.some((f) => f.members.includes(d.agent))),
          },
        ].filter((s) => s.docs.length > 0)
      : null;

  const openDoc = async (d: ContentDoc) => {
    setOpen(d); setBody(""); setEditing(false); setMsg(null);
    if (!isTextDoc(d)) { setLoadingDoc(false); return; }  // binary (PDF/Word) — download only
    setLoadingDoc(true);
    try { const r = await api.contentRead(d.path); setBody(r.content); } catch { setBody("(failed to load)"); }
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
      <button className={`content-item ${open?.path === d.path ? "active" : ""}`} onClick={() => openDoc(d)}>
        <span className="content-item-title">
          {d.title}
          {d.kind && d.kind !== "md" && <span className="content-kind mono">{d.kind}</span>}
        </span>
        <span className="mono muted content-item-meta">
          {d.agent || "—"} · {new Date(d.modified_at).toLocaleDateString()}
        </span>
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
          <div className="runs-stat"><div className="display runs-stat-num tabular">{docs?.length ?? 0}</div><span className="eyebrow">documents</span></div>
          <button className="btn-primary" onClick={() => setCreating(true)}>+ New doc</button>
        </div>
      </section>

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
                <button key={a} className={`filter-btn ${a === agent ? "active" : ""}`} onClick={() => setAgent(a)}>{a}</button>
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
                  <span className="mono muted">{open.agent} · {open.filename}</span>
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
                  </div>
                </div>
                {msg && <p className="pane-msg mono">{msg}</p>}
                {!isTextDoc(open) ? (
                  <div className="content-binary empty-block mono">
                    {open.kind?.toUpperCase()} document · {(open.size / 1024).toFixed(0)} KB
                    <br />
                    <a className="content-tool" href={api.contentDownloadUrl(open.path)} download>Download to view</a>
                  </div>
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
