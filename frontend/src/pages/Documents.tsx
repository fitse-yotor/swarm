import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Download, Edit3, FileText, Trash2, Upload } from "lucide-react";
import { api, download, type Chunk, type Doc } from "../api";
import { useAuth } from "../auth";
import { Drawer, Empty, Modal, useToast } from "../components/ui";
import { ago, fmtBytes } from "../vocab";
import { useCase, useStartBuild } from "./CaseDetail";
import { DropZone, PasteModal, validateFile } from "./CreateCase";

export interface Highlight { chunk_id: string; char_start: number; char_end: number }

/** Reads a source's parsed text passage by passage, scrolled to and marking the cited span. */
export function SourceDrawer({ docId, highlight, onClose }: { docId: string; highlight?: Highlight; onClose: () => void }) {
  const doc = useQuery({ queryKey: ["doc", docId], queryFn: () => api.get<Doc>(`/documents/${docId}`) });
  const chunks = useQuery({ queryKey: ["chunks", docId], queryFn: () => api.get<Chunk[]>(`/documents/${docId}/chunks`) });
  const hitRef = useRef<HTMLDivElement>(null);
  useEffect(() => { hitRef.current?.scrollIntoView({ block: "center" }); }, [chunks.data]);
  const d = doc.data;
  let lastSec = "";
  return <Drawer title={d?.filename ?? "Source"} sub={d ? `${d.kind} · uploaded ${ago(d.uploaded_at)} by ${d.uploaded_by}` : ""} onClose={onClose}>
    {d && <><dl className="kv mb16"><dt>Status</dt><dd>{d.status}{d.parser && ` · ${d.parser}`}</dd><dt>Size</dt><dd>{fmtBytes(d.size)}{d.page_count ? ` · ${d.page_count} page(s)` : ""}</dd>
      <dt>Checksum</dt><dd className="mono trunc" title={d.checksum}>{d.checksum.slice(0, 16)}…</dd><dt>Passages</dt><dd>{d.chunk_count}</dd><dt>Evidence spans</dt><dd>{d.claim_count}</dd></dl>
      {d.warnings.map(w => <div key={w} className="demo-flag mb12">{w}</div>)}
      <button className="btn sm mb16" onClick={() => download(`/documents/${d.id}/file`, d.filename)}><Download />Original file</button></>}
    <div className="sec-t">Content</div>
    {chunks.data?.length === 0 && <p className="muted small">No parsed text yet. Build the graph to parse this source.</p>}
    {chunks.data?.map(c => {
      const hit = highlight?.chunk_id === c.id;
      const sec = c.section !== lastSec ? <div className="doc-sec">{c.section} · p. {c.page}</div> : null;
      lastSec = c.section;
      const a = hit ? Math.max(0, highlight!.char_start - c.char_start) : 0, b = hit ? Math.min(c.text.length, highlight!.char_end - c.char_start) : 0;
      return <div key={c.id}>{sec}<div ref={hit ? hitRef : undefined} className={`chunk ${hit ? "hit" : ""}`}>
        <div className="chunk-meta">Passage {c.ordinal + 1} · chars {c.char_start}–{c.char_end}</div>
        <p className="docpara" style={{ color: "var(--tx)", margin: 0 }}>{hit ? <>{c.text.slice(0, a)}<mark>{c.text.slice(a, b)}</mark>{c.text.slice(b)}</> : c.text}</p></div></div>;
    })}
  </Drawer>;
}

export function DocTable({ docs, caseId }: { docs: Doc[]; caseId: string }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState<string | null>(() => new URLSearchParams(window.location.search).get("doc"));  // ?doc= opens a source directly
  const rm = useMutation({
    mutationFn: (d: Doc) => api.del(`/documents/${d.id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["docs", caseId] }); toast("Source removed", "ok"); },
    onError: e => toast((e as Error).message, "err"),
  });
  return <><table className="tbl"><thead><tr><th>Source</th><th>Type</th><th className="hm">Size</th><th>Parsing</th><th className="hm">Passages</th><th className="hm">Evidence</th><th className="hm">Uploaded</th><th /></tr></thead>
    <tbody>{docs.map(d => <tr key={d.id} className="click" onClick={() => setOpen(d.id)}>
      <td><div className="row"><FileText size={15} /><span className="trunc" style={{ maxWidth: 320, fontWeight: 500 }}>{d.filename}</span></div>{d.error && <div className="xs" style={{ color: "var(--err)" }}>{d.error}</div>}</td>
      <td>{d.kind}</td><td className="hm small muted">{fmtBytes(d.size)}</td>
      <td>{d.status === "parsed" ? <span className="badge b-ok">Parsed{d.extracted_at ? "" : " · not extracted"}</span> : d.status === "failed" ? <span className="badge b-err">Failed</span> : <span className="badge b-warn">Stored — awaiting build</span>}</td>
      <td className="hm">{d.chunk_count}</td><td className="hm">{d.claim_count}</td><td className="hm small muted">{ago(d.uploaded_at)}</td>
      <td style={{ textAlign: "right" }} onClick={e => e.stopPropagation()}>{can("doc.upload") && <button className="btn ghost sm icon" aria-label={`Remove ${d.filename}`} disabled={d.claim_count > 0}
        title={d.claim_count ? "Cited by graph claims — reject them in a draft first" : "Remove"} onClick={() => confirm(`Remove “${d.filename}”?`) && rm.mutate(d)}><Trash2 /></button>}</td></tr>)}</tbody></table>
    {open && <SourceDrawer docId={open} onClose={() => setOpen(null)} />}</>;
}

export default function Documents() {
  const { caseId = "" } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const c = useCase(caseId);
  const docs = useQuery({ queryKey: ["docs", caseId], queryFn: () => api.get<Doc[]>(`/cases/${caseId}/documents`) });
  const build = useStartBuild(caseId);
  const [uploading, setUploading] = useState(false);
  const [pasting, setPasting] = useState(false);
  const refresh = () => { qc.invalidateQueries({ queryKey: ["docs", caseId] }); qc.invalidateQueries({ queryKey: ["case", caseId] }); };

  const upload = async (files: File[]) => {
    const bad = files.filter(validateFile);
    bad.forEach(f => toast(`${f.name}: ${validateFile(f)}`, "warn"));
    const good = files.filter(f => !validateFile(f));
    if (!good.length) return;
    try {
      const r = await api.upload<{ documents: Doc[]; rejected: { filename: string; error: string }[] }>(`/cases/${caseId}/documents`, good);
      r.rejected.forEach(x => toast(`${x.filename}: ${x.error}`, "warn"));
      if (r.documents.length) toast(`${r.documents.length} source${r.documents.length > 1 ? "s" : ""} uploaded — build the graph to extract them`, "ok");
      refresh(); setUploading(false);
    } catch (e) { toast((e as Error).message, "err"); }
  };
  const pending = (docs.data ?? []).filter(d => !d.extracted_at && d.status !== "failed").length;

  return <div className="page">
    <div className="page-head"><div className="grow"><h1>Documents</h1><p>Sources for {c.data?.title}. Open a source to read its parsed passages and the spans graph claims cite.</p></div>
      {can("doc.upload") && <><button className="btn" onClick={() => setPasting(true)}><Edit3 />Paste text</button><button className="btn" onClick={() => setUploading(true)}><Upload />Upload sources</button>
        <button className="btn pri" disabled={!pending || build.isPending} onClick={() => build.mutate(false)}>Build graph{pending ? ` (${pending} new)` : ""}</button></>}</div>
    {docs.data?.length ? <div className="panel" style={{ overflowX: "auto" }}><DocTable docs={docs.data} caseId={caseId} /></div>
      : <Empty icon={<BookOpen />} title="No sources in this case" text="Upload PDF, Markdown or TXT files, then build the graph." />}
    {uploading && <Modal title="Upload sources" sub={`Adds to ${c.data?.title}. Parsing and extraction run when you build the graph.`} onClose={() => setUploading(false)}><DropZone compact onFiles={upload} /></Modal>}
    {pasting && <PasteModal onClose={() => setPasting(false)} onAdd={async (name, text) => {
      try { await api.post(`/cases/${caseId}/documents/text`, { name, text }); refresh(); toast("Source added", "ok"); } catch (e) { toast((e as Error).message, "err"); }
    }} />}
  </div>;
}
