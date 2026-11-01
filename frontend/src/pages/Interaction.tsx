import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, FileText, MessageSquare, Send, Share2, Trash2, User } from "lucide-react";
import { api, streamText, type ChatMessage, type Conversation, type SimEvent } from "../api";
import { useAuth } from "../auth";
import { useToast } from "../components/ui";
import { Markdown, StageLayout, StepCard, stanceColor, stanceWord } from "../components/Stage";
import { useConvs, useReports, useSims, useSystem } from "../hooks";
import { useCase } from "./CaseDetail";
import { PROV, useReport } from "./Reports";
import { useSim } from "./Simulations";

export default function Interaction() {
  const { caseId = "", convId } = useParams();
  const c = useCase(caseId);
  const sys = useSystem();
  const status = sys.data?.llm.available ? { label: `${sys.data.llm.model} ready`, tone: "ok" as const } : { label: "Local LLM offline — stored answers only", tone: "err" as const };
  if (!convId) return <StageLayout step={5} caseId={caseId} status={status} leftLabel="Start" plainLeft caseStage={c.data?.stage ?? 0}
    left={<Picker caseId={caseId} />} right={<div className="st-cards"><Recent caseId={caseId} /></div>} />;
  return <ConversationView key={convId} caseId={caseId} convId={convId} status={status} caseStage={c.data?.stage ?? 0} />;
}

function Picker({ caseId }: { caseId: string }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const reps = useReports(caseId);
  const sims = useSims(caseId);
  const [simId, setSimId] = useState("");
  const done = (sims.data ?? []).filter(s => s.status === "done");
  const sim = useSim(simId || done[0]?.id || "");
  const start = async (target: string, simulation_id?: string) => {
    try { const cv = await api.post<Conversation>(`/cases/${caseId}/conversations`, { target, simulation_id }); qc.invalidateQueries({ queryKey: ["convs", caseId] }); nav(`/cases/${caseId}/interaction/${cv.id}`); }
    catch (e) { toast((e as Error).message, "err"); }
  };
  const ready = (reps.data ?? []).filter(r => r.status === "draft" || r.status === "approved");
  return <div className="doc" style={{ fontFamily: "var(--ui)" }}>
    <h1 className="doc-title">Deep interaction</h1>
    <p className="small muted mt8">Question the report agent, interview any simulated agent in character, or ask the case graph directly. Replies stream from the local model and stay grounded in stored data.</p>
    <div className="cs-label">Report agent</div>
    <div className="target-list">{ready.map(r => <button key={r.id} className="target" onClick={() => start(`report:${r.id}`)}><FileText /><div className="grow"><b>{r.title}</b><div className="xs dim">{r.status} · cites report sections [§] and sources [S#]</div></div></button>)}
      {!ready.length && <p className="xs dim">No finished reports yet.</p>}</div>
    <div className="cs-label">Simulated agents</div>
    <p className="xs dim mb8">Only agents that posted can be interviewed. Real actors that were context-only are not voiced — use “Ask the graph” for their documented positions.</p>
    {done.length ? <>
      <select className="sel mb8" value={simId || done[0].id} onChange={e => setSimId(e.target.value)} aria-label="Simulation run">{done.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
      <div className="profile-grid">{(sim.data?.agents ?? []).filter(a => a.speaks !== false).map(a => { const end = sim.data?.stats?.series?.[a.id]?.slice(-1)[0] ?? a.stance;
        return <button key={a.id} className="profile" onClick={() => start(`agent:${a.id}`, sim.data!.id)}>
          <h4><i style={{ width: 9, height: 9, borderRadius: "50%", background: stanceColor(end), flex: "none" }} /><span className="trunc">{a.name}</span>{a.synthetic && <span className="syn-badge">SYNTHETIC</span>}</h4>
          <div className="handle">{a.handle} · {stanceWord(end)} {end >= 0 ? "+" : ""}{end.toFixed(2)}</div><span className="role">{a.profession}</span><p>{a.persona}</p></button>; })}</div>
    </> : <p className="xs dim">No finished simulation runs yet.</p>}
    <div className="cs-label">Knowledge graph</div>
    <button className="target" onClick={() => start("graph")}><Share2 /><div className="grow"><b>Ask the graph</b><div className="xs dim">GraphRAG over the latest graph version · cites [S#] and [R#]</div></div></button>
  </div>;
}

function Recent({ caseId }: { caseId: string }) {
  const convs = useConvs(caseId);
  return <StepCard n={1} title="Your conversations" state={(convs.data ?? []).length ? "done" : "wait"} badge={`${(convs.data ?? []).length}`}>
    <div className="col mt12">{(convs.data ?? []).map(c => <Link key={c.id} className="listrow" to={`/cases/${caseId}/interaction/${c.id}`}>
      <MessageSquare size={16} /><div className="grow trunc">{c.title}</div><span className="xs dim">{c.message_count / 2} turns</span></Link>)}
      {!(convs.data ?? []).length && <p className="xs dim">Start one from the list on the left.</p>}</div>
  </StepCard>;
}

function ConversationView({ caseId, convId, status, caseStage }: { caseId: string; convId: string; status: { label: string; tone: "ok" | "err" }; caseStage: number }) {
  const { can } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const conv = useQuery({ queryKey: ["conv", convId], queryFn: () => api.get<Conversation>(`/conversations/${convId}`) });
  const cv = conv.data;
  const [kind, ref] = (cv?.target ?? ":").split(":");
  const [msgs, setMsgs] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => { if (cv?.messages && !busy) setMsgs(cv.messages); }, [cv?.messages, busy]);
  useEffect(() => { bottom.current?.scrollIntoView({ block: "end" }); }, [msgs]);

  const send = async () => {
    const q = input.trim();
    if (!q || busy) return;
    setInput(""); setBusy(true);
    const now = new Date().toISOString();
    setMsgs(m => [...m, { role: "user", content: q, at: now }, { role: "assistant", content: "", at: now }]);
    try {
      await streamText(`/conversations/${convId}/messages`, { content: q }, text => setMsgs(m => [...m.slice(0, -1), { ...m[m.length - 1], content: text }]));
    } catch (e) { toast((e as Error).message, "err"); }
    setBusy(false);
    qc.invalidateQueries({ queryKey: ["conv", convId] }); qc.invalidateQueries({ queryKey: ["convs", caseId] });
  };
  if (conv.isError) return <div className="page muted">{(conv.error as Error).message}</div>;
  if (!cv) return <div className="center-fill">Loading conversation…</div>;
  const who = kind === "report" ? "Report agent" : kind === "agent" ? `${cv.title.split(" · ")[0]}${ref.startsWith("syn_") ? " (synthetic)" : ""}` : "Graph";
  const suggestions = kind === "report" ? ["What are the key findings?", "Which actors moved the most, and why?", "What should we watch in the real world?"]
    : kind === "agent" ? ["What is your position, and why?", "Who do you trust on this issue?", "What would change your mind?"]
    : ["Who opposes the main policy?", "What are the key events?", "Which organizations are most connected?"];

  const chat = <div className="chat">
    <div className="chat-b" aria-live="polite">
      {!msgs.length && <div className="col"><p className="small muted">Ask {who.toLowerCase() === "graph" ? "the graph" : who} anything. Suggestions:</p>
        {suggestions.map(s => <button key={s} className="target" onClick={() => setInput(s)}><MessageSquare />{s}</button>)}</div>}
      {msgs.map((m, i) => <div key={i} className={`msg ${m.role}`}>
        {m.role === "assistant" ? <><div className="who"><Bot size={12} />{who}{m.model && <span className={`gen ${m.model.startsWith("ollama") ? "llm" : ""}`}>{m.model}</span>}</div>
          {m.content ? <Markdown text={m.content} /> : <span className="spinner" />}</> : m.content}
      </div>)}
      <div ref={bottom} />
    </div>
    <div className="chat-in">
      <textarea value={input} placeholder={can("chat.use") ? `Message ${who}… (Enter to send, Shift+Enter for a new line)` : "Your role cannot use conversations"} disabled={!can("chat.use")}
        onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} aria-label="Message" />
      <div className="col"><button className="btn pri" disabled={busy || !input.trim()} onClick={send} aria-label="Send"><Send /></button>
        <button className="btn ghost" title="Delete conversation" aria-label="Delete conversation" onClick={() => { if (confirm("Delete this conversation?")) api.del(`/conversations/${convId}`).then(() => { qc.invalidateQueries({ queryKey: ["convs", caseId] }); nav(`/cases/${caseId}/interaction`); }); }}><Trash2 /></button></div>
    </div>
  </div>;

  const left = kind === "report" ? <ReportContext repId={ref} /> : kind === "agent" && cv.simulation_id ? <AgentContext simId={cv.simulation_id} agentId={ref} />
    : <div className="doc" style={{ fontFamily: "var(--ui)" }}><h1 className="doc-title">Ask the graph</h1><p className="small muted mt8">Answers use GraphRAG: pgvector passage search plus the Neo4j neighborhood of matching entities. <Link to={`/cases/${caseId}/graph`}>Open the graph explorer</Link>.</p></div>;
  return <StageLayout step={5} caseId={caseId} status={status} leftLabel="Context" plainLeft caseStage={caseStage} left={left} right={chat}
    actions={<span className="small trunc"><User size={13} style={{ verticalAlign: -2 }} /> <b>{cv.title}</b></span>} />;
}

function ReportContext({ repId }: { repId: string }) {
  const rep = useReport(repId);
  const r = rep.data;
  if (!r) return <div className="center-fill">Loading report…</div>;
  return <div className="doc"><h1 className="doc-title">{r.title}</h1>
    {(r.sections ?? []).map(s => <section key={s.id} className="doc-sec"><h2>{s.title}<span className={`prov ${s.kind}`}>§{s.id}</span><span className="xs dim" style={{ fontFamily: "var(--ui)", fontWeight: 400 }}>{PROV[s.kind]}</span></h2><Markdown text={s.body} /></section>)}</div>;
}

function AgentContext({ simId, agentId }: { simId: string; agentId: string }) {
  const sim = useSim(simId);
  const posts = useQuery({ queryKey: ["simEvents", simId, agentId], queryFn: () => api.get<SimEvent[]>(`/simulations/${simId}/events?agent=${agentId}&originals=true&limit=50`) });
  const a = sim.data?.agents?.find(x => x.id === agentId);
  if (!a) return <div className="center-fill">Loading agent…</div>;
  const series = sim.data?.stats?.series?.[agentId] ?? [a.stance];
  const end = series[series.length - 1];
  return <div className="doc" style={{ fontFamily: "var(--ui)" }}>
    {a.synthetic && <p className="demo-flag mb12">Synthetic persona — a fictional archetype written for this simulation. Not a real person; replies are not real opinions.</p>}
    <div className="row"><span className="avatar" style={{ background: stanceColor(end), width: 44, height: 44, fontSize: 15 }}>{a.name.slice(0, 2).toUpperCase()}</span>
      <div><h1 className="doc-title" style={{ fontSize: 24 }}>{a.name}</h1><div className="xs dim">{a.handle} · {a.profession} · {a.kind}</div></div></div>
    <p className="mt12">{a.persona}</p>
    <div className="cs-label">Stance on {sim.data?.stats?.focus}: {series[0].toFixed(2)} → {end.toFixed(2)} ({stanceWord(end)})</div>
    <div className="stance-bar"><i style={{ left: `${(end + 1) * 50}%` }} /></div>
    {a.facts.length > 0 && <><div className="cs-label">Graph facts</div><ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>{a.facts.slice(0, 8).map(f => <li key={f}>{f}</li>)}</ul></>}
    <div className="cs-label">What they posted ({posts.data?.length ?? 0})</div>
    <div className="col">{(posts.data ?? []).map(p => <article key={p.id} className="post" style={{ borderLeftColor: stanceColor(p.stance) }}>
      <div className="ph"><b>{p.platform}</b><span className="h">{p.action.replace("CREATE_", "").toLowerCase()}</span><span className="r">R{p.round}</span></div>
      <div className="pc">{p.content}</div></article>)}</div>
  </div>;
}
