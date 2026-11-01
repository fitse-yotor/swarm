import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { Job } from "../api";
import { load, store } from "../prefs";

export type ViewMode = "left" | "split" | "right";
const STEPS = [["graph", "Graph Build"], ["environments", "Env Setup"], ["simulations", "Simulation"], ["reports", "Report"], ["interaction", "Interaction"]] as const;

/** MiroFish-style stage page: a canvas on the left, numbered step cards on the right, a system log under them. */
export function StageLayout({ step, caseId, status, leftLabel = "Graph", left, right, tabs, log, plainLeft, actions, caseStage = 0 }: {
  step: number; caseId: string; status: { label: string; tone: "ok" | "run" | "err" | "idle" }; leftLabel?: string; left: ReactNode;
  right: ReactNode; tabs?: ReactNode; log?: ReactNode; plainLeft?: boolean; actions?: ReactNode; caseStage?: number;
}) {
  const [mode, setMode] = useState<ViewMode>(() => load(`mode.${step}`, "split"));
  useEffect(() => { store(`mode.${step}`, mode); }, [mode, step]);
  return <div className="stage">
    <div className="stage-h">
      <div className="viewseg" role="group" aria-label="Layout">
        {([["left", leftLabel], ["split", "Split"], ["right", "Workbench"]] as const).map(([m, l]) =>
          <button key={m} className={mode === m ? "on" : ""} aria-pressed={mode === m} onClick={() => setMode(m)}>{l}</button>)}
      </div>
      {actions}
      <nav className="stepper5" aria-label="Workflow steps">{STEPS.map(([sub, label], i) => <Fragment key={sub}>
        {i > 0 && <i />}
        <Link to={`/cases/${caseId}/${sub}`} title={`Step ${i + 1}: ${label}`} className={i + 1 === step ? "cur" : i < Math.max(step - 1, caseStage) ? "done" : ""}
          aria-current={i + 1 === step ? "step" : undefined}>{i + 1}</Link></Fragment>)}</nav>
      <span className="stepind">Step {step}/5<b>{STEPS[step - 1][1]}</b></span>
      <span className={`dstat ${status.tone}`}><i />{status.label}</span>
    </div>
    <div className={`stage-b m-${mode}`}>
      <section className={`st-left ${plainLeft ? "plain" : ""}`} aria-label={leftLabel}>{left}</section>
      <section className="st-right" aria-label="Workbench">
        {tabs}
        <div className="st-scroll">{right}</div>
        {log}
      </section>
    </div>
  </div>;
}

export type StepState = "done" | "run" | "wait" | "fail" | "warn";
const BADGE: Record<StepState, string> = { done: "Complete", run: "Processing", wait: "Waiting", fail: "Failed", warn: "Needs review" };

export function StepCard({ n, title, state, badge, endpoint, desc, children, id }: {
  n: number; title: string; state: StepState; badge?: string; endpoint?: string; desc?: ReactNode; children?: ReactNode; id?: string;
}) {
  return <article className={`cstep ${state === "run" ? "active" : ""} ${state === "wait" ? "waiting" : ""}`} id={id}>
    <div className="cs-h"><span className="n">{String(n).padStart(2, "0")}</span><h3>{title}</h3>
      <span className={`csb ${state}`}>{badge ?? BADGE[state]}</span></div>
    {endpoint && <div className="cs-ep">{endpoint}</div>}
    {desc && <div className="cs-desc">{desc}</div>}
    {children}
  </article>;
}

export const Stats = ({ items }: { items: [ReactNode, string][] }) =>
  <div className={`statgrid ${items.length === 4 ? "c4" : ""}`}>{items.map(([v, l]) => <div key={l}><b>{v}</b><span>{l}</span></div>)}</div>;

export function SysLog({ job, title = "System dashboard", empty = "Waiting for the first job…" }: { job?: Job | null; title?: string; empty?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const n = job?.logs.length ?? 0;
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [n]);
  return <div className="syslog" role="log" aria-live="polite" aria-label="System log">
    <div className="syslog-h"><span>{title}</span><span>{job?.id ?? ""}</span></div>
    <div className="syslog-b" ref={ref}>{job?.logs.length ? job.logs.map((l, i) =>
      <div key={i} className="ln"><span className="t">{l.t}</span><span className={l.k}>{l.m}</span></div>) : <div className="ln"><span className="t">--:--:--</span><span>{empty}</span></div>}</div>
  </div>;
}

export const jobState = (j?: Job | null, done?: boolean): StepState =>
  !j ? (done ? "done" : "wait") : j.status === "failed" ? "fail" : j.status === "running" || j.status === "queued" ? "run" : j.status === "cancelled" ? "warn" : "done";

// ---------------------------------------------------------------- markdown (safe: builds React elements, never HTML)
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|_[^_]+_|`[^`]+`|\[(?:S\d+|R\d+|§[\w-]+)\])/g;
  let last = 0, m: RegExpExecArray | null, i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0], k = `${key}-${i++}`;
    if (t.startsWith("**")) out.push(<b key={k}>{t.slice(2, -2)}</b>);
    else if (t.startsWith("`")) out.push(<code key={k}>{t.slice(1, -1)}</code>);
    else if (t.startsWith("[")) out.push(<span key={k} className="cite-s">{t.slice(1, -1)}</span>);
    else out.push(<em key={k}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  type Blk = { k: "p" | "ul" | "q" | "h3" | "h4" | "t"; lines: string[] };
  const blocks: Blk[] = [];
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const line = raw.trimEnd();
    const k: Blk["k"] | null = !line.trim() ? null : line.trim().startsWith("|") ? "t" : /^\s*([-*]|\d+\.)\s+/.test(line) ? "ul" : line.startsWith(">") ? "q"
      : /^#{1,2}\s/.test(line) ? "h3" : /^#{3,4}\s/.test(line) ? "h4" : "p";
    const last = blocks[blocks.length - 1];
    if (!k) { if (last) blocks.push({ k: "p", lines: [] }); continue; }
    if (last && last.k === k && k !== "h3" && k !== "h4" && last.lines.length) last.lines.push(line);
    else blocks.push({ k, lines: [line] });
  }
  return <div className="md">{blocks.filter(b => b.lines.length).map((b, i) => {
    if (b.k === "t") {
      const rows = b.lines.filter(l => !/^\s*\|?\s*:?-{2,}/.test(l)).map(l => l.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim()));
      return <div key={i} style={{ overflowX: "auto", marginBottom: 12 }}><table className="tbl" style={{ fontSize: 12.5 }}><thead><tr>{rows[0].map((c, j) => <th key={j}>{c}</th>)}</tr></thead>
        <tbody>{rows.slice(1).map((r, j) => <tr key={j}>{r.map((c, x) => <td key={x}>{inline(c, `${i}-${j}-${x}`)}</td>)}</tr>)}</tbody></table></div>;
    }
    if (b.k === "ul") return <ul key={i}>{b.lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*([-*]|\d+\.)\s+/, ""), `${i}-${j}`)}</li>)}</ul>;
    if (b.k === "q") return <blockquote key={i}>{b.lines.map((l, j) => <Fragment key={j}>{inline(l.replace(/^>\s?/, ""), `${i}-${j}`)}{j < b.lines.length - 1 && <br />}</Fragment>)}</blockquote>;
    if (b.k === "h3") return <h3 key={i}>{inline(b.lines[0].replace(/^#+\s+/, ""), `${i}`)}</h3>;
    if (b.k === "h4") return <h4 key={i}>{inline(b.lines[0].replace(/^#+\s+/, ""), `${i}`)}</h4>;
    return <p key={i}>{b.lines.map((l, j) => <Fragment key={j}>{inline(l, `${i}-${j}`)}{j < b.lines.length - 1 && <br />}</Fragment>)}</p>;
  })}</div>;
}

// ---------------------------------------------------------------- line chart (one y-axis, crosshair tooltip, direct labels)
export interface Series { label: string; color: string; values: number[]; fmt?: (v: number) => string }

export function LineChart({ series, min, max, height = 150, xLabel = "Round", ticks, ariaLabel }: {
  series: Series[]; min: number; max: number; height?: number; xLabel?: string; ticks: number[]; ariaLabel: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(520);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = height, L = 34, R = 72, T = 8, B = 22;
  const n = Math.max(...series.map(s => s.values.length), 1);
  const x = (i: number) => L + (n <= 1 ? 0 : (i / (n - 1)) * (W - L - R));
  const y = (v: number) => T + (1 - (v - min) / (max - min)) * (H - T - B);
  const fmt = (s: Series, v: number) => (s.fmt ? s.fmt(v) : v.toFixed(2));
  // End-of-line labels, pushed apart when lines finish close together.
  const ends = series.map((s, i) => ({ i, y: s.values.length ? y(s.values[s.values.length - 1]) : 0 })).sort((a, b) => a.y - b.y);
  for (let k = 1; k < ends.length; k++) if (ends[k].y - ends[k - 1].y < 13) ends[k].y = ends[k - 1].y + 13;
  const labelY = Object.fromEntries(ends.map(e => [e.i, e.y]));
  return <div className="chart" ref={box}>
    {series.length > 1 && <div className="chart-legend">{series.map(s => <span key={s.label}><i style={{ background: s.color }} />{s.label}</span>)}</div>}
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={ariaLabel} onMouseLeave={() => setHover(null)}>
      <g className="grid">{ticks.map(t => <line key={t} x1={L} x2={W - R} y1={y(t)} y2={y(t)} />)}</g>
      <g className="axis">{ticks.map(t => <text key={t} x={L - 6} y={y(t) + 3.5} textAnchor="end">{t}</text>)}
        <text x={L} y={H - 4}>0</text><text x={W - R} y={H - 4} textAnchor="end">{xLabel} {n - 1}</text></g>
      {series.map((s, si) => <g key={s.label}>
        <polyline fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round"
          points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(" ")} />
        {s.values.length > 0 && <text x={x(s.values.length - 1) + 6} y={labelY[si] + 4} fontSize="11" fill="var(--tx2)">{series.length > 1 ? s.label : fmt(s, s.values[s.values.length - 1])}</text>}
      </g>)}
      {hover !== null && <g><line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} stroke="var(--tx3)" strokeDasharray="3 3" />
        {series.map(s => s.values[hover] !== undefined && <circle key={s.label} cx={x(hover)} cy={y(s.values[hover])} r={4} fill={s.color} stroke="var(--surf)" strokeWidth={2} />)}</g>}
      {Array.from({ length: n }, (_, i) => <rect key={i} className="hit" x={x(i) - (W - L - R) / Math.max(n - 1, 1) / 2} y={0} width={(W - L - R) / Math.max(n - 1, 1)} height={H}
        onMouseEnter={() => setHover(i)} />)}
    </svg>
    {hover !== null && <div className="chart-tip" style={{ left: `${(x(hover) / W) * 100}%`, top: 0, transform: `translateX(${hover > n / 2 ? "-105%" : "8px"})` }}>
      <div className="dim">{xLabel} {hover}</div>{series.map(s => s.values[hover] !== undefined && <div key={s.label}><span style={{ color: s.color }}>●</span> {s.label}: <b>{fmt(s, s.values[hover])}</b></div>)}</div>}
  </div>;
}

export const stanceColor = (s: number) => (s > 0.25 ? "var(--sup)" : s < -0.25 ? "var(--opp)" : "var(--neu)");
export const stanceWord = (s: number) => (s > 0.25 ? "Supports" : s < -0.25 ? "Opposes" : "Neutral");
