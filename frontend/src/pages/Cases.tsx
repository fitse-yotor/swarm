import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Folder, Lock, Plus, RefreshCw } from "lucide-react";
import { api, type Case } from "../api";
import { useAuth } from "../auth";
import { Avatar, CaseStatusBadge, Empty, useToast } from "../components/ui";
import { ago } from "../vocab";

export function CaseTable({ list, compact = false }: { list: Case[]; compact?: boolean }) {
  const nav = useNavigate();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const archive = useMutation({
    mutationFn: (c: Case) => api.post<Case>(`/cases/${c.id}/archive${c.status === "Archived" ? "?restore=true" : ""}`),
    onSuccess: c => { qc.invalidateQueries({ queryKey: ["cases"] }); toast(c.status === "Archived" ? "Case archived" : "Case restored", "ok"); },
    onError: e => toast((e as Error).message, "err"),
  });
  if (!list.length) return <Empty icon={<Folder />} title="No cases match" text="Clear the filter or create a new case." />;
  return <table className="tbl"><thead><tr><th>Case</th>{!compact && <th className="hm">Description</th>}<th className="hm">Owner</th><th>Status</th>
    <th className="hm">Docs</th><th className="hm">Graph</th><th className="hm">Updated</th><th style={{ textAlign: "right" }}>Actions</th></tr></thead>
    <tbody>{list.map(c => <tr key={c.id} className="click" onClick={() => nav(`/cases/${c.id}`)}>
      <td><div style={{ fontWeight: 600 }}>{c.title}</div>{compact && <div className="xs dim trunc" style={{ maxWidth: 280 }}>{c.description}</div>}</td>
      {!compact && <td className="hm muted small" style={{ maxWidth: 280 }}><div className="trunc">{c.description}</div></td>}
      <td className="hm"><div className="row small"><Avatar name={c.owner_name} size={20} />{c.owner_name}</div></td>
      <td><CaseStatusBadge status={c.status} /></td><td className="hm">{c.document_count}</td>
      <td className="hm">{c.graph_label ? <span className={`badge ${c.graph_status === "approved" ? "b-ok" : ""}`}>{c.graph_status === "approved" && <Lock size={10} />}{c.graph_label} {c.graph_status}</span> : <span className="dim small">—</span>}</td>
      <td className="hm small muted">{ago(c.updated_at)}</td>
      <td style={{ textAlign: "right", whiteSpace: "nowrap" }} onClick={e => e.stopPropagation()}>
        <Link className="btn ghost sm" to={`/cases/${c.id}/graph`}>Graph</Link>
        {can("case.archive") && <button className="btn ghost sm icon" title={c.status === "Archived" ? "Restore" : "Archive"} aria-label={`${c.status === "Archived" ? "Restore" : "Archive"} ${c.title}`}
          onClick={() => archive.mutate(c)}>{c.status === "Archived" ? <RefreshCw /> : <Archive />}</button>}
      </td></tr>)}</tbody></table>;
}

export default function Cases() {
  const { can } = useAuth();
  const [f, setF] = useState("All");
  const [q, setQ] = useState("");
  const cases = useQuery({ queryKey: ["cases"], queryFn: () => api.get<Case[]>("/cases") });
  const all = cases.data ?? [];
  const list = all.filter(c => (f === "All" || c.status === f) && (!q || (c.title + c.description + c.tags.join(" ") + c.owner_name).toLowerCase().includes(q.toLowerCase())));
  return <div className="page">
    <div className="page-head"><div className="grow"><h1>Cases</h1><p>Each case holds its sources, graph versions, environments, simulation runs, reports and conversations.</p></div>
      {can("case.create") && <Link className="btn pri" to="/cases/new"><Plus />Create case</Link>}</div>
    <div className="row wrap mb12"><div className="seg" role="tablist">{["All", "Active", "Review", "Draft", "Archived"].map(s =>
      <button key={s} className={f === s ? "on" : ""} onClick={() => setF(s)}>{s} <span className="dim">{s === "All" ? all.length : all.filter(c => c.status === s).length}</span></button>)}</div>
      <input className="inp" style={{ maxWidth: 280, marginLeft: "auto" }} placeholder="Search title, tags, owner" value={q} onChange={e => setQ(e.target.value)} aria-label="Search cases" /></div>
    <div className="panel" style={{ overflowX: "auto" }}>{cases.isLoading ? <p className="panel-b muted">Loading…</p> : <CaseTable list={list} />}</div>
  </div>;
}
