// Assistant available on every page. It knows the page and case you are on. Inside a case with an approved graph it
// answers from the graph (GraphRAG, local model) and cites sources; how-to questions are answered from built-in help.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useLocation } from "react-router-dom";
import { MessageSquare, Send, Sparkles, X } from "lucide-react";
import { api, type RagAnswer } from "../api";

type Msg = { who: "me" | "ai"; text: string; src?: string } | { who: "typing" };

const PAGE: [RegExp, string][] = [[/\/settings/, "Settings"], [/\/admin/, "Administration"], [/\/account/, "My account"], [/\/graph/, "Graph explorer"],
  [/\/dynamic/, "Dynamic graph"], [/\/reactions/, "Reactions"], [/\/review/, "Review queue"], [/\/documents/, "Documents"], [/\/build\//, "Graph build"],
  [/\/environments/, "Environment · personas"], [/\/simulations/, "Simulations"], [/\/reports/, "Reports"], [/\/interaction/, "Interaction"],
  [/^\/cases\/new/, "Create case"], [/^\/cases\/[^/]+$/, "Case overview"], [/^\/cases$/, "Cases"], [/^\/$/, "Dashboard"]];

const CHIPS: Record<string, string[]> = {
  Dashboard: ["What can you do?", "How do I start a case?"], Cases: ["How do I start a case?"],
  "Case overview": ["Summarize this case", "Explain the growth chart"], "Graph explorer": ["Who are the main actors?", "What is the simulation layer?"],
  "Environment · personas": ["How do I add a persona?"], Simulations: ["How do I trigger a reaction?", "How is sentiment measured?"],
  Reports: ["Summarize the evidence"], Settings: ["How do I change the model?", "When do .env changes apply?"],
};

const HELP: [RegExp, string][] = [
  [/trigger|comment on/i, "Open <b>Simulations</b>, pick a run, then a post, and make a persona comment on it. The post's author decides first from its behaviour profile and the stance gap; other personas react from their own profiles. Each decision shows its reason, the rows are labelled <i>analyst-trigger</i> / <i>reaction-model</i>, and the dynamic graph's simulation layer records the events."],
  [/add.*persona|persona.*add|synthetic/i, "Go to <b>Environment</b>, open an environment and use <b>Import synthetic personas</b>, or add an agent by hand in the network canvas. Synthetic agents always carry the SYNTHETIC label; real actors stay context-only."],
  [/start a case|new case|create.*case/i, "Press <b>Create case</b> on the Dashboard or Cases page: drop the seed documents, write the simulation requirement and start building. The case opens and its stage menus appear in the side rail."],
  [/model|ollama|\.env|env file|setting/i, "Open <b>Settings → Environment files</b> (administrators). Change <span class=\"mono\">OLLAMA_MODEL</span> (e.g. qwen3.5:4b) or <span class=\"mono\">OLLAMA_AGENT_MODEL</span> for faster AI agents, save, then restart the API and worker. Secrets are never shown in the browser."],
  [/apply|restart/i, "Settings are read when the API starts, so .env changes apply after a restart: <span class=\"mono\">docker compose up -d --force-recreate api worker</span>, or stop and start <span class=\"mono\">uvicorn</span> / Celery locally. A backup of the previous file is kept as .env.bak."],
  [/sentiment|positive|negative|neutral|tone/i, "Tone is each action's stance toward the case's focus issue: positive above +0.25, negative below −0.25, neutral in between (the same thresholds the simulation engine uses for camps). The case overview shows it per round, day or month."],
  [/growth|timeline|chart/i, "The growth chart stacks posts, replies, reactions and analyst-triggered actions per round, day or month; the line is how many personas have acted so far. Dates come from the simulation's start time and minutes per round."],
  [/simulation layer|layer/i, "The dynamic graph keeps three layers apart: research (approved, sourced), reaction hypotheses, and the simulation layer (synthetic agents, their statements and relationship changes). Simulations never write to the research layer."],
  [/what can you do|help|hello|^hi\b/i, "I explain the page you are on, answer how-to questions, and inside a case with an approved graph I answer from the graph with cited sources (GraphRAG on your local model)."],
];

export default function Assistant({ caseId, caseTitle, versionId }: { caseId: string | null; caseTitle?: string; versionId: string | null }) {
  const loc = useLocation();
  const page = PAGE.find(([re]) => re.test(loc.pathname))?.[1] ?? "This page";
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [msgs, setMsgs] = useState<Msg[]>([{ who: "ai", text: "Hi. I follow you across pages and answer with the context of the page and case you are on." }]);
  const [q, setQ] = useState("");
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.scrollTo(0, 1e6); }, [msgs, open]);

  const ask = async (question: string) => {
    setMsgs(m => [...m, { who: "me", text: question }, { who: "typing" }]);
    const help = HELP.find(([re]) => re.test(question));
    let reply: Msg;
    if (help && !(caseId && versionId && /summar|actor|evidence|who|what happened|why/i.test(question))) {
      reply = { who: "ai", text: help[1], src: `help · ${page}` };
    } else if (caseId && versionId) {
      try {
        const a = await api.post<RagAnswer>(`/cases/${caseId}/graphrag/query`, { question, version_id: versionId });
        reply = { who: "ai", text: escapeHtml(a.answer), src: `GraphRAG · ${a.support} · ${a.cited_sources.length} source${a.cited_sources.length === 1 ? "" : "s"}${a.model ? " · " + a.model : ""}` };
      } catch (e) {
        reply = { who: "ai", text: `I could not reach the graph for this case: ${escapeHtml((e as Error).message)}`, src: "error" };
      }
    } else {
      reply = { who: "ai", text: caseId ? "This case has no approved graph yet, so I can only answer how-to questions here. Build and approve the graph first." :
        "Open a case to ask about its content. Outside a case I can answer how-to questions; try one of the suggestions.", src: `help · ${page}` };
    }
    setMsgs(m => [...m.filter(x => x.who !== "typing"), reply]);
    if (!open) setUnread(u => u + 1);
  };
  const submit = (e: FormEvent) => { e.preventDefault(); const v = q.trim(); if (v) { setQ(""); void ask(v); } };

  return <>
    <button className="as-fab" onClick={() => { setOpen(o => !o); setUnread(0); }} aria-label={open ? "Close assistant" : "Open assistant"}>
      {open ? <X /> : <MessageSquare />}{!open && unread > 0 && <span className="un">{unread}</span>}</button>
    {open && <div className="as-panel" role="dialog" aria-label="Lattice assistant">
      <div className="as-h"><span className="as-ic"><Sparkles size={16} /></span><div className="grow"><b>Lattice assistant</b>
        <small>Context: {page}{caseTitle && page !== "Dashboard" && page !== "Cases" ? ` · ${caseTitle}` : ""}</small></div>
        <button className="v2-ibtn" onClick={() => setOpen(false)} aria-label="Close"><X /></button></div>
      <div className="as-msgs" ref={box}>{msgs.map((m, i) => m.who === "typing" ? <div key={i} className="as-msg ai"><span className="typing"><i /><i /><i /></span></div> :
        <div key={i} className={`as-msg ${m.who}`}><span dangerouslySetInnerHTML={{ __html: m.text }} />{m.src && <span className="src">{m.src}</span>}</div>)}</div>
      <div className="as-chips">{(CHIPS[page] ?? ["What can you do?"]).map(c => <button key={c} className="as-chip" onClick={() => void ask(c)}>{c}</button>)}</div>
      <form className="as-form" onSubmit={submit}><input value={q} onChange={e => setQ(e.target.value)} placeholder="Ask about this page…" aria-label="Ask the assistant" autoFocus />
        <button className="btn pri" aria-label="Send"><Send /></button></form>
    </div>}
  </>;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
