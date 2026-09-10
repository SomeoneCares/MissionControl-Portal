import { useEffect, useMemo, useState } from "react";
import { api, type ContentDoc } from "../api/client";

// Content — everything the fleet has written. Browse by author agent, read the markdown.

export function Content() {
  const [docs, setDocs] = useState<ContentDoc[] | null>(null);
  const [agent, setAgent] = useState("all");
  const [open, setOpen] = useState<ContentDoc | null>(null);
  const [body, setBody] = useState<string>("");
  const [loadingDoc, setLoadingDoc] = useState(false);

  useEffect(() => { api.content().then((d) => setDocs(d.docs)).catch(() => setDocs([])); }, []);

  const agents = useMemo(
    () => ["all", ...Array.from(new Set((docs ?? []).map((d) => d.agent).filter(Boolean)))],
    [docs],
  );
  const list = (docs ?? []).filter((d) => agent === "all" || d.agent === agent);

  const openDoc = async (d: ContentDoc) => {
    setOpen(d); setBody(""); setLoadingDoc(true);
    try { const r = await api.contentRead(d.path); setBody(r.content); } catch { setBody("(failed to load)"); }
    setLoadingDoc(false);
  };

  return (
    <div className="content-tab">
      <section className="content-head card">
        <div>
          <span className="eyebrow">Agent output</span>
          <h1 className="display content-title">The <span className="ember">library.</span></h1>
        </div>
        <div className="runs-stat"><div className="display runs-stat-num tabular">{docs?.length ?? 0}</div><span className="eyebrow">documents</span></div>
      </section>

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
            <ul className="content-list">
              {list.map((d) => (
                <li key={d.path}>
                  <button className={`content-item ${open?.path === d.path ? "active" : ""}`} onClick={() => openDoc(d)}>
                    <span className="content-item-title">{d.title}</span>
                    <span className="mono muted content-item-meta">
                      {d.agent || "—"} · {new Date(d.modified_at).toLocaleDateString()}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
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
                </div>
                <div className="content-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }} />
              </>
            )}
          </section>
        </div>
      )}
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
