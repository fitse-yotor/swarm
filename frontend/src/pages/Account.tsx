import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { KeyRound, LogOut, Moon, Shield, Sun, UserRound } from "lucide-react";
import { api, type AccountActivity } from "../api";
import { useAuth } from "../auth";
import { Avatar, Spinner, useToast } from "../components/ui";
import { applyTheme, useTheme } from "../hooks";
import { ago, fmtDate } from "../vocab";

const EVENT_LABEL: Record<string, string> = {
  "auth.login": "Signed in", "account.update": "Updated profile", "account.password": "Changed password",
  "admin.user.update": "Account changed by an administrator", "admin.user.password": "Password reset by an administrator",
};

export default function Account() {
  const { user, can, logout, refresh } = useAuth();
  const toast = useToast();
  const act = useQuery({ queryKey: ["account-activity"], queryFn: () => api.get<AccountActivity>("/auth/me/activity?limit=12") });
  const [name, setName] = useState(user!.name);
  const [pw, setPw] = useState({ current: "", next: "", confirm: "" });
  const theme = useTheme();

  const profile = useMutation({
    mutationFn: () => api.patch("/auth/me", { name }),
    onSuccess: () => { refresh(); act.refetch(); toast("Profile saved", "ok"); },
    onError: e => toast((e as Error).message, "err"),
  });
  const password = useMutation({
    mutationFn: () => api.post("/auth/me/password", { current_password: pw.current, new_password: pw.next }),
    onSuccess: () => { setPw({ current: "", next: "", confirm: "" }); act.refetch(); toast("Password changed", "ok"); },
    onError: e => toast((e as Error).message, "err"),
  });
  const flipTheme = () => applyTheme(theme === "dark" ? "light" : "dark");
  const mismatch = !!pw.confirm && pw.next !== pw.confirm;
  const submitPw = (e: FormEvent) => { e.preventDefault(); if (!mismatch) password.mutate(); };
  const u = user!;

  return <div className="page" style={{ maxWidth: 880 }}>
    <div className="page-head"><div className="row grow" style={{ gap: 14 }}><Avatar name={u.name} size={52} />
      <div style={{ minWidth: 0 }}><h1 className="trunc">{u.name}</h1><p className="trunc">{u.email} · {u.role}{act.data && ` · ${act.data.workspace}`}</p></div></div></div>

    <div className="col" style={{ gap: 16 }}>
      <section className="panel"><div className="panel-h"><UserRound size={15} /><h3>Profile</h3></div>
        <form className="panel-b form-grid" onSubmit={e => { e.preventDefault(); profile.mutate(); }}>
          <div className="field"><label htmlFor="a-name">Display name</label><input id="a-name" className="inp" value={name} onChange={e => setName(e.target.value)} />
            <span className="hint">Shown on cases, reviews and the activity log.</span></div>
          <div className="field"><label htmlFor="a-email">Email</label><input id="a-email" className="inp" value={u.email} disabled />
            <span className="hint">Ask an administrator to change your email or role.</span></div>
          <div className="row" style={{ gridColumn: "1 / -1", justifyContent: "flex-end" }}>
            <button className="btn pri" disabled={name.trim().length < 2 || name.trim() === u.name || profile.isPending}>{profile.isPending && <Spinner />}Save profile</button></div>
        </form></section>

      <section className="panel"><div className="panel-h"><KeyRound size={15} /><h3>Password</h3></div>
        <form className="panel-b form-grid" onSubmit={submitPw}>
          <input type="text" autoComplete="username" value={u.email} readOnly hidden />
          <div className="field" style={{ gridColumn: "1 / -1" }}><label htmlFor="a-cur">Current password</label>
            <input id="a-cur" className="inp" type="password" autoComplete="current-password" value={pw.current} onChange={e => setPw({ ...pw, current: e.target.value })} /></div>
          <div className="field"><label htmlFor="a-new">New password</label>
            <input id="a-new" className="inp" type="password" autoComplete="new-password" value={pw.next} onChange={e => setPw({ ...pw, next: e.target.value })} /></div>
          <div className="field"><label htmlFor="a-conf">Confirm new password</label>
            <input id="a-conf" className={`inp ${mismatch ? "bad" : ""}`} type="password" autoComplete="new-password" value={pw.confirm} onChange={e => setPw({ ...pw, confirm: e.target.value })} aria-invalid={mismatch} />
            {mismatch && <span className="errt">The passwords do not match</span>}</div>
          <div className="row" style={{ gridColumn: "1 / -1", justifyContent: "flex-end" }}>
            <button className="btn pri" disabled={!pw.current || !pw.next || pw.next !== pw.confirm || password.isPending}>{password.isPending && <Spinner />}Change password</button></div>
        </form></section>

      <section className="panel"><div className="panel-h"><h3>Preferences & session</h3></div><div className="panel-b col" style={{ gap: 14 }}>
        <div className="row wrap"><div className="grow"><b className="small">Theme</b><div className="xs dim">Saved on this device.</div></div>
          <button type="button" className="tgl" aria-pressed={theme === "light"} onClick={flipTheme}><span className="switch" />{theme === "dark" ? <><Moon size={14} />Dark</> : <><Sun size={14} />Light</>}</button></div>
        <div className="row wrap"><div className="grow"><b className="small">Session</b><div className="xs dim">Sign-ins last {act.data?.session_hours ?? "…"} hours. Member since {act.data ? fmtDate(act.data.created_at) : "…"}.</div></div>
          <button className="btn danger" onClick={logout}><LogOut />Sign out</button></div>
        {can("admin.access") && <div className="row wrap"><div className="grow"><b className="small">Administration</b><div className="xs dim">Users, roles, settings and the activity log.</div></div>
          <Link className="btn" to="/admin"><Shield />Open</Link></div>}
      </div></section>

      <section className="panel"><div className="panel-h"><h3>Recent account activity</h3></div>
        {act.isLoading ? <p className="panel-b muted">Loading…</p> : <ul className="timeline-list">{(act.data?.events ?? []).map(e =>
          <li key={e.id}><span className="grow">{EVENT_LABEL[e.action] ?? e.action}{e.actor !== u.name && <span className="dim"> · by {e.actor}</span>}</span>
            <time className="xs dim" dateTime={e.at} title={fmtDate(e.at)}>{ago(e.at)}</time></li>)}
          {!act.data?.events.length && <li className="dim">No activity yet.</li>}</ul>}
      </section>
    </div>
  </div>;
}
