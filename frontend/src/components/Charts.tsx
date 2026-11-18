// Case dashboard charts from a real simulation run: persona reaction growth and positive / neutral / negative tone,
// by round, day or month. Round dates follow the engine: the run starts at 08:00 on its creation day and each round
// advances `minutes_per_round`.
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Heart, TrendingUp } from "lucide-react";
import { api, type SimEvent, type Simulation } from "../api";
import { useSims } from "../hooks";
import { load, store } from "../prefs";

export type Bucket = "round" | "day" | "month";
export type Tone = "pos" | "neu" | "neg";
export const TONE: Record<Tone, [string, string]> = { pos: ["Positive", "var(--sup)"], neu: ["Neutral", "var(--neu)"], neg: ["Negative", "var(--opp)"] };
const LEAN = 0.25; // same threshold the engine uses for support / oppose camps
export const toneOf = (s: number): Tone => (s > LEAN ? "pos" : s < -LEAN ? "neg" : "neu");
const isTrigger = (e: SimEvent) => /^(analyst-trigger|reaction-model)/.test(e.generated_by);

export interface Step { key: string; d: Date; label: string; sub: string; posts: number; replies: number; reactions: number; trig: number;
  engaged: number; pos: number; neu: number; neg: number; n: number }

const fmtD = (d: Date) => d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
const fmtT = (d: Date) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const fmtM = (d: Date) => d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
const fmtML = (d: Date) => d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
const mkey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}`;

export function roundDate(sim: Simulation, round: number) {
  const d = new Date(sim.created_at);
  d.setHours(8, 0, 0, 0);
  return new Date(d.getTime() + round * (sim.config?.minutes_per_round ?? 60) * 60_000);
}

export function buildSteps(sim: Simulation, events: SimEvent[], bucket: Bucket): Step[] {
  const rounds = [...(sim.rounds ?? [])].sort((a, b) => a.round - b.round);
  const seen = new Set<string>();
  const byRound = new Map<number, SimEvent[]>();
  events.forEach(e => byRound.set(e.round, [...(byRound.get(e.round) ?? []), e]));
  const steps: Step[] = rounds.map(r => {
    const evs = byRound.get(r.round) ?? [];
    evs.forEach(e => seen.add(e.agent_id));
    const a = r.actions ?? {};
    const posts = a.CREATE_POST ?? 0, replies = a.CREATE_COMMENT ?? 0;
    const reactions = Object.entries(a).filter(([k]) => !["CREATE_POST", "CREATE_COMMENT", "DO_NOTHING"].includes(k)).reduce((s, [, v]) => s + v, 0);
    const tones = { pos: 0, neu: 0, neg: 0 };
    evs.forEach(e => { tones[toneOf(e.stance)]++; });
    const d = roundDate(sim, r.round);
    return { key: `r${r.round}`, d, label: fmtD(d), sub: `R${r.round} · ${fmtT(d)}`, posts, replies, reactions, trig: evs.filter(isTrigger).length,
      engaged: seen.size, ...tones, n: 1 };
  });
  if (bucket === "round") return steps;
  const out: Step[] = [];
  for (const s of steps) {
    const k = bucket === "day" ? s.d.toDateString() : mkey(s.d);
    let g = out.find(x => x.key === k);
    if (!g) { g = { ...s, key: k, posts: 0, replies: 0, reactions: 0, trig: 0, pos: 0, neu: 0, neg: 0, n: 0 }; out.push(g); }
    g.posts += s.posts; g.replies += s.replies; g.reactions += s.reactions; g.trig += s.trig; g.pos += s.pos; g.neu += s.neu; g.neg += s.neg;
    g.engaged = s.engaged; g.n++;
  }
  out.forEach(g => { g.label = bucket === "day" ? fmtD(g.d) : fmtM(g.d); g.sub = `${g.n} round${g.n === 1 ? "" : "s"}`; });
  return out;
}

/** Latest finished simulation of a case (or the one picked), with its rounds and up to 1000 events. */
export function useSimInsight(caseId: string | null) {
  const sims = useSims(caseId);
  const done = (sims.data ?? []).filter(s => s.status === "done").sort((a, b) => b.created_at.localeCompare(a.created_at));
  const [pick, setPick] = useState<string | null>(null);
  const simId = pick && done.some(s => s.id === pick) ? pick : done[0]?.id ?? null;
  const sim = useQuery({ queryKey: ["sim", simId], enabled: !!simId, queryFn: () => api.get<Simulation>(`/simulations/${simId}`) });
  const events = useQuery({ queryKey: ["sim-events-all", simId], enabled: !!simId, queryFn: () => api.get<SimEvent[]>(`/simulations/${simId}/events?limit=1000`) });
  return { sims: done, simId, setPick, sim: sim.data, events: events.data ?? [], loading: sims.isLoading || sim.isLoading, truncated: (events.data?.length ?? 0) >= 1000 };
}

export function useBucket(): [Bucket, (b: Bucket) => void] {
  const [b, setB] = useState<Bucket>(() => load<Bucket>("bucket", "round"));
  useEffect(() => store("bucket", b), [b]);
  return [b, setB];
}

export const BucketSeg = ({ value, onChange }: { value: Bucket; onChange: (b: Bucket) => void }) => (
  <div className="viewseg" role="group" aria-label="Group by">{(["round", "day", "month"] as Bucket[]).map(b =>
    <button key={b} className={value === b ? "on" : ""} onClick={() => onChange(b)}>{b === "round" ? "Round" : b === "day" ? "Day" : "Month"}</button>)}</div>
);

function XAxis({ steps, X, H, bucket, slotPx }: { steps: Step[]; X: (i: number) => number; H: number; bucket: Bucket; slotPx: number }) {
  const groups: { k: string; a: number; b: number; d: Date }[] = [];
  steps.forEach((s, i) => { const k = mkey(s.d); const g = groups[groups.length - 1]; if (g && g.k === k) g.b = i; else groups.push({ k, a: i, b: i, d: s.d }); });
  const half = steps.length > 1 ? (X(1) - X(0)) / 2 : 30;
  const every = Math.max(1, Math.ceil(66 / slotPx)); // thin labels so they never overlap
  const showSub = slotPx * every >= 84;
  return <g>
    {steps.map((s, i) => i % every === 0 && <g key={s.key}><text x={X(i)} y={H - 30} textAnchor="middle" className="ax-l">{s.label}</text>
      {showSub && <text x={X(i)} y={H - 17} textAnchor="middle" className="ax-s">{s.sub}</text>}</g>)}
    {bucket !== "month" && groups.map(g => <g key={g.k}><line x1={X(g.a) - half + 4} x2={X(g.b) + half - 4} y1={H - 8} y2={H - 8} className="ax-br" />
      <text x={(X(g.a) + X(g.b)) / 2} y={H - 1} textAnchor="middle" className="ax-m">{fmtML(g.d)}</text></g>)}
  </g>;
}

export function GrowthChart({ steps, agents, bucket }: { steps: Step[]; agents: number; bucket: Bucket }) {
  const W = 1100, H = 270, pl = 36, pr = 40, pt = 16, pb = 50, n = steps.length, bw = Math.min(44, ((W - pl - pr) / n) * 0.6), X = (i: number) => pl + ((i + 0.5) * (W - pl - pr)) / n;
  const tot = (s: Step) => s.posts + s.replies + s.reactions + s.trig;
  const maxA = Math.max(4, ...steps.map(tot)), N = Math.max(1, agents);
  const Ya = (v: number) => H - pb - (v / maxA) * (H - pt - pb), Yc = (v: number) => H - pb - (Math.min(v, N) / N) * (H - pt - pb);
  const seg: [keyof Step, string, string][] = [["posts", "var(--acc)", "posts"], ["replies", "var(--steel)", "replies"], ["reactions", "var(--agent)", "likes, reposts, follows"], ["trig", "var(--hi)", "analyst-triggered"]];
  return <svg className="v2-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Persona reaction growth">
    {[0, 0.5, 1].map(f => <g key={f}><line x1={pl} x2={W - pr} y1={Ya(maxA * f)} y2={Ya(maxA * f)} className="gl" />
      <text x={pl - 8} y={Ya(maxA * f) + 4} textAnchor="end">{Math.round(maxA * f)}</text><text x={W - pr + 8} y={Yc(N * f) + 4}>{Math.round(N * f)}</text></g>)}
    {steps.map((s, i) => { let acc = 0; return <g key={s.key}>{seg.map(([k, c, l]) => { const v = s[k] as number; if (!v) return null; const y = Ya(acc + v), h = Ya(acc) - y; acc += v;
      return <rect key={k} x={X(i) - bw / 2} y={y} width={bw} height={h} fill={c} rx={2}><title>{`${s.label} ${s.sub}: ${v} ${l}`}</title></rect>; })}</g>; })}
    <polyline fill="none" stroke="var(--sup)" strokeWidth={2.5} points={steps.map((s, i) => `${X(i)},${Yc(s.engaged)}`).join(" ")} />
    {steps.map((s, i) => <circle key={s.key} cx={X(i)} cy={Yc(s.engaged)} r={3.5} fill="var(--sup)" stroke="var(--surf)" strokeWidth={2}><title>{`${s.label}: ${s.engaged} personas engaged`}</title></circle>)}
    <XAxis steps={steps} X={X} H={H} bucket={bucket} slotPx={(W - pl - pr) / n} />
  </svg>;
}

export function Donut({ c, size = 140 }: { c: Record<Tone, number>; size?: number }) {
  const tot = c.pos + c.neu + c.neg, R0 = size / 2 - 12, C = 2 * Math.PI * R0;
  let off = 0;
  return <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Tone split">
    <circle cx={size / 2} cy={size / 2} r={R0} fill="none" stroke="var(--elev)" strokeWidth={18} />
    {tot > 0 && (["pos", "neu", "neg"] as Tone[]).map(k => { const len = (c[k] / tot) * C; const el = <circle key={k} cx={size / 2} cy={size / 2} r={R0} fill="none" stroke={TONE[k][1]} strokeWidth={18}
      strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-off} transform={`rotate(-90 ${size / 2} ${size / 2})`} />; off += len; return el; })}
    <text x="50%" y="48%" textAnchor="middle" className="dn-v">{tot}</text><text x="50%" y="62%" textAnchor="middle" className="dn-l">actions</text></svg>;
}

export const sumTone = (steps: Step[]) => steps.reduce((a, s) => ({ pos: a.pos + s.pos, neu: a.neu + s.neu, neg: a.neg + s.neg }), { pos: 0, neu: 0, neg: 0 });
export const pct = (c: Record<Tone, number>, k: Tone) => { const t = c.pos + c.neu + c.neg; return t ? Math.round((c[k] / t) * 100) : 0; };

export function ToneBars({ steps, bucket }: { steps: Step[]; bucket: Bucket }) {
  const W = 760, H = 240, pl = 36, pr = 10, pt = 10, pb = 50, n = steps.length, bw = Math.min(40, ((W - pl - pr) / n) * 0.62), X = (i: number) => pl + ((i + 0.5) * (W - pl - pr)) / n, Y = (f: number) => pt + (1 - f) * (H - pt - pb);
  return <svg className="v2-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Tone per step">
    {[0, 0.5, 1].map(f => <g key={f}><line x1={pl} x2={W - pr} y1={Y(f)} y2={Y(f)} className="gl" /><text x={pl - 6} y={Y(f) + 4} textAnchor="end">{f * 100}%</text></g>)}
    {steps.map((s, i) => { const t = s.pos + s.neu + s.neg; if (!t) return null; let acc = 0;
      return <g key={s.key}>{(["neg", "neu", "pos"] as Tone[]).map(k => { const f = s[k] / t; const y = Y(acc + f), h = Y(acc) - y; acc += f;
        return h > 0 ? <rect key={k} x={X(i) - bw / 2} y={y} width={bw} height={h} fill={TONE[k][1]}><title>{`${s.label}: ${s[k]} ${TONE[k][0].toLowerCase()}`}</title></rect> : null; })}</g>; })}
    <XAxis steps={steps} X={X} H={H} bucket={bucket} slotPx={(W - pl - pr) / n} />
  </svg>;
}

export const GrowthTitle = () => <><TrendingUp size={16} className="h-ic" /> Persona reaction growth</>;
export const ToneTitle = () => <><Heart size={16} className="h-ic" /> Reaction sentiment</>;
