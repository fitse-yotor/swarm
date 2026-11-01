import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, ChevronDown, ChevronRight, Edit3, FileText, Trash2 } from "lucide-react";
import { api, type Case, type EntityType, type Job } from "../api";
import { useAuth } from "../auth";
import { ShapeIcon, useToast } from "../components/ui";
import { useSystem } from "../hooks";
import { ETYPES, TYPE_KEYS, fmtBytes } from "../vocab";
import { DropZone, PasteModal, validateFile } from "./CreateCase";

const STEPS = [
  ["Graph Build", "Reality-seed extraction, evidence-pinned entities and relationships, GraphRAG construction"],
  ["Env Setup", "Agents from the graph's actors, synthetic personas, social network and run configuration"],
  ["Start Simulation", "Dual-platform simulation with opinion dynamics and LLM-written posts"],
  ["Report Generation", "Measured findings, source evidence and a model-written narrative, each labelled"],
  ["Deep Interaction", "Chat with any synthetic persona, the report agent or the graph"],
];

type Seed = { id: string; file?: File; name: string; size: number; text?: string; error?: string };

/** Case builder: drop reality seeds, state the simulation requirement, start the graph build. */
export default function NewCase() {
  const { can } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const sys = useSystem();
  const [seeds, setSeeds] = useState<Seed[]>([]);
  const [req, setReq] = useState("");
  const [title, setTitle] = useState("");
  const [adv, setAdv] = useState(false);
  const [more, setMore] = useState({ description: "", objective: "", tags: "", visibility: "Team", scope_type: "country" });
  const [types, setTypes] = useState<Set<EntityType>>(new Set(TYPE_KEYS.filter(t => t !== "document")));
  const [pasting, setPasting] = useState(false);
  const [busy, setBusy] = useState("");

  const ok = seeds.filter(s => !s.error);
  const autoTitle = title.trim() || (ok[0] ? ok[0].name.replace(/\.(pdf|md|markdown|txt)$/i, "").replace(/[_-]+/g, " ").slice(0, 120) : "");
  const ready = !!autoTitle && autoTitle.length >= 3 && req.trim().length >= 10 && ok.length > 0 && can("case.create") && !busy;
  const llm = sys.data?.llm;

  const start = async () => {
    try {
      setBusy("Creating case…");
      const c = await api.post<Case>("/cases", {
        title: autoTitle, research_question: req.trim(), description: more.description, objective: more.objective || req.trim(),
        tags: more.tags.split(",").map(t => t.trim()).filter(Boolean), visibility: more.visibility, scope_type: more.scope_type || null,
        extract_types: [...types],
      });
      const files = ok.filter(s => s.file).map(s => s.file!);
      if (files.length) {
        setBusy(`Uploading ${files.length} reality seed${files.length > 1 ? "s" : ""}…`);
        const r = await api.upload<{ rejected: { filename: string; error: string }[] }>(`/cases/${c.id}/documents`, files);
        r.rejected.forEach(x => toast(`${x.filename}: ${x.error}`, "warn"));
      }
      for (const s of ok.filter(s => s.text)) await api.post(`/cases/${c.id}/documents/text`, { name: s.name, text: s.text });
      setBusy("Starting graph build…");
      const job = await api.post<Job>(`/cases/${c.id}/graph/build`, {});
      qc.invalidateQueries({ queryKey: ["cases"] });
      nav(`/cases/${c.id}/build/${job.id}`);
    } catch (e) { toast((e as Error).message, "err"); setBusy(""); }
  };

  return <div className="console">
    <section className="console-l">
      <div className="eyebrow">■ System Status</div>
      <h1 className="console-h">{sys.data ? "System Ready" : "Checking system…"}</h1>
      <p className="muted">{llm?.available ? `Local models online · ${llm.model} · ${sys.data?.extractor}` : sys.data ? `Graph build ready (${sys.data.extractor}). Local LLM offline — personas, posts and chat fall back to templates.` : ""}</p>
      <div className="eyebrow mt24">◇ Workflow Steps</div>
      <ol className="wf">{STEPS.map(([t, d], i) => <li key={t}><span className="n">{String(i + 1).padStart(2, "0")}</span><div><b>{i + 1}. {t}</b><p>{d}</p></div></li>)}</ol>
    </section>

    <section className="console-r">
      <div className="seed-card">
        <div className="sc-h"><span>01 / Reality Seeds</span><span>PDF · MD · TXT</span></div>
        <DropZone compact onFiles={fs => setSeeds(x => [...x, ...fs.map(f => ({ id: crypto.randomUUID(), file: f, name: f.name, size: f.size, error: validateFile(f) }))])} />
        {seeds.length > 0 && <div className="seed-list">{seeds.map(s => <div key={s.id} className={`seed ${s.error ? "bad" : ""}`}>
          {s.text ? <Edit3 size={15} /> : <FileText size={15} />}<span className="grow trunc">{s.name}</span>
          <span className="xs dim">{s.error ?? fmtBytes(s.size)}</span>
          <button className="btn ghost sm icon" aria-label={`Remove ${s.name}`} onClick={() => setSeeds(seeds.filter(x => x.id !== s.id))}><Trash2 /></button></div>)}</div>}
        <button className="btn ghost sm mt8" onClick={() => setPasting(true)}><Edit3 />Paste text as a seed</button>

        <div className="sc-div"><span>Input Parameters</span></div>

        <div className="sc-h"><span>&gt;_ 02 / Simulation Requirement</span></div>
        <div className="req">
          <textarea value={req} onChange={e => setReq(e.target.value)} rows={4} aria-label="Simulation requirement"
            placeholder="What question should the graph and simulation answer? e.g. How do government-aligned, government-critical and TPLF-aligned viewpoints react if the Pretoria agreement's implementation stalls?" />
          <span className="engine">Engine: lattice-abm/1 · {sys.data?.extractor ?? "…"} · {llm?.model ?? "…"}</span>
        </div>

        <div className="field mt12"><label htmlFor="nc-title">Case title</label>
          <input id="nc-title" className="inp" value={title} onChange={e => setTitle(e.target.value)} placeholder={autoTitle || "Defaults to the first seed's file name"} maxLength={160} /></div>

        <button className="sb-sec-h mt12" style={{ color: "var(--tx2)" }} aria-expanded={adv} onClick={() => setAdv(!adv)}>{adv ? <ChevronDown /> : <ChevronRight />}Advanced settings</button>
        {adv && <div className="col gap12 mt8">
          <div className="field"><label>Description</label><textarea className="inp" rows={2} value={more.description} onChange={e => setMore({ ...more, description: e.target.value })} /></div>
          <div className="field"><label>Scenario objective</label><textarea className="inp" rows={2} value={more.objective} placeholder="Defaults to the simulation requirement" onChange={e => setMore({ ...more, objective: e.target.value })} /></div>
          <div className="grid3">
            <div className="field"><label>Primary scope</label><select className="sel" value={more.scope_type} onChange={e => setMore({ ...more, scope_type: e.target.value })}><option value="">Decide later</option><option value="person">Person</option><option value="organization">Organization</option><option value="country">Country</option></select></div>
            <div className="field"><label>Tags</label><input className="inp" value={more.tags} placeholder="Comma separated" onChange={e => setMore({ ...more, tags: e.target.value })} /></div>
            <div className="field"><label>Visibility</label><select className="sel" value={more.visibility} onChange={e => setMore({ ...more, visibility: e.target.value })}>{["Private", "Team", "Organization"].map(v => <option key={v}>{v}</option>)}</select></div>
          </div>
          <div className="field"><label>Entity types to extract</label><div className="row wrap gap12">{TYPE_KEYS.filter(t => t !== "document").map(t =>
            <label key={t} className="chk"><input type="checkbox" checked={types.has(t)} onChange={e => { const n = new Set(types); e.target.checked ? n.add(t) : n.delete(t); setTypes(n); }} /><ShapeIcon type={t} />{ETYPES[t].label}</label>)}</div></div>
          <Link className="xs" to="/cases/new/wizard">Prefer the step-by-step wizard?</Link>
        </div>}

        <button className="try" disabled={!ready} onClick={start}>
          <span>{busy || "Start Building"}</span><ArrowRight /></button>
        {!ready && !busy && <p className="xs dim mt8">{!ok.length ? "Add at least one reality seed." : req.trim().length < 10 ? "Describe the simulation requirement." : !can("case.create") ? "Your role cannot create cases." : "Add a case title."}</p>}
      </div>
    </section>
    {pasting && <PasteModal onClose={() => setPasting(false)} onAdd={(name, text) => setSeeds(x => [...x, { id: crypto.randomUUID(), name, text, size: text.length }])} />}
  </div>;
}
