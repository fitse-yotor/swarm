// Settings: appearance for everyone; the deployment's .env files for administrators.
// Secrets are never sent to the browser: they arrive masked and are only replaced when you type a new value.
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Eye, EyeOff, FileCog, KeyRound, Monitor, Moon, Plus, RotateCcw, Save, Search, Sun, Trash2, Undo2 } from "lucide-react";
import { api } from "../api";
import { useAuth } from "../auth";
import { useToast } from "../components/ui";
import { applyTheme, useTheme } from "../hooks";
import { load, store } from "../prefs";

interface EnvEntry { key: string; set: boolean; value: string; secret: boolean; example: string | null; default: string | null; note: string; group: string; running_differs?: boolean }
interface EnvFile { id: string; label: string; description: string; path: string; exists: boolean; writable: boolean; template: string | null; entries: EnvEntry[] }
interface EnvList { files: EnvFile[]; note: string }

const KEY_RE = /^[A-Z][A-Z0-9_]{0,99}$/;

function Appearance() {
  const theme = useTheme();
  const [mode, setMode] = useState<"light" | "dark" | "system">(() => load<string | null>("theme", null) ? (theme as "light" | "dark") : "system");
  const choose = (m: "light" | "dark" | "system") => {
    setMode(m);
    if (m === "system") { const t = window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light"; document.documentElement.dataset.theme = t; store("theme", null); }
    else applyTheme(m);
  };
  return <section className="panel"><div className="panel-h"><h3 className="grow">Appearance</h3><span className="xs dim">Saved in this browser</span></div>
    <div className="panel-b row wrap" style={{ gap: 10 }}>{([["light", Sun, "Light"], ["dark", Moon, "Dark"], ["system", Monitor, "Follow system"]] as const).map(([m, Icon, l]) =>
      <button key={m} className={`v2-opt ${mode === m ? "on" : ""}`} onClick={() => choose(m)}><Icon /><b>{l}</b></button>)}</div></section>;
}

function EnvEditor({ file, note }: { file: EnvFile; note: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<Record<string, string | null>>({});
  const [show, setShow] = useState<Record<string, boolean>>({});
  const [q, setQ] = useState("");
  const [nk, setNk] = useState(""); const [nv, setNv] = useState("");
  const [restart, setRestart] = useState<string[]>([]);
  useEffect(() => { setDraft({}); setRestart([]); }, [file.id]);
  const dirty = Object.keys(draft).length;
  const save = useMutation({
    mutationFn: () => api.put<{ changed: string[]; restart_required: boolean }>(`/admin/env/${file.id}`, { changes: draft }),
    onSuccess: r => { setDraft({}); setRestart(x => [...new Set([...x, ...r.changed])]); qc.invalidateQueries({ queryKey: ["env"] });
      toast(r.changed.length ? `Saved ${r.changed.length} change${r.changed.length > 1 ? "s" : ""} to ${file.path}` : "Nothing changed", "ok"); },
    onError: e => toast((e as Error).message, "err"),
  });
  const groups = useMemo(() => {
    const m = new Map<string, EnvEntry[]>();
    const extra = Object.keys(draft).filter(k => !file.entries.some(e => e.key === k)).map(k => ({ key: k, set: false, value: "", secret: /SECRET|PASSWORD|TOKEN|KEY/.test(k), example: null, default: null, note: "New variable", group: "Added", running_differs: false }));
    [...file.entries, ...extra].filter(e => !q || (e.key + e.note).toLowerCase().includes(q.toLowerCase())).forEach(e => m.set(e.group, [...(m.get(e.group) ?? []), e]));
    return [...m.entries()];
  }, [file, draft, q]);
  const val = (e: EnvEntry) => (e.key in draft ? draft[e.key] ?? "" : e.value);
  const setVal = (e: EnvEntry, v: string) => setDraft(d => { const n = { ...d }; if (v === e.value && e.set) delete n[e.key]; else n[e.key] = v; return n; });
  const add = () => {
    const k = nk.trim().toUpperCase();
    if (!KEY_RE.test(k)) return toast("Use A–Z, 0–9 and _ ; start with a letter", "err");
    setDraft(d => ({ ...d, [k]: nv })); setNk(""); setNv("");
  };

  return <section className="panel">
    <div className="panel-h"><FileCog size={16} /><div className="grow"><h3>{file.label}</h3><div className="xs dim">{file.description}</div></div>
      <span className="mono xs">{file.path}</span>{!file.exists && <span className="badge b-warn"><i />not created yet</span>}{!file.writable && <span className="badge b-err"><i />read-only</span>}</div>
    {restart.length > 0 && <div className="v2-note warn"><AlertTriangle /><span><b>Restart required.</b> Saved {restart.join(", ")}. {note}  A backup of the previous file is in <span className="mono">{file.path}.bak</span>.</span></div>}
    {!file.exists && file.template && <div className="v2-note"><AlertTriangle /><span>The file does not exist yet. Your first save creates it from <span className="mono">{file.template}</span>, keeping its comments.</span></div>}
    <div className="panel-b row" style={{ gap: 8, paddingBottom: 0 }}>
      <label className="v2-filter"><Search /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter variables" aria-label="Filter variables" /></label>
      <span className="grow" />
      <button className="btn" disabled={!dirty} onClick={() => setDraft({})}><Undo2 />Discard</button>
      <button className="btn pri" disabled={!dirty || save.isPending || !file.writable} onClick={() => save.mutate()}><Save />{save.isPending ? "Saving…" : `Save${dirty ? ` ${dirty} change${dirty > 1 ? "s" : ""}` : ""}`}</button>
    </div>
    {groups.map(([g, items]) => <div key={g} className="v2-envgroup"><div className="label">{g}</div>
      <table className="tbl v2-envtbl"><tbody>{items.map(e => { const changed = e.key in draft, removed = changed && draft[e.key] === null;
        return <tr key={e.key} className={changed ? "chg" : ""}>
          <td style={{ width: "34%" }}><div className="row" style={{ gap: 6 }}>{e.secret && <KeyRound size={13} className="dim" />}<b className="mono">{e.key}</b>
            {!e.set && !changed && <span className="badge">not set</span>}
            {e.running_differs && !changed && <span className="badge b-warn" title="The running API uses a different value: it has not restarted since the change, or docker-compose.yml sets this variable."><i />running value differs</span>}{changed && <span className="badge b-acc"><i />{removed ? "remove" : "edited"}</span>}</div>
            {e.note && <div className="xs dim" style={{ marginTop: 3 }}>{e.note}</div>}</td>
          <td><div className="row" style={{ gap: 6 }}>
            <input className="inp mono" disabled={removed} type={e.secret && !show[e.key] && !val(e).includes("://") ? "password" : "text"} value={removed ? "" : val(e)}
              placeholder={e.default != null ? `default: ${e.default}` : e.example != null ? `example: ${e.example}` : ""} onChange={x => setVal(e, x.target.value)} aria-label={e.key} autoComplete="off" />
            {e.secret && <button className="btn ghost icon sm" onClick={() => setShow(s => ({ ...s, [e.key]: !s[e.key] }))} aria-label={show[e.key] ? "Hide" : "Show"} title="Secrets stay masked; type a new value to replace">{show[e.key] ? <EyeOff /> : <Eye />}</button>}
            {changed && <button className="btn ghost icon sm" onClick={() => setDraft(d => { const n = { ...d }; delete n[e.key]; return n; })} aria-label="Undo" title="Undo"><RotateCcw /></button>}
            {e.set && !removed && <button className="btn ghost icon sm" onClick={() => setDraft(d => ({ ...d, [e.key]: null }))} aria-label={`Remove ${e.key}`} title="Remove from file"><Trash2 /></button>}
          </div></td></tr>; })}</tbody></table></div>)}
    <div className="panel-b row" style={{ gap: 8, borderTop: "1px solid var(--bd)" }}>
      <input className="inp mono" style={{ maxWidth: 260 }} placeholder="NEW_VARIABLE" value={nk} onChange={e => setNk(e.target.value.toUpperCase())} aria-label="New variable name" />
      <input className="inp mono" placeholder="value" value={nv} onChange={e => setNv(e.target.value)} aria-label="New variable value" onKeyDown={e => { if (e.key === "Enter") add(); }} />
      <button className="btn" onClick={add} disabled={!nk.trim()}><Plus />Add variable</button></div>
  </section>;
}

export default function Settings() {
  const { can } = useAuth();
  const admin = can("admin.access");
  const env = useQuery({ queryKey: ["env"], enabled: admin, queryFn: () => api.get<EnvList>("/admin/env") });
  const [tab, setTab] = useState<string | null>(null);
  const files = env.data?.files ?? [];
  const cur = files.find(f => f.id === tab) ?? files[0];

  return <div className="page">
    <div className="page-head"><div className="grow"><div className="v2-eyebrow">Workspace</div><h1>Settings</h1>
      <p>{admin ? "Appearance for you, and the environment files that configure this deployment: local models, data stores, extraction and security." : "Appearance for this browser. Environment files are managed by administrators."}</p></div>
      {admin && <Link className="btn" to="/admin">Users, roles and audit</Link>}</div>
    <div className="col gap16">
      <Appearance />
      {admin && <>
        <div className="tabs" role="tablist">{files.map(f => <button key={f.id} role="tab" className={cur?.id === f.id ? "on" : ""} onClick={() => setTab(f.id)}>{f.label}</button>)}</div>
        {env.isError && <div className="v2-note warn"><AlertTriangle /><span>{(env.error as Error).message}</span></div>}
        {env.isLoading && <p className="muted">Loading environment files…</p>}
        {cur && <EnvEditor key={cur.id} file={cur} note={env.data!.note} />}
        <p className="xs dim">Secrets (passwords, tokens, keys and credentials inside URLs) are never sent to the browser. Every save is written to the audit log with the variable names only.</p>
      </>}
    </div>
  </div>;
}
