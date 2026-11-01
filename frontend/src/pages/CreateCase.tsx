import { useRef, useState, type DragEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Edit3, FileText, Share2, Trash2, Upload } from "lucide-react";
import { api, type Case, type EntityType, type Job } from "../api";
import { useAuth } from "../auth";
import { EtypeTag, Modal, ShapeIcon, useToast } from "../components/ui";
import { ETYPES, TYPE_KEYS, fmtBytes } from "../vocab";

const MAX_MB = 50;
const STEPS = ["Case information", "Sources", "Extraction", "Review & build"];
type Pending = { id: string; file: File; error?: string };
type Paste = { id: string; name: string; text: string };

export function validateFile(f: File): string | undefined {
  if (!/\.(pdf|md|markdown|txt)$/i.test(f.name)) return "Unsupported type — PDF, Markdown or TXT only";
  if (f.size > MAX_MB * 1048576) return `Larger than ${MAX_MB} MB`;
  if (!f.size) return "File is empty";
}

export function DropZone({ onFiles, compact }: { onFiles: (f: File[]) => void; compact?: boolean }) {
  const inp = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const drop = (e: DragEvent) => { e.preventDefault(); setOver(false); onFiles([...e.dataTransfer.files]); };
  return <div className={`dz ${over ? "over" : ""}`} tabIndex={0} role="button" aria-label="Upload files" style={compact ? { padding: 22 } : undefined}
    onClick={() => inp.current?.click()} onKeyDown={e => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), inp.current?.click())}
    onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}>
    <Upload /><h3 className="mt8">Drop PDF, Markdown or TXT files</h3><p className="muted small mt8">or click to choose files · up to {MAX_MB} MB each</p>
    <input ref={inp} type="file" multiple accept=".pdf,.md,.markdown,.txt" className="hide" onChange={e => { onFiles([...(e.target.files ?? [])]); e.target.value = ""; }} />
  </div>;
}

export function PasteModal({ onClose, onAdd }: { onClose: () => void; onAdd: (name: string, text: string) => void }) {
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  return <Modal title="Paste text as a source" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button>
    <button className="btn pri" disabled={!name.trim() || text.trim().length < 20} onClick={() => { onAdd(name.trim(), text); onClose(); }}>Add source</button></>}>
    <div className="col gap12"><div className="field"><label>Source name</label><input className="inp" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Field notes — March" /></div>
      <div className="field"><label>Text</label><textarea className="inp" rows={10} value={text} onChange={e => setText(e.target.value)} placeholder="Paste the source text. Blank lines separate paragraphs." /><span className="hint">At least 20 characters. Stored as a TXT source.</span></div></div>
  </Modal>;
}

export default function CreateCase() {
  const { can } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [d, setD] = useState({ title: "", description: "", research_question: "", objective: "", tags: "", visibility: "Team",
    scope_type: "" as "" | "person" | "organization" | "country" });
  const [files, setFiles] = useState<Pending[]>([]);
  const [pastes, setPastes] = useState<Paste[]>([]);
  const [types, setTypes] = useState<Set<EntityType>>(new Set(TYPE_KEYS.filter(t => t !== "document")));
  const [pasting, setPasting] = useState(false);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState<Record<string, string>>({});
  const set = (k: keyof typeof d) => (e: { target: { value: string } }) => setD({ ...d, [k]: e.target.value });

  const valid = (s: number) => {
    if (s === 0) {
      const e: Record<string, string> = {};
      if (d.title.trim().length < 3) e.title = "Enter at least 3 characters";
      if (!d.research_question.trim()) e.research_question = "A research question is required before the graph can be approved";
      setErr(e);
      return !Object.keys(e).length;
    }
    if (s === 2 && !types.size) { toast("Choose at least one entity type", "warn"); return false; }
    return true;
  };
  const addFiles = (fl: File[]) => setFiles(x => [...x, ...fl.map(f => ({ id: crypto.randomUUID(), file: f, error: validateFile(f) }))]);
  const ok = files.filter(f => !f.error);

  const build = async () => {
    if (!valid(0)) { setStep(0); return; }
    try {
      setBusy("Creating case…");
      const c = await api.post<Case>("/cases", { ...d, scope_type: d.scope_type || null, tags: d.tags.split(",").map(t => t.trim()).filter(Boolean), extract_types: [...types] });
      if (ok.length) {
        setBusy(`Uploading ${ok.length} source${ok.length > 1 ? "s" : ""}…`);
        const r = await api.upload<{ rejected: { filename: string; error: string }[] }>(`/cases/${c.id}/documents`, ok.map(f => f.file));
        r.rejected.forEach(x => toast(`${x.filename}: ${x.error}`, "warn"));
      }
      for (const p of pastes) await api.post(`/cases/${c.id}/documents/text`, { name: p.name, text: p.text });
      setBusy("Starting graph build…");
      const job = await api.post<Job>(`/cases/${c.id}/graph/build`, {});
      qc.invalidateQueries({ queryKey: ["cases"] });
      nav(`/cases/${c.id}/build/${job.id}`);
    } catch (e) { toast((e as Error).message, "err"); setBusy(""); }
  };

  return <div className="page" style={{ maxWidth: 980 }}>
    <div className="page-head"><div className="grow"><h1>Create case</h1><p>Describe the question, add sources, choose what to extract, then build the knowledge graph.</p></div></div>
    <div className="stepper" role="list">{STEPS.map((x, i) => <button key={x} role="listitem" className={`s ${i === step ? "on" : i < step ? "done" : ""}`} onClick={() => (i < step || valid(step)) && setStep(i)}><b>{i < step ? "✓" : i + 1}</b>{x}</button>)}</div>
    <div className="panel"><div className="panel-b" style={{ padding: 22 }}>
      {step === 0 && <div className="col gap16">
        <div className="field"><label htmlFor="w-title">Case title</label><input id="w-title" className={`inp ${err.title ? "bad" : ""}`} value={d.title} onChange={set("title")} maxLength={160} placeholder="e.g. Coastal fisheries quota talks" />{err.title && <span className="errt">{err.title}</span>}</div>
        <div className="field"><label htmlFor="w-desc">Description</label><textarea id="w-desc" className="inp" rows={2} value={d.description} onChange={set("description")} maxLength={1500} placeholder="What is this case about?" /></div>
        <div className="grid2"><div className="field"><label htmlFor="w-q">Research question</label><textarea id="w-q" className={`inp ${err.research_question ? "bad" : ""}`} rows={3} value={d.research_question} onChange={set("research_question")} placeholder="The question the analysis should answer" />{err.research_question && <span className="errt">{err.research_question}</span>}</div>
          <div className="field"><label htmlFor="w-o">Scenario objective</label><textarea id="w-o" className="inp" rows={3} value={d.objective} onChange={set("objective")} placeholder="What the simulation should help you explore" /></div></div>
        <div className="grid3"><div className="field"><label htmlFor="w-scope">Primary scope</label><select id="w-scope" className="sel" value={d.scope_type} onChange={set("scope_type")}><option value="">Decide later</option><option value="person">Person</option><option value="organization">Organization</option><option value="country">Country</option></select><span className="hint">Used by environment setup in stage 2.</span></div>
          <div className="field"><label htmlFor="w-tags">Tags</label><input id="w-tags" className="inp" value={d.tags} onChange={set("tags")} placeholder="Comma separated" /></div>
          <div className="field"><label htmlFor="w-vis">Visibility</label><select id="w-vis" className="sel" value={d.visibility} onChange={set("visibility")}>{["Private", "Team", "Organization"].map(v => <option key={v}>{v}</option>)}</select><span className="hint">Private: only you and administrators.</span></div></div>
      </div>}
      {step === 1 && <div className="col gap16"><DropZone onFiles={addFiles} />
        <div className="row"><span className="muted small grow">{ok.length + pastes.length} source{ok.length + pastes.length === 1 ? "" : "s"} ready</span><button className="btn sm" onClick={() => setPasting(true)}><Edit3 />Paste text as source</button></div>
        {(files.length > 0 || pastes.length > 0) && <div className="panel" style={{ overflowX: "auto" }}><table className="tbl"><thead><tr><th>File</th><th>Type</th><th>Size</th><th>Status</th><th /></tr></thead><tbody>
          {files.map(f => <tr key={f.id}><td><div className="row"><FileText size={15} /><span className="trunc" style={{ maxWidth: 300 }}>{f.file.name}</span></div>{f.error && <div className="xs" style={{ color: "var(--err)" }}>{f.error}</div>}</td>
            <td>{f.file.name.split(".").pop()?.toUpperCase()}</td><td className="small muted">{fmtBytes(f.file.size)}</td>
            <td>{f.error ? <span className="badge b-err">Rejected</span> : <span className="badge b-ok">Ready to upload</span>}</td>
            <td style={{ textAlign: "right" }}><button className="btn ghost sm icon" aria-label="Remove" onClick={() => setFiles(files.filter(x => x.id !== f.id))}><Trash2 /></button></td></tr>)}
          {pastes.map(p => <tr key={p.id}><td><div className="row"><Edit3 size={15} />{p.name}</div></td><td>TXT</td><td className="small muted">{fmtBytes(p.text.length)}</td><td><span className="badge b-ok">Ready</span></td>
            <td style={{ textAlign: "right" }}><button className="btn ghost sm icon" aria-label="Remove" onClick={() => setPastes(pastes.filter(x => x.id !== p.id))}><Trash2 /></button></td></tr>)}
        </tbody></table></div>}
        <p className="xs dim">Files are validated again on the server (content type, size, checksum de-duplication) and stored immutably. PDFs are parsed with Docling.</p>
      </div>}
      {step === 2 && <div className="col gap16"><div className="row"><h3 className="grow">Entity types to extract</h3>
        <label className="chk"><input type="checkbox" checked={types.size >= 7} onChange={e => setTypes(new Set(e.target.checked ? TYPE_KEYS.filter(t => t !== "document") : []))} />All entities</label></div>
        <div className="pick">{TYPE_KEYS.filter(t => t !== "document").map(t => <label key={t}><input type="checkbox" checked={types.has(t)} onChange={e => { const n = new Set(types); e.target.checked ? n.add(t) : n.delete(t); setTypes(n); }} />
          <div><div className="row" style={{ gap: 6, fontWeight: 600 }}><ShapeIcon type={t} /> {ETYPES[t].label}</div><div className="xs muted mt8">{ETYPES[t].desc}</div></div></label>)}</div>
        <p className="small muted">Extraction returns candidates only. Every entity and relationship carries the exact source passage it came from and starts as <b>pending review</b>; nothing reaches an approved graph without an analyst decision.</p></div>}
      {step === 3 && <div className="grid2"><div><h3 className="mb12">Case</h3><dl className="kv"><dt>Title</dt><dd>{d.title || <span style={{ color: "var(--err)" }}>Missing</span>}</dd>
        <dt>Question</dt><dd>{d.research_question || "—"}</dd><dt>Objective</dt><dd>{d.objective || "—"}</dd><dt>Scope</dt><dd>{d.scope_type || "Decide later"}</dd><dt>Visibility</dt><dd>{d.visibility}</dd>
        <dt>Extract</dt><dd className="row wrap gap4">{[...types].map(t => <EtypeTag key={t} type={t} />)}</dd></dl></div>
        <div><h3 className="mb12">Sources ({ok.length + pastes.length})</h3>{ok.length + pastes.length ? [...ok.map(f => [f.id, f.file.name] as const), ...pastes.map(p => [p.id, p.name] as const)].map(([id, n]) =>
          <div key={id} className="row small" style={{ padding: "6px 0", borderBottom: "1px solid var(--bd2)" }}><FileText size={14} /><span className="grow trunc">{n}</span></div>)
          : <p className="muted small">No sources. You can create the case now and add sources later.</p>}</div></div>}
    </div>
    <div className="modal-f" style={{ justifyContent: "space-between" }}>{step ? <button className="btn" onClick={() => setStep(step - 1)}>Back</button> : <span />}
      {step < 3 ? <button className="btn pri" onClick={() => valid(step) && setStep(step + 1)}>Continue</button>
        : <button className="btn pri big" disabled={!can("case.create") || !!busy} onClick={build}><Share2 />{busy || "Build knowledge graph"}</button>}</div></div>
    {pasting && <PasteModal onClose={() => setPasting(false)} onAdd={(name, text) => setPastes([...pastes, { id: crypto.randomUUID(), name, text }])} />}
  </div>;
}
