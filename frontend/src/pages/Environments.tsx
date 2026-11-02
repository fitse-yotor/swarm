import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { addEdge, Background, BackgroundVariant, Controls, Handle, Position, ReactFlow, useEdgesState, useNodesState,
  type Connection, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ArrowRight, Check, Copy, Layers, Plus, RefreshCw, Save, Trash2, Users } from "lucide-react";
import { api, type Agent, type AgentLink, type EnvConfig, type Environment, type Graph, type Simulation } from "../api";
import { useAuth } from "../auth";
import { Empty, isUnavailable, Modal, useToast } from "../components/ui";
import { StageLayout, StepCard, Stats, SysLog, jobState, stanceColor, stanceWord } from "../components/Stage";
import { useEnvs, useJob, useTheme } from "../hooks";
import { ago, initials } from "../vocab";
import { useCase } from "./CaseDetail";

const LINK_STYLE: Record<AgentLink["kind"], { stroke: string; dash?: string; label: string }> = {
  ally: { stroke: "var(--sup)", label: "Ally" }, opponent: { stroke: "var(--opp)", dash: "6 4", label: "Opponent" },
  contact: { stroke: "var(--tx2)", label: "Contact" }, shared: { stroke: "var(--tx2)", dash: "3 4", label: "Shared issue" },
};

export function useEnv(envId: string) {
  return useQuery({ queryKey: ["env", envId], queryFn: () => api.get<Environment>(`/environments/${envId}`),
    refetchInterval: q => (q.state.data?.status === "preparing" ? 1500 : false) });
}

// ---------------------------------------------------------------- list + create
export default function Environments() {
  const { caseId = "", envId } = useParams();
  if (envId) return <EnvironmentView caseId={caseId} envId={envId} />;
  return <EnvironmentList caseId={caseId} />;
}

function EnvironmentList({ caseId }: { caseId: string }) {
  const [sp, setSp] = useSearchParams();
  const { can } = useAuth();
  const envs = useEnvs(caseId);
  const c = useCase(caseId);
  const creating = sp.get("new") === "1";
  return <div className="page">
    <div className="page-head"><div className="grow"><h1>Environment setup</h1>
      <p>An environment turns the case graph's people, organizations and countries into simulation agents with personas, stances and a social network.</p></div>
      {can("env.edit") && <button className="btn pri" onClick={() => setSp({ new: "1" })}><Plus />New environment</button>}</div>
    {creating && <NewEnvModal caseId={caseId} title={c.data?.title ?? ""} onClose={() => setSp({})} />}
    {envs.data && !envs.data.length && <Empty icon={<Layers />} title="No environments yet" text="Create one from the latest graph version. The local LLM writes personas for the most influential actors.">
      {can("env.edit") && <button className="btn pri" onClick={() => setSp({ new: "1" })}><Plus />New environment</button>}</Empty>}
    <div className="col">{(envs.data ?? []).map(e => <Link key={e.id} className="listrow" to={`/cases/${caseId}/environments/${e.id}`}>
      <Layers size={18} color="var(--location)" /><div className="grow"><b>{e.name}</b><div className="xs dim">{e.scenario || "Baseline — no injected event"}</div></div>
      <span className="xs dim">{e.agent_count} agents · {e.link_count} links · graph {e.version_label}</span>
      <span className={`badge ${e.status === "approved" ? "b-ok" : e.status === "failed" ? "b-err" : e.status === "preparing" ? "b-warn" : "b-acc"}`}><i />{e.status}</span>
      <span className="xs dim">{ago(e.created_at)}</span></Link>)}</div>
  </div>;
}

function NewEnvModal({ caseId, title, onClose }: { caseId: string; title: string; onClose: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const graph = useQuery({ queryKey: ["graph", caseId, null], queryFn: () => api.get<Graph>(`/cases/${caseId}/graph`), retry: false });
  const [f, setF] = useState({ name: "Baseline", scenario: "", version_id: "", focus_node_id: "", rounds: 24, llm_personas: 6, llm_posts_per_round: 1, context_only: true, focus_label: "", shock: 0 });
  const [busy, setBusy] = useState(false);
  const focusOpts = (graph.data?.nodes ?? []).filter(n => ["event", "policy", "topic"].includes(n.type) && n.status !== "rejected").sort((a, b) => b.degree - a.degree);
  const submit = async () => {
    setBusy(true);
    try {
      const env = await api.post<Environment>(`/cases/${caseId}/environments`, { name: f.name, scenario: f.scenario, version_id: f.version_id || null,
        config: { rounds: f.rounds, llm_personas: f.llm_personas, llm_posts_per_round: f.llm_posts_per_round, real_actors_context_only: f.context_only, scenario_shock: f.shock, ...(f.focus_label.trim() ? { focus_label: f.focus_label.trim() } : {}),
          ...(f.focus_node_id ? { focus_node_id: f.focus_node_id } : {}) } });
      qc.invalidateQueries({ queryKey: ["envs", caseId] });
      nav(`/cases/${caseId}/environments/${env.id}`);
    } catch (e) { toast((e as Error).message, "err"); setBusy(false); }
  };
  return <Modal title="New environment" sub={`Agents are generated from a graph version of “${title}”.`} onClose={onClose}
    footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn pri" disabled={busy || !f.name.trim() || !graph.data} onClick={submit}>{busy ? "Starting…" : "Generate environment"}</button></>}>
    {graph.isError && <p className="small" style={{ color: "var(--err)" }}>{isUnavailable(graph.error) ? (graph.error as Error).message : "This case has no graph yet — build one first."}</p>}
    <div className="col gap12">
      <div className="field"><label htmlFor="en">Name</label><input id="en" className="inp" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></div>
      <div className="field"><label htmlFor="es">Scenario (what-if injected into the run)</label>
        <textarea id="es" className="inp" rows={3} placeholder="e.g. The Ministry announces an emergency cut to irrigation allocations." value={f.scenario} onChange={e => setF({ ...f, scenario: e.target.value })} /></div>
      <div className="field"><label htmlFor="esh">Scenario push toward the focus issue: <b>{f.shock > 0 ? "+" : ""}{f.shock.toFixed(1)}</b> ({f.shock > 0.15 ? "favourable news" : f.shock < -0.15 ? "unfavourable news" : "neutral news"})</label>
        <input id="esh" type="range" min={-100} max={100} step={10} value={f.shock * 100} onChange={e => setF({ ...f, shock: +e.target.value / 100 })} />
        <span className="hint">When the scenario is injected every posting agent hears it. Agents close to its direction move toward it; agents far from it push back.</span></div>
      <div className="form-grid">
        <div className="field"><label htmlFor="ev">Graph version</label><select id="ev" className="sel" value={f.version_id} onChange={e => setF({ ...f, version_id: e.target.value })}>
          <option value="">Latest approved (else latest draft)</option>{(graph.data?.versions ?? []).map(v => <option key={v.id} value={v.id}>{v.label} · {v.status} · {v.node_count} entities</option>)}</select></div>
        <div className="field"><label htmlFor="ef">Focus issue (stance is measured toward it)</label><select id="ef" className="sel" value={f.focus_node_id} onChange={e => setF({ ...f, focus_node_id: e.target.value })}>
          <option value="">Automatic — most contested event or policy</option>{focusOpts.map(n => <option key={n.id} value={n.id}>{n.name} ({n.type})</option>)}</select></div>
        <div className="field" style={{ gridColumn: "1 / -1" }}><label htmlFor="efl">…or describe the focus issue in words</label>
          <input id="efl" className="inp" value={f.focus_label} placeholder="e.g. Ethiopian sea access through a commercial port agreement" onChange={e => setF({ ...f, focus_label: e.target.value })} />
          <span className="hint">Stance (−1 opposes · +1 supports) is measured toward this. Overrides the graph node above.</span></div>
        <div className="field"><label htmlFor="er">Rounds (1 round = 1 simulated hour)</label><input id="er" type="number" className="inp" min={1} max={200} value={f.rounds} onChange={e => setF({ ...f, rounds: +e.target.value })} /></div>
        <div className="field"><label htmlFor="ep">LLM-written personas (top agents)</label><input id="ep" type="number" className="inp" min={0} max={50} value={f.llm_personas} onChange={e => setF({ ...f, llm_personas: +e.target.value })} /></div>
        <div className="field"><label htmlFor="eq">LLM-written posts per round</label><input id="eq" type="number" className="inp" min={0} max={10} value={f.llm_posts_per_round} onChange={e => setF({ ...f, llm_posts_per_round: +e.target.value })} /></div>
      </div>
      <label className="chk"><input type="checkbox" checked={f.context_only} onChange={e => setF({ ...f, context_only: e.target.checked })} />
        <span><b>Real actors are context-only</b> — people, parties and governments from the graph shape the scenario, but no posts are written in their names. Import synthetic personas to populate the run.</span></label>
      <p className="xs dim">The local LLM runs on this machine's CPU: each persona or post takes roughly 15–40 seconds. Everything else is generated from the graph instantly.</p>
    </div></Modal>;
}

// ---------------------------------------------------------------- detail
type AgentNodeData = { agent: Agent; selected: boolean };
function AgentNode({ data }: NodeProps<Node<AgentNodeData>>) {
  const a = data.agent;
  const ctx = a.speaks === false;
  return <div className={`rf-agent ${data.selected ? "sel" : ""}`} style={ctx ? { opacity: .5 } : undefined}>
    <Handle type="target" position={Position.Top} />
    <div className="disc" style={{ background: stanceColor(a.stance), width: 32 + a.influence * 22, height: 32 + a.influence * 22,
      ...(a.synthetic ? { outline: "2px dashed var(--warn)", outlineOffset: 2 } : {}) }}>{a.persona_id?.replace(/^SIM/, "S") ?? (initials(a.name) || "?")}</div>
    <div className="nm">{a.name}</div>
    <Handle type="source" position={Position.Bottom} />
  </div>;
}
const nodeTypes = { agent: AgentNode };

function toFlow(agents: Agent[], links: AgentLink[], sel: string | null) {
  return {
    nodes: agents.map(a => ({ id: a.id, type: "agent", position: { x: a.x ?? 0, y: a.y ?? 0 }, data: { agent: a, selected: a.id === sel } })) as Node<AgentNodeData>[],
    edges: links.map(l => ({ id: l.id, source: l.s, target: l.o, data: { kind: l.kind, relation: l.relation },
      style: { stroke: LINK_STYLE[l.kind].stroke, strokeDasharray: LINK_STYLE[l.kind].dash, strokeWidth: l.kind === "ally" || l.kind === "opponent" ? 2.4 : 1.6 } })) as Edge[],
  };
}

function EnvironmentView({ caseId, envId }: { caseId: string; envId: string }) {
  const { can } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const env = useEnv(envId);
  const job = useJob(env.data?.job_id);
  const c = useCase(caseId);
  const e = env.data;
  const [sel, setSel] = useState<string | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<AgentNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [cfg, setCfg] = useState<EnvConfig | null>(null);
  const [dirty, setDirty] = useState(false);
  const [launch, setLaunch] = useState(false);
  const [importing, setImporting] = useState(false);
  const editable = !!e && (e.status === "ready") && can("env.edit");
  const theme = useTheme() === "light" ? "light" : "dark";
  const [tip, setTip] = useState<{ x: number; y: number; agent?: Agent; edge?: { kind: string; relation: string; s: string; o: string } } | null>(null);
  const flowBox = useRef<HTMLDivElement>(null);
  const at = (e: { clientX: number; clientY: number }) => { const r = flowBox.current?.getBoundingClientRect(); return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) }; };

  // Load server state unless the analyst has unsaved edits.
  useEffect(() => {
    if (!e?.agents || dirty) return;
    setAgents(e.agents); setCfg(e.config);
    const f = toFlow(e.agents, e.links ?? [], sel);
    setNodes(f.nodes); setEdges(f.edges);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [e?.revision, e?.status, e?.agents?.length]);
  useEffect(() => { setNodes(ns => ns.map(n => ({ ...n, data: { ...n.data, selected: n.id === sel } }))); }, [sel, setNodes]);
  useEffect(() => { if (job.data?.status === "done" || job.data?.status === "failed") qc.invalidateQueries({ queryKey: ["env", envId] }); }, [job.data?.status, qc, envId]);

  const onConnect = useCallback((conn: Connection) => {
    if (!editable || conn.source === conn.target) return;
    setEdges(es => addEdge({ ...conn, id: `l_new_${Date.now()}`, data: { kind: "contact", relation: "added by analyst" }, style: { stroke: LINK_STYLE.contact.stroke, strokeWidth: 1.2 } }, es));
    setDirty(true);
  }, [editable, setEdges]);

  const updateAgent = (id: string, patch: Partial<Agent>) => {
    setAgents(as => as.map(a => (a.id === id ? { ...a, ...patch } : a)));
    setNodes(ns => ns.map(n => (n.id === id ? { ...n, data: { ...n.data, agent: { ...n.data.agent, ...patch } } } : n)));
    setDirty(true);
  };

  const save = async () => {
    if (!e) return;
    const pos = Object.fromEntries(nodes.map(n => [n.id, n.position]));
    const ids = new Set(nodes.map(n => n.id));
    const body = {
      revision: e.revision, config: cfg,
      agents: agents.filter(a => ids.has(a.id)).map(a => ({ ...a, x: Math.round(pos[a.id]?.x ?? a.x), y: Math.round(pos[a.id]?.y ?? a.y) })),
      links: edges.map(x => ({ id: x.id, s: x.source, o: x.target, kind: (x.data?.kind as string) ?? "contact", relation: (x.data?.relation as string) ?? "", weight: x.data?.kind === "ally" ? 0.8 : 0.5 })),
    };
    try { await api.patch(`/environments/${e.id}`, body); setDirty(false); await qc.invalidateQueries({ queryKey: ["env", envId] }); toast("Environment saved", "ok"); }
    catch (err) { toast((err as Error).message, "err"); }
  };
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try { const r = await fn(); await qc.invalidateQueries({ queryKey: ["env", envId] }); qc.invalidateQueries({ queryKey: ["envs", caseId] }); toast(ok, "ok"); return r; }
    catch (err) { toast((err as Error).message, "err"); }
  };

  const stats = useMemo(() => ({
    llm: agents.filter(a => a.generated_by !== "template").length,
    topics: new Set(agents.flatMap(a => a.interests)).size,
    sup: agents.filter(a => a.stance > 0.25).length, opp: agents.filter(a => a.stance < -0.25).length,
    syn: agents.filter(a => a.synthetic).length, ctx: agents.filter(a => a.speaks === false).length,
  }), [agents]);

  if (env.isError) return <div className="page muted">{(env.error as Error).message}</div>;
  if (!e) return <div className="center-fill">Loading environment…</div>;
  const preparing = e.status === "preparing";
  const selected = agents.find(a => a.id === sel);
  const j = job.data ?? e.job ?? null;
  const status = preparing ? { label: `Processing ${j?.progress ?? 0}%`, tone: "run" as const } : e.status === "failed" ? { label: "Failed", tone: "err" as const }
    : { label: e.status === "approved" ? "Approved" : dirty ? "Unsaved changes" : "Ready", tone: "ok" as const };

  const left = preparing && !nodes.length ? <div className="center-fill"><div className="col" style={{ alignItems: "center" }}><span className="spinner" /><span className="small muted">Generating agents from graph {e.version_label}…</span></div></div>
    : <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={ch => { onNodesChange(ch); if (editable && ch.some(x => x.type === "position" && !x.dragging)) setDirty(true); if (editable && ch.some(x => x.type === "remove")) setDirty(true); }}
      onEdgesChange={ch => { onEdgesChange(ch); if (ch.some(x => x.type === "remove")) setDirty(true); }} onConnect={onConnect}
      onNodeClick={(_, n) => setSel(n.id)} onPaneClick={() => setSel(null)}
      onNodeMouseEnter={(e, n) => setTip({ ...at(e), agent: (n.data as AgentNodeData).agent })} onNodeMouseMove={e => setTip(t => (t ? { ...t, ...at(e) } : t))}
      onNodeMouseLeave={() => setTip(null)}
      onEdgeMouseEnter={(e, x) => setTip({ ...at(e), edge: { kind: String(x.data?.kind ?? "contact"), relation: String(x.data?.relation ?? ""),
        s: agents.find(a => a.id === x.source)?.name ?? x.source, o: agents.find(a => a.id === x.target)?.name ?? x.target } })}
      onEdgeMouseLeave={() => setTip(null)} nodesDraggable={editable} nodesConnectable={editable} elementsSelectable
      deleteKeyCode={editable ? ["Delete", "Backspace"] : null} colorMode={theme} fitView fitViewOptions={{ padding: 0.15, maxZoom: 1.4 }} minZoom={0.2} proOptions={{ hideAttribution: true }}>
      <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="var(--dot)" />
      <Controls showInteractive={false} position="bottom-right" />
    </ReactFlow>;
  const tipCard = tip && <div className="rf-tip" style={{ left: Math.min(tip.x + 16, (flowBox.current?.clientWidth ?? 9999) - 310), top: tip.y + 16 }}>
    {tip.agent ? <>
      <div className="row" style={{ gap: 6 }}><i className="g3-dot" style={{ background: stanceColor(tip.agent.stance) }} /><b>{tip.agent.name}</b>
        {tip.agent.synthetic && <span className="syn-badge">SYNTHETIC</span>}{tip.agent.speaks === false && <span className="ctx-badge">CONTEXT ONLY</span>}</div>
      <div className="xs muted mt8">{tip.agent.profession}{tip.agent.country ? ` · ${tip.agent.country}` : ""} · {stanceWord(tip.agent.stance)} {tip.agent.stance >= 0 ? "+" : ""}{tip.agent.stance.toFixed(2)}</div>
      <div className="stance-bar mt8"><i style={{ left: `${(tip.agent.stance + 1) * 50}%` }} /></div>
      <p className="xs mt8" style={{ color: "var(--tx2)", lineHeight: 1.5 }}>{(tip.agent.persona || tip.agent.bio).slice(0, 220)}{(tip.agent.persona || tip.agent.bio).length > 220 ? "…" : ""}</p>
      <div className="xs dim mt8">Influence {tip.agent.influence.toFixed(2)} · activity {tip.agent.activity.toFixed(2)} · {edges.filter(x => x.source === tip.agent!.id || x.target === tip.agent!.id).length} links</div>
      {tip.agent.interests.length > 0 && <div>{tip.agent.interests.slice(0, 4).map(t => <span key={t} className="itag">{t}</span>)}</div>}
    </> : tip.edge && <div className="small"><b>{tip.edge.s}</b> <span className="muted">— {LINK_STYLE[tip.edge.kind as AgentLink["kind"]]?.label ?? tip.edge.kind} —</span> <b>{tip.edge.o}</b>
      {tip.edge.relation && <div className="xs dim mt8">{tip.edge.relation}</div>}</div>}
  </div>;

  const cards = <div className="st-cards">
    {selected && <AgentEditor agent={selected} editable={editable} onChange={p => updateAgent(selected.id, p)} onClose={() => setSel(null)}
      onRemove={() => { setNodes(ns => ns.filter(n => n.id !== selected.id)); setEdges(es => es.filter(x => x.source !== selected.id && x.target !== selected.id)); setAgents(as => as.filter(a => a.id !== selected.id)); setSel(null); setDirty(true); }} />}
    <StepCard n={1} title="Read Graph" state={jobState(j, true) === "fail" && (j?.stage ?? 0) <= 1 ? "fail" : (j?.stage ?? 9) >= 1 || !preparing ? "done" : "run"} endpoint={`GET /api/v1/cases/${caseId}/graph?version_id=${e.version_id}`}
      desc={<>Agents come from graph <b>{e.version_label}</b> ({e.version_status}). Stance is measured toward <b>{e.config.focus_name ?? "the focus issue"}</b>.</>} />
    <StepCard n={2} title="Generate Agent Profiles" state={preparing && (j?.stage ?? 0) <= 2 ? "run" : e.status === "failed" ? "fail" : "done"}
      badge={preparing && (j?.stage ?? 0) <= 2 ? `${j?.progress ?? 0}%` : undefined} endpoint={`POST /api/v1/cases/${caseId}/environments`}
      desc="Each actor gets a persona, interests, stance, activity and influence. The most influential get personas written by the local LLM; the rest are assembled from graph facts.">
      <Stats items={[[agents.length, "Current agents"], [stats.syn, "Synthetic personas"], [stats.ctx, "Context-only actors"], [stats.topics, "Related topics"]]} />
      {stats.ctx > 0 && !stats.syn && <p className="small mt12" style={{ color: "var(--warn)" }}>All real actors are context-only, so nobody can post yet. Import synthetic personas.</p>}
      {editable && <div className="cs-actions"><button className="btn pri sm" onClick={() => setImporting(true)}>Import synthetic personas</button></div>}
      <div className="cs-label">Generated agent profiles</div>
      <div className="profile-grid">{agents.map(a => <button key={a.id} className={`profile ${sel === a.id ? "on" : ""}`} onClick={() => setSel(a.id)}>
        <h4><i style={{ width: 9, height: 9, borderRadius: "50%", background: stanceColor(a.stance), flex: "none" }} /><span className="trunc">{a.name}</span>
          {a.synthetic && <span className="syn-badge">SYNTHETIC</span>}{a.speaks === false && <span className="ctx-badge">CONTEXT ONLY</span>}</h4>
        <div className="handle">{a.handle} · {a.synthetic ? a.country : a.kind}</div>
        <span className="role">{a.profession}</span>
        <p>{a.persona || a.bio}</p>
        <div>{a.interests.slice(0, 3).map(t => <span key={t} className="itag">{t}</span>)}{a.interests.length > 3 && <span className="xs dim">+{a.interests.length - 3}</span>}
          {a.generated_by !== "template" && <span className="gen llm" style={{ marginLeft: 4 }}>{a.generated_by}</span>}</div>
      </button>)}</div>
    </StepCard>
    <StepCard n={3} title="Generate Config" state={preparing ? "wait" : "done"} endpoint={`PATCH /api/v1/environments/${e.id}`}
      desc={`Dual-platform run (${e.config.platforms.join(" + ")}); bounded-confidence opinion dynamics. Edit values here, then save.`}>
      {cfg && <ConfigForm cfg={cfg} editable={editable} onChange={x => { setCfg(x); setDirty(true); }} />}
      <div className="cs-label">Seed posts</div>
      {(e.seed_posts ?? []).length ? (e.seed_posts ?? []).map((s, i) => <div key={i} className="post" style={{ marginBottom: 8 }}>
        <div className="ph"><b>{s.source === "scenario injection" ? "Scenario" : "Case sources"}</b><span className="r">round {s.round}</span></div><div className="pc">{s.content}</div></div>)
        : <p className="xs dim">No seed posts.</p>}
      <div className="cs-label">Social network</div>
      <div className="chips">{(Object.keys(LINK_STYLE) as AgentLink["kind"][]).map(k => <span key={k} className="chip"><svg width="18" height="4"><line x1="0" y1="2" x2="18" y2="2" stroke={LINK_STYLE[k].stroke} strokeWidth="2" strokeDasharray={LINK_STYLE[k].dash} /></svg>
        {LINK_STYLE[k].label} · {edges.filter(x => x.data?.kind === k).length}</span>)}</div>
      <p className="xs dim mt8">Drag agents to arrange; drag from an agent's bottom handle to another to add a link; select and press Delete to remove. {stats.sup} supporting · {stats.opp} opposing.</p>
    </StepCard>
    <StepCard n={4} title="Approve & Launch" state={e.status === "approved" ? "done" : preparing ? "wait" : "run"} badge={e.status === "approved" ? "Approved" : preparing ? "Waiting" : "Ready"}
      endpoint={`POST /api/v1/environments/${e.id}/simulations`} desc={`${e.simulation_count} simulation run(s) use this environment.`}>
      <div className="cs-actions">
        {dirty && <button className="btn pri" onClick={save}><Save />Save changes</button>}
        {dirty && <button className="btn" onClick={() => { setDirty(false); qc.invalidateQueries({ queryKey: ["env", envId] }); setAgents(e.agents ?? []); const f = toFlow(e.agents ?? [], e.links ?? [], sel); setNodes(f.nodes); setEdges(f.edges); setCfg(e.config); }}>Discard</button>}
        {!dirty && e.status === "ready" && can("env.approve") && <button className="btn ok" onClick={() => act(() => api.post(`/environments/${e.id}/approve`), "Environment approved")}><Check />Approve</button>}
        {!dirty && (e.status === "ready" || e.status === "approved") && can("sim.run") && <button className="btn pri" onClick={() => setLaunch(true)}>Start Dual-Platform Simulation<ArrowRight /></button>}
        {!dirty && (e.status === "ready" || e.status === "approved") && can("env.edit") && <button className="btn" onClick={() => act(() => api.post<Environment>(`/environments/${e.id}/duplicate`), "Duplicated").then(r => r && nav(`/cases/${caseId}/environments/${(r as Environment).id}`))}><Copy />Duplicate</button>}
        {(e.status === "ready" || e.status === "failed") && can("env.edit") && <button className="btn" onClick={() => act(() => api.post(`/environments/${e.id}/regenerate`), "Regenerating")}><RefreshCw />Regenerate</button>}
        {e.status !== "approved" && !preparing && can("env.edit") && <button className="btn danger" onClick={() => { if (confirm(`Delete ${e.name}?`)) act(() => api.del(`/environments/${e.id}`), "Deleted").then(() => nav(`/cases/${caseId}/environments`)); }}><Trash2 />Delete</button>}
      </div>
    </StepCard>
  </div>;

  return <>
    <StageLayout step={2} caseId={caseId} status={status} leftLabel="Network" caseStage={c.data?.stage ?? 0}
      left={<div ref={flowBox} style={{ position: "absolute", inset: 0 }} onMouseLeave={() => setTip(null)}>{left}{tipCard}</div>} right={cards} log={<SysLog job={j} />}
      actions={<span className="small" style={{ minWidth: 0 }}><Users size={13} style={{ verticalAlign: -2 }} /> <b>{e.name}</b> <span className="dim">· {e.scenario ? e.scenario.slice(0, 60) + (e.scenario.length > 60 ? "…" : "") : "baseline"}</span></span>} />
    {launch && <LaunchModal env={e} onClose={() => setLaunch(false)} />}
    {importing && <PersonaModal envId={e.id} onClose={() => setImporting(false)} onDone={() => { setDirty(false); qc.invalidateQueries({ queryKey: ["env", envId] }); }} />}
  </>;
}

function ConfigForm({ cfg, editable, onChange }: { cfg: EnvConfig; editable: boolean; onChange: (c: EnvConfig) => void }) {
  const num = (k: keyof EnvConfig, label: string, min: number, max: number, step = 1) => <div className="field"><label>{label}</label>
    <input className="inp" type="number" min={min} max={max} step={step} value={cfg[k] as number} disabled={!editable} onChange={x => onChange({ ...cfg, [k]: +x.target.value })} /></div>;
  return <div className="form-grid mt12">
    <label className="chk" style={{ gridColumn: "1 / -1" }}><input type="checkbox" disabled={!editable} checked={cfg.real_actors_context_only ?? false}
      onChange={x => onChange({ ...cfg, real_actors_context_only: x.target.checked })} />Real actors are context-only (no posts in real people's or governments' names)</label>
    {num("rounds", "Rounds", 1, 200)}{num("minutes_per_round", "Minutes per round", 5, 1440, 5)}
    {num("llm_posts_per_round", "LLM posts / round", 0, 10)}{num("inject_round", "Scenario injected at round", 0, 200)}
    {num("scenario_shock", "Scenario push (−1…+1)", -1, 1, 0.1)}
    {num("epsilon", "Confidence bound ε", 0.05, 2, 0.05)}{num("mu", "Influence rate μ", 0, 1, 0.05)}
    {num("seed", "Random seed", 0, 99999)}{num("backfire", "Backfire", 0, 0.5, 0.01)}
  </div>;
}

function AgentEditor({ agent: a, editable, onChange, onClose, onRemove }: { agent: Agent; editable: boolean; onChange: (p: Partial<Agent>) => void; onClose: () => void; onRemove: () => void }) {
  const slider = (k: "stance" | "activity" | "influence", label: string, min: number) => <div className="field"><label>{label}</label>
    <div className="range-row"><input type="range" min={min * 100} max={100} value={a[k] * 100} disabled={!editable} aria-label={label} onChange={x => onChange({ [k]: +x.target.value / 100 })} /><output>{a[k].toFixed(2)}</output></div></div>;
  return <article className="cstep active">
    <div className="cs-h"><span className="n" style={{ color: stanceColor(a.stance) }}>●</span><h3>{a.name}</h3>
      {a.synthetic ? <span className="syn-badge">SYNTHETIC</span> : a.speaks === false ? <span className="ctx-badge">CONTEXT ONLY</span> : <span className="csb">{a.kind}</span>}
      <button className="btn ghost sm" onClick={onClose} aria-label="Close agent">✕</button></div>
    <div className="cs-ep">{a.handle} · {a.followers.toLocaleString()} followers · stance from {a.stance_source} · {a.generated_by}</div>
    <div className="col gap12 mt12">
      <div className="field"><label>Profession</label><input className="inp" value={a.profession} disabled={!editable} onChange={x => onChange({ profession: x.target.value })} /></div>
      {a.synthetic && <p className="xs" style={{ color: "var(--warn)" }}>Fictional archetype for simulation only — not a real person, and its posts are not public opinion.</p>}
      {!a.synthetic && <label className="chk"><input type="checkbox" disabled={!editable} checked={a.speaks !== false} onChange={x => onChange({ speaks: x.target.checked })} />
        Can post in simulations (off = context-only real actor)</label>}
      {slider("stance", `Stance — ${stanceWord(a.stance)} (−1 opposes · +1 supports)`, -1)}
      <div className="stance-bar"><i style={{ left: `${(a.stance + 1) * 50}%` }} /></div>
      <div className="form-grid">{slider("activity", "Activity", 0)}{slider("influence", "Influence", 0.05)}</div>
      <div className="field"><label>Persona</label><textarea className="inp" rows={4} value={a.persona} disabled={!editable} onChange={x => onChange({ persona: x.target.value })} /></div>
      <div className="field"><label>Interests (comma separated)</label><input className="inp" value={a.interests.join(", ")} disabled={!editable} onChange={x => onChange({ interests: x.target.value.split(",").map(t => t.trim()).filter(Boolean) })} /></div>
      {a.facts.length > 0 && <div><div className="cs-label" style={{ marginTop: 0 }}>Graph facts</div><ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>{a.facts.slice(0, 8).map(f => <li key={f}>{f}</li>)}</ul></div>}
      {editable && <div><button className="btn sm danger" onClick={onRemove}><Trash2 />Remove agent</button></div>}
    </div>
  </article>;
}

function LaunchModal({ env, onClose }: { env: Environment; onClose: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const [rounds, setRounds] = useState(env.config.rounds);
  const [llm, setLlm] = useState(env.config.llm_posts_per_round);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const s = await api.post<Simulation>(`/environments/${env.id}/simulations`, { rounds, llm_posts_per_round: llm });
      qc.invalidateQueries({ queryKey: ["sims", env.case_id] });
      nav(`/cases/${env.case_id}/simulations/${s.id}`);
    } catch (e) { toast((e as Error).message, "err"); setBusy(false); }
  };
  const speakers = (env.agents ?? []).filter(a => a.speaks !== false).length;
  return <Modal title="Start simulation" sub={`${speakers} posting agents (${env.agent_count - speakers} context-only) on ${env.config.platforms.join(" + ")} · engine lattice-abm/1`} onClose={onClose}
    footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn pri" disabled={busy} onClick={go}>{busy ? "Starting…" : "Start"}</button></>}>
    <div className="form-grid">
      <div className="field"><label htmlFor="lr">Rounds</label><input id="lr" className="inp" type="number" min={1} max={200} value={rounds} onChange={e => setRounds(+e.target.value)} /></div>
      <div className="field"><label htmlFor="ll">LLM-written posts per round</label><input id="ll" className="inp" type="number" min={0} max={10} value={llm} onChange={e => setLlm(+e.target.value)} /></div>
    </div>
    <p className="xs dim mt12">Template posts are instant. Each LLM-written post takes about 15–30 s on this CPU, so {rounds} rounds × {llm} ≈ {Math.round(rounds * llm * 22 / 60)} min.</p>
  </Modal>;
}

function PersonaModal({ envId, onClose, onDone }: { envId: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const r = await api.post<Environment & { imported: number; skipped: string[] }>(`/environments/${envId}/personas`, { text, replace });
      toast(`Imported ${r.imported} synthetic persona${r.imported === 1 ? "" : "s"}${r.skipped.length ? ` · ${r.skipped.length} line(s) not understood` : ""}`, r.skipped.length ? "warn" : "ok");
      onDone(); onClose();
    } catch (e) { toast((e as Error).message, "err"); setBusy(false); }
  };
  return <Modal title="Import synthetic personas" wide onClose={onClose}
    sub="Paste persona lines from a case study. Each becomes a fictional agent with a permanent SYNTHETIC label."
    footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn pri" disabled={busy || text.trim().length < 10} onClick={go}>{busy ? "Importing…" : "Import"}</button></>}>
    <div className="col gap12">
      <textarea className="inp" rows={12} value={text} onChange={e => setText(e.target.value)} style={{ fontFamily: "var(--mono)", fontSize: 12.5 }}
        placeholder={"Topic codes: T01 commerce; T02 sovereignty; T03 cooperation; T04 security\n- **SIM01 — Ethiopian logistics entrepreneur (Ethiopia; supportive)**: “A predictable port arrangement…” [simulation topic T01]\n- SIM02 - University student (Ethiopia; cautiously supportive) [stance +0.3]: “…” [simulation topic T03]"} />
      <p className="xs dim">Format: <code className="mono">SIM01 — label (country; viewpoint) [stance ±0.0]: “comment” [simulation topic T01]</code>. Bold markers, the stance tag and the topic tag are optional; without a stance tag it is inferred from the viewpoint (supportive, sovereignty focused…). A “Topic codes:” line names the topics. Copying the persona section from a case PDF works.</p>
      <label className="chk"><input type="checkbox" checked={replace} onChange={e => setReplace(e.target.checked)} />Replace previously imported synthetic personas</label>
    </div></Modal>;
}
