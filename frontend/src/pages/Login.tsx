import { useState, type FormEvent } from "react";
import { useAuth } from "../auth";
import { Logo } from "../components/Shell";
import { Avatar } from "../components/ui";

// Demo workspace accounts created by `python -m app.seed` (password demo1234).
const DEMO = [["Samuel Teklu", "analyst@lattice.demo", "Lead analyst"], ["Yusuf Adeyemi", "reviewer@lattice.demo", "Reviewer"],
  ["Lena Brandt", "lena@lattice.demo", "Analyst"], ["Ines Carvalho", "viewer@lattice.demo", "Viewer"], ["Mira Okonjo", "admin@lattice.demo", "Administrator"]];

function Art() {
  const pts = Array.from({ length: 34 }, (_, i) => {
    const a = i * 2.399, r = 30 + 12 * Math.sqrt(i) * 4;
    return [400 + Math.cos(a) * r, 380 + Math.sin(a) * r * 0.8, ["person", "organization", "country", "location", "event", "policy"][i % 6]] as const;
  });
  return <svg viewBox="0 0 800 760" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    {pts.map(([x, y], i) => pts.slice(i + 1, i + 4).map(([x2, y2], j) => <line key={`${i}-${j}`} x1={x} y1={y} x2={x2} y2={y2} stroke="var(--bd)" strokeWidth="1" />))}
    {pts.map(([x, y, t], i) => <circle key={i} cx={x} cy={y} r={i % 5 === 0 ? 7 : 4.5} fill={`var(--${t})`} opacity=".85" />)}
  </svg>;
}

export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(""); setBusy(true);
    try { await login(email, password); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  return <div className="login">
    <div className="login-art"><Art />
      <div className="login-copy"><h1>From sources to an evidence-grounded graph.</h1>
        <p className="muted mt12">Upload documents, extract entities and relationships with their exact source passages, review every claim and approve an immutable graph snapshot for simulation.</p></div></div>
    <div className="login-form">
      <form onSubmit={submit}>
        <div className="row mb12"><Logo /><div><div className="brand-name">Lattice</div><div className="brand-sub">M2 Swarm · Case intelligence</div></div></div>
        <h2>Sign in</h2>
        <div className="field"><label htmlFor="em">Email</label><input id="em" className="inp" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} /></div>
        <div className="field"><label htmlFor="pw">Password</label><input id="pw" className="inp" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} /></div>
        {err && <div className="small" style={{ color: "var(--err)" }} role="alert">{err}</div>}
        <button className="btn pri big" disabled={busy || !email || !password}>{busy ? "Signing in…" : "Sign in"}</button>
        <div className="sec-t mt12">Demo accounts</div>
        {DEMO.map(([n, em, role]) => <button type="button" key={em} className="acct" onClick={() => { setEmail(em); setPassword("demo1234"); }}>
          <Avatar name={n} size={26} /><div className="grow"><div className="small" style={{ fontWeight: 600 }}>{n}</div><div className="xs dim">{role} · {em}</div></div></button>)}
      </form>
    </div>
  </div>;
}
