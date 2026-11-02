import { useCallback, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Inbox, Merge, Share2, X } from "lucide-react";
import { api, type GEdge, type GNode, type HistoryItem } from "../api";
import { useAuth } from "../auth";
import { ConfBar, EtypeTag, Empty, isUnavailable, ShapeIcon, Unavailable, useToast } from "../components/ui";
import { ago } from "../vocab";
import { useCase } from "./CaseDetail";
import { SourceDrawer, type Highlight } from "./Documents";
import { useGraph } from "./GraphExplorer";
import { EvidenceCard, useEvidence } from "./graph/Inspector";

function EdgeEvidence({ caseId, edge, onOpen }: { caseId: string; edge: GEdge; onOpen: (h: Highlight & { doc: string }) => void }) {
  const ev = useEvidence(caseId, edge.evidence_ids.slice(0, 2));
  if (!edge.evidence_ids.length) return <div className="xs mt8" style={{ color: "var(--err)" }}>No verified supporting passage</div>;
  return <div className={edge.status === "conflict" ? "grid2 mt8" : "mt8"}>{(ev.data ?? []).map(x => <EvidenceCard key={x.id} ev={x} onOpen={onOpen} />)}
    {edge.evidence_ids.length > 2 && <div className="xs dim">+{edge.evidence_ids.length - 2} more</div>}</div>;
}

export default function Review() {
  const { caseId = "" } = useParams();
  const [sp] = useSearchParams();
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const c = useCase(caseId);
  const graph = useGraph(caseId, sp.get("v"));
  const [tab, setTab] = useState("entities");
  const [reading, setReading] = useState<(Highlight & { doc: string }) | null>(null);
  const g = graph.data;
  const hist = useQuery({ queryKey: ["history", caseId, g?.version.id, "all"], enabled: !!g && tab === "history",
    queryFn: () => api.get<HistoryItem[]>(`/cases/${caseId}/graph/versions/${g!.version.id}/history`) });
  const run = useCallback(async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); await qc.invalidateQueries({ queryKey: ["graph", caseId] }); qc.invalidateQueries({ queryKey: ["history", caseId] }); toast(ok, "ok"); } catch (e) { toast((e as Error).message, "err"); }
  }, [qc, caseId, toast]);

  if (graph.isError && isUnavailable(graph.error)) return <div className="page"><Unavailable error={graph.error} onRetry={() => graph.refetch()} retrying={graph.isFetching} /></div>;
  if (graph.isError) return <div className="page"><Empty icon={<Inbox />} title="Nothing to review" text="This case has no graph yet." /></div>;
  if (!g) return <div className="center-fill">Loading…</div>;
  const ed = g.editable, vurl = `/cases/${caseId}/graph/versions/${g.version.id}`;
  const byId = (id: string) => g.nodes.find(n => n.id === id);
  const pn = g.nodes.filter(n => n.status === "pending");
  const pe = g.edges.filter(e => e.status === "pending" && e.evidence_ids.length && e.flag !== "unsupported");
  const dups = g.nodes.filter(n => n.dup_of && byId(n.dup_of) && !n.not_dup);
  const uns = g.edges.filter(e => (!e.evidence_ids.length || e.flag === "unsupported") && e.status !== "rejected");
  const conf = g.edges.filter(e => e.status === "conflict");
  const T: [string, string, number | null][] = [["entities", "Pending entities", pn.length], ["relationships", "Pending relationships", pe.length], ["duplicates", "Duplicate suggestions", dups.length],
    ["unsupported", "Unsupported claims", uns.length], ["conflicts", "Conflicting evidence", conf.length], ["history", "Approval history", null]];
  const nodeStatus = (n: GNode, s: string) => run(() => api.patch(`${vurl}/nodes/${n.id}`, { status: s }), `${s === "approved" ? "Approved" : "Rejected"} ${n.name}`);
  const edgeStatus = (e: GEdge, s: string) => run(() => api.patch(`${vurl}/edges/${e.id}`, { status: s }), `${s === "approved" ? "Approved" : "Rejected"} relationship`);
  const bulk = (body: object, ok: string) => run(() => api.post(`${vurl}/bulk-status`, body), ok);

  const edgeRow = (e: GEdge, accept = "Approve") => { const a = byId(e.s), b = byId(e.o); return <tr key={e.id}><td>
    <div className="row small" style={{ gap: 6, flexWrap: "wrap" }}>{e.status === "conflict" && <AlertTriangle size={14} style={{ color: "var(--warn)" }} />}
      {a && <ShapeIcon type={a.type} />}<b>{a?.name}</b><span className="rt" style={{ fontSize: 10.5, fontWeight: 600, color: "var(--tx3)", border: "1px solid var(--bd)", padding: "1px 5px", borderRadius: 3 }}>{e.type}</span>
      {b && <ShapeIcon type={b.type} />}<b>{b?.name}</b></div><EdgeEvidence caseId={caseId} edge={e} onOpen={setReading} /></td>
    <td style={{ width: 110 }}><ConfBar value={e.confidence} /></td>
    <td style={{ width: 230, textAlign: "right", whiteSpace: "nowrap" }}>{ed && <><button className="btn sm ok" disabled={!e.evidence_ids.length} title={e.evidence_ids.length ? "" : "Add a citation in the graph first"} onClick={() => edgeStatus(e, "approved")}><Check />{accept}</button>
      <button className="btn sm danger" onClick={() => edgeStatus(e, "rejected")}><X />Reject</button></>}
      <Link className="btn sm ghost" to={`/cases/${caseId}/graph?v=${g.version.id}`}>Graph</Link></td></tr>; };

  const body: Record<string, () => React.ReactNode> = {
    entities: () => pn.length ? <table className="tbl"><tbody>{pn.map(n => <tr key={n.id}><td><EtypeTag type={n.type} /><div style={{ fontWeight: 600 }} className="mt8">{n.name}</div>
      <div className="xs muted">{n.description}{n.aliases.length > 0 && ` · also “${n.aliases.join("”, “")}”`}</div></td><td style={{ width: 110 }}><ConfBar value={n.confidence} /></td>
      <td className="small muted">{n.doc_ids.length} source{n.doc_ids.length === 1 ? "" : "s"}</td>
      <td style={{ width: 230, textAlign: "right", whiteSpace: "nowrap" }}>{ed && <><button className="btn sm ok" onClick={() => nodeStatus(n, "approved")}><Check />Approve</button><button className="btn sm danger" onClick={() => nodeStatus(n, "rejected")}><X />Reject</button></>}</td></tr>)}</tbody></table>
      : <Empty icon={<Check />} title="No pending entities" text="Every entity in this version has been reviewed." />,
    relationships: () => pe.length ? <table className="tbl"><tbody>{pe.map(e => edgeRow(e))}</tbody></table> : <Empty icon={<Check />} title="No pending relationships" text="Every evidenced relationship has been reviewed." />,
    duplicates: () => dups.length ? <table className="tbl"><tbody>{dups.map(n => { const d = byId(n.dup_of!)!; return <tr key={n.id}><td><div className="row small"><ShapeIcon type={n.type} /><b>{n.name}</b><span className="dim">and</span><ShapeIcon type={d.type} /><b>{d.name}</b></div>
      <div className="xs dim mt8">{n.type !== d.type ? "Same name, different types" : "Similar names or matching alias"}</div></td>
      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>{ed && <><button className="btn sm" onClick={() => run(() => api.post(`${vurl}/merge`, { keep_id: d.id, drop_ids: [n.id] }), `Merged into ${d.name}`)}><Merge />Merge into {d.name.slice(0, 18)}</button>
        <button className="btn sm ghost" onClick={() => run(() => api.post(`${vurl}/nodes/${n.id}/not-duplicate`), "Marked distinct")}>Not a duplicate</button></>}</td></tr>; })}</tbody></table>
      : <Empty icon={<Check />} title="No duplicate suggestions" text="Entity resolution found no likely duplicates." />,
    unsupported: () => uns.length ? <table className="tbl"><tbody>{uns.map(e => edgeRow(e))}</tbody></table> : <Empty icon={<Check />} title="No unsupported claims" text="Every remaining claim cites a verified source passage." />,
    conflicts: () => conf.length ? <table className="tbl"><tbody>{conf.map(e => edgeRow(e, "Accept claim"))}</tbody></table> : <Empty icon={<Check />} title="No conflicts" text="No claims have contradicting sources." />,
    history: () => hist.data?.length ? <table className="tbl"><tbody>{hist.data.map(h => { const tgt = h.object_kind === "node" ? byId(h.object_id)?.name : h.object_kind === "edge" ? (() => { const e = g.edges.find(x => x.id === h.object_id); return e ? `${byId(e.s)?.name} ${e.type} ${byId(e.o)?.name}` : "relationship"; })() : g.version.label;
      return <tr key={h.id}><td className="small">{h.action}</td><td className="small trunc" style={{ maxWidth: 360 }}>{tgt ?? h.object_id}</td><td className="small muted">{h.actor}</td><td className="small muted">{ago(h.at)}</td></tr>; })}</tbody></table>
      : <Empty icon={<Inbox />} title="No review decisions yet" text="Approvals, rejections and merges appear here." />,
  };

  return <div className="page">
    <div className="page-head"><div className="grow"><h1>Review queue</h1><p>Graph {g.version.label} of {c.data?.title}. {g.version.status === "approved" ? "This version is approved and read only." : "Approve claims that are supported by their sources; reject the rest."}</p></div>
      {ed && tab === "relationships" && pe.length > 0 && <button className="btn" onClick={() => bulk({ edge_ids: pe.filter(e => e.confidence >= 0.8).map(e => e.id), status: "approved" }, "Approved high-confidence relationships")}>Approve all ≥ 80%</button>}
      {g.version.status === "draft" && can("graph.approve") && <Link className="btn ok" to={`/cases/${caseId}/graph?v=${g.version.id}`}><Check />Approve {g.version.label} in graph</Link>}
      <Link className="btn" to={`/cases/${caseId}/graph?v=${g.version.id}`}><Share2 />Open graph</Link></div>
    <div className="tabs" role="tablist">{T.map(([k, l, n]) => <button key={k} role="tab" className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l} {n != null && <span className={n ? "" : "dim"} style={n ? { color: "var(--warn)" } : undefined}>{n}</span>}</button>)}</div>
    <div className="panel" style={{ overflowX: "auto" }}>{body[tab]()}</div>
    {reading && <SourceDrawer docId={reading.doc} highlight={reading} onClose={() => setReading(null)} />}
  </div>;
}
