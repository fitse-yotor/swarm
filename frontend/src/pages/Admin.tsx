import { useEffect, useState, type ChangeEvent, type ReactNode } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, AlertTriangle, Copy, KeyRound, Lock, Pencil, Plus, RefreshCw, Shield, Trash2, UserPlus, Users } from "lucide-react";
import { api, type AdminUser, type AuditEntry, type AuditPage, type Permission, type Role, type ServiceName, type WorkspaceSettings } from "../api";
import { useAuth } from "../auth";
import { Avatar, Empty, Modal, Spinner, useToast } from "../components/ui";
import { ago, fmtDate } from "../vocab";

const TABS = [["users", "Users"], ["roles", "Roles"], ["activity", "Activity"], ["settings", "Settings"]] as const;
type Tab = typeof TABS[number][0];

const Field = ({ label, hint, htmlFor, children }: { label: string; hint?: ReactNode; htmlFor?: string; children: ReactNode }) =>
  <div className="field"><label htmlFor={htmlFor}>{label}</label>{children}{hint && <span className="hint">{hint}</span>}</div>;

const StatusPill = ({ status }: { status: string }) =>
  <span className={`badge ${status === "Active" ? "b-ok" : "b-warn"}`}><i />{status}</span>;

/** Shared mutation wrapper: refreshes admin data (and the signed-in user, whose permissions may change) and toasts. */
function useAdminMutation<A, R>(fn: (a: A) => Promise<R>, ok?: string | ((r: R, a: A) => string)) {
  const qc = useQueryClient();
  const toast = useToast();
  const { refresh } = useAuth();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r, a) => {
      ["admin-users", "admin-roles", "admin-settings", "admin-audit", "workspace"].forEach(k => qc.invalidateQueries({ queryKey: [k] }));
      refresh().catch(() => undefined);  // your own role or permissions may have changed
      if (ok) toast(typeof ok === "string" ? ok : ok(r, a), "ok");
    },
    onError: e => toast((e as Error).message, "err"),
  });
}

export default function Admin() {
  const { can } = useAuth();
  const { tab = "users" } = useParams<{ tab: Tab }>();
  const nav = useNavigate();
  if (!can("admin.access")) return <Navigate to="/" replace />;
  if (!TABS.some(([k]) => k === tab)) return <Navigate to="/admin" replace />;
  return <div className="page">
    <div className="page-head"><div className="grow"><h1>Administration</h1>
      <p>Manage who can sign in to this workspace, what each role is allowed to do, and the defaults new cases and environments start from.</p></div></div>
    <div className="tabs" role="tablist">{TABS.map(([k, l]) =>
      <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => nav(k === "users" ? "/admin" : `/admin/${k}`)}>{l}</button>)}</div>
    {tab === "users" && <UsersTab />}
    {tab === "roles" && <RolesTab />}
    {tab === "activity" && <ActivityTab />}
    {tab === "settings" && <SettingsTab />}
  </div>;
}

// ------------------------------------------------------------------ users
function useRoles() {
  return useQuery({ queryKey: ["admin-roles"], queryFn: () => api.get<{ roles: Role[]; permissions: Permission[] }>("/admin/roles") });
}

function UsersTab() {
  const { user: me } = useAuth();
  const users = useQuery({ queryKey: ["admin-users"], queryFn: () => api.get<AdminUser[]>("/admin/users") });
  const roles = useRoles();
  const [q, setQ] = useState("");
  const [f, setF] = useState("All");
  const [editing, setEditing] = useState<AdminUser | "new" | null>(null);
  const [resetting, setResetting] = useState<AdminUser | null>(null);
  const [deleting, setDeleting] = useState<AdminUser | null>(null);
  const [secret, setSecret] = useState<{ email: string; password: string } | null>(null);
  const toggle = useAdminMutation((u: AdminUser) => api.patch<AdminUser>(`/admin/users/${u.id}`, { status: u.status === "Active" ? "Suspended" : "Active" }),
    r => r.status === "Active" ? `${r.name} reactivated` : `${r.name} suspended`);

  const all = users.data ?? [];
  const list = all.filter(u => (f === "All" || u.status === f) && (!q || `${u.name} ${u.email} ${u.role}`.toLowerCase().includes(q.toLowerCase())));
  return <>
    <div className="toolbar mb12">
      <div className="seg" role="tablist" aria-label="Filter by status">{["All", "Active", "Suspended"].map(s =>
        <button key={s} className={f === s ? "on" : ""} onClick={() => setF(s)}>{s} <span className="dim">{s === "All" ? all.length : all.filter(u => u.status === s).length}</span></button>)}</div>
      <input className="inp tb-search" placeholder="Search name, email, role" value={q} onChange={e => setQ(e.target.value)} aria-label="Search users" />
      <button className="btn pri" onClick={() => setEditing("new")}><UserPlus />Add user</button>
    </div>
    <div className="panel" style={{ overflowX: "auto" }}>
      {users.isLoading ? <p className="panel-b muted">Loading…</p> : !list.length ? <Empty icon={<Users />} title="No users match" text="Clear the filter or add a user." /> :
        <table className="tbl stack"><thead><tr><th>User</th><th>Role</th><th>Status</th><th className="hm">Cases</th><th className="hm">Last sign-in</th><th style={{ textAlign: "right" }}>Actions</th></tr></thead>
          <tbody>{list.map(u => <tr key={u.id}>
            <td className="cell-main"><div className="row"><Avatar name={u.name} size={26} /><div style={{ minWidth: 0 }}><div style={{ fontWeight: 600 }}>{u.name}{u.id === me?.id && <span className="dim small"> · you</span>}</div>
              <div className="xs dim trunc">{u.email}</div></div></div></td>
            <td><span className="badge">{u.role}</span></td>
            <td><StatusPill status={u.status} /></td>
            <td className="hm">{u.case_count}</td>
            <td className="hm small muted">{u.last_login_at ? ago(u.last_login_at) : "Never"}</td>
            <td className="cell-acts">
              <button className="btn ghost sm icon" aria-label={`Edit ${u.name}`} title="Edit" onClick={() => setEditing(u)}><Pencil /></button>
              <button className="btn ghost sm icon" aria-label={`Reset password for ${u.name}`} title="Reset password" onClick={() => setResetting(u)}><KeyRound /></button>
              <button className="btn ghost sm" disabled={u.id === me?.id || toggle.isPending} onClick={() => toggle.mutate(u)}>{u.status === "Active" ? "Suspend" : "Reactivate"}</button>
              <button className="btn ghost sm icon" aria-label={`Delete ${u.name}`} title={u.case_count ? "Owns cases — suspend instead" : "Delete"} disabled={u.id === me?.id || u.case_count > 0} onClick={() => setDeleting(u)}><Trash2 /></button>
            </td></tr>)}</tbody></table>}
    </div>
    <p className="xs dim mt8">Suspended users cannot sign in. Users who own cases can be suspended but not deleted, so case history keeps its owner.</p>
    {editing && <UserModal user={editing === "new" ? null : editing} roles={roles.data?.roles ?? []} onClose={() => setEditing(null)}
      onCreated={(email, password) => password && setSecret({ email, password })} />}
    {resetting && <ResetModal user={resetting} onClose={() => setResetting(null)} onDone={p => p && setSecret({ email: resetting.email, password: p })} />}
    {deleting && <DeleteUserModal user={deleting} onClose={() => setDeleting(null)} />}
    {secret && <SecretModal {...secret} onClose={() => setSecret(null)} />}
  </>;
}

function UserModal({ user, roles, onClose, onCreated }: { user: AdminUser | null; roles: Role[]; onClose: () => void; onCreated: (email: string, password: string | null) => void }) {
  const [d, setD] = useState({ name: user?.name ?? "", email: user?.email ?? "", role: user?.role ?? roles.find(r => r.name === "Viewer")?.name ?? roles[0]?.name ?? "", password: "" });
  const save = useAdminMutation(async () => {
    if (user) return { user: await api.patch<AdminUser>(`/admin/users/${user.id}`, { name: d.name, email: d.email, role: d.role }), temporary_password: null };
    return api.post<{ user: AdminUser; temporary_password: string | null }>("/admin/users", { ...d, password: d.password || null });
  }, r => user ? `Saved ${r.user.name}` : `Added ${r.user.name}`);
  const valid = d.name.trim().length >= 2 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.email.trim()) && !!d.role;
  const role = roles.find(r => r.name === d.role);
  return <Modal title={user ? `Edit ${user.name}` : "Add user"} onClose={onClose}
    footer={<><button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn pri" disabled={!valid || save.isPending} onClick={() => save.mutate(undefined, { onSuccess: r => { onCreated(r.user.email, r.temporary_password); onClose(); } })}>{save.isPending && <Spinner />}{user ? "Save changes" : "Add user"}</button></>}>
    <div className="col gap12">
      <Field label="Name" htmlFor="u-name"><input id="u-name" className="inp" value={d.name} onChange={e => setD({ ...d, name: e.target.value })} autoFocus /></Field>
      <Field label="Email" htmlFor="u-email"><input id="u-email" className="inp" type="email" value={d.email} onChange={e => setD({ ...d, email: e.target.value })} /></Field>
      <Field label="Role" htmlFor="u-role" hint={role ? `${role.description || "Custom role"} · ${role.permissions.length} permissions` : undefined}>
        <select id="u-role" className="sel" value={d.role} onChange={e => setD({ ...d, role: e.target.value })}>{roles.map(r => <option key={r.id} value={r.name}>{r.name}</option>)}</select></Field>
      {!user && <Field label="Password" htmlFor="u-pw" hint="Leave empty to generate a temporary password you can pass on.">
        <input id="u-pw" className="inp" type="password" autoComplete="new-password" value={d.password} onChange={e => setD({ ...d, password: e.target.value })} /></Field>}
    </div>
  </Modal>;
}

function ResetModal({ user, onClose, onDone }: { user: AdminUser; onClose: () => void; onDone: (p: string | null) => void }) {
  const [pw, setPw] = useState("");
  const reset = useAdminMutation(() => api.post<{ temporary_password: string | null }>(`/admin/users/${user.id}/password`, { password: pw || null }), `Password reset for ${user.name}`);
  return <Modal title="Reset password" sub={<>Set a new password for {user.name}, or leave it empty to generate a temporary one. Their current password stops working.</>} onClose={onClose}
    footer={<><button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn pri" disabled={reset.isPending} onClick={() => reset.mutate(undefined, { onSuccess: r => { onDone(r.temporary_password); onClose(); } })}>Reset password</button></>}>
    <Field label="New password" htmlFor="r-pw"><input id="r-pw" className="inp" type="password" autoComplete="new-password" value={pw} onChange={e => setPw(e.target.value)} autoFocus /></Field>
  </Modal>;
}

function DeleteUserModal({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const del = useAdminMutation(() => api.del(`/admin/users/${user.id}`), `Deleted ${user.name}`);
  return <Modal title={`Delete ${user.name}?`} sub="The account is removed permanently. Their past actions stay in the audit log under their name." onClose={onClose}
    footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn danger" disabled={del.isPending} onClick={() => del.mutate(undefined, { onSuccess: onClose })}>Delete user</button></>}>
    <p className="small">{user.email} · {user.role}</p>
  </Modal>;
}

function SecretModal({ email, password, onClose }: { email: string; password: string; onClose: () => void }) {
  const toast = useToast();
  const copy = () => navigator.clipboard?.writeText(password).then(() => toast("Copied", "ok"), () => toast("Copy failed — select the text instead", "err"));
  return <Modal title="Temporary password" sub="Shown once. Share it with the user over a trusted channel." onClose={onClose}
    footer={<button className="btn pri" onClick={onClose}>Done</button>}>
    <div className="col gap12"><div className="small muted">{email}</div>
      <div className="row"><code className="chip" style={{ fontSize: 14, userSelect: "all", flex: 1 }}>{password}</code>
        <button className="btn icon" aria-label="Copy password" onClick={copy}><Copy /></button></div></div>
  </Modal>;
}

// ------------------------------------------------------------------ roles
function RolesTab() {
  const roles = useRoles();
  const [editing, setEditing] = useState<Role | "new" | null>(null);
  const [deleting, setDeleting] = useState<Role | null>(null);
  if (roles.isLoading) return <p className="muted">Loading…</p>;
  const { roles: list = [], permissions = [] } = roles.data ?? {};
  return <>
    <div className="toolbar mb12"><p className="small muted" style={{ maxWidth: "80ch", flex: "1 1 260px" }}>A role is a set of permissions. Built-in roles can have their permissions changed but keep their names; the Administrator role always holds every permission.</p>
      <button className="btn pri" style={{ marginLeft: "auto" }} onClick={() => setEditing("new")}><Plus />New role</button></div>
    <div className="panel" style={{ overflowX: "auto" }}>
      <table className="tbl"><thead><tr><th>Role</th>{permissions.map(p => { const [g, a] = p.id.split(".");
            return <th key={p.id} className="hm" title={p.label} style={{ textAlign: "center", fontSize: 10.5, lineHeight: 1.25, padding: "8px 4px" }}>{g}<br />{a}</th>; })}<th>Users</th><th style={{ textAlign: "right" }}>Actions</th></tr></thead>
        <tbody>{list.map(r => <tr key={r.id}>
          <td style={{ minWidth: 200 }}><div className="row" style={{ fontWeight: 600 }}>{r.locked && <Lock size={12} aria-label="Locked" />}{r.name}{r.builtin ? <span className="badge">built-in</span> : <span className="badge b-acc">custom</span>}</div>
            <div className="xs dim">{r.description || "—"}</div></td>
          {permissions.map(p => <td key={p.id} className="hm" style={{ textAlign: "center" }} aria-label={`${p.label}: ${r.permissions.includes(p.id) ? "yes" : "no"}`}>
            {r.permissions.includes(p.id) ? <span style={{ color: "var(--ok)" }}>●</span> : <span className="dim">·</span>}</td>)}
          <td>{r.user_count}</td>
          <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
            <button className="btn ghost sm icon" aria-label={`Edit ${r.name}`} title={r.locked ? "Locked" : "Edit"} disabled={r.locked} onClick={() => setEditing(r)}><Pencil /></button>
            <button className="btn ghost sm icon" aria-label={`Delete ${r.name}`} title={r.builtin ? "Built-in roles cannot be deleted" : r.user_count ? "Move its users first" : "Delete"}
              disabled={r.builtin || r.user_count > 0} onClick={() => setDeleting(r)}><Trash2 /></button></td>
        </tr>)}</tbody></table>
    </div>
    <p className="xs dim mt8">On small screens the permission columns are hidden; open a role to see them.</p>
    {editing && <RoleModal role={editing === "new" ? null : editing} permissions={permissions} onClose={() => setEditing(null)} />}
    {deleting && <DeleteRoleModal role={deleting} onClose={() => setDeleting(null)} />}
  </>;
}

const PERM_GROUPS: [string, string][] = [["case", "Cases"], ["doc", "Sources"], ["graph", "Graph"], ["env", "Environments"], ["sim", "Simulations"],
  ["report", "Reports"], ["chat", "Conversations"], ["admin", "Administration"]];

function RoleModal({ role, permissions, onClose }: { role: Role | null; permissions: Permission[]; onClose: () => void }) {
  const { user: me } = useAuth();
  const [d, setD] = useState({ name: role?.name ?? "", description: role?.description ?? "", permissions: role?.permissions ?? ["chat.use"] });
  const save = useAdminMutation(() => role ? api.patch<Role>(`/admin/roles/${role.id}`, role.builtin ? { description: d.description, permissions: d.permissions } : d)
    : api.post<Role>("/admin/roles", d), r => role ? `Saved ${r.name}` : `Created ${r.name}`);
  const flip = (p: string) => setD({ ...d, permissions: d.permissions.includes(p) ? d.permissions.filter(x => x !== p) : [...d.permissions, p] });
  const losingAdmin = !!role && role.name === me?.role && role.permissions.includes("admin.access") && !d.permissions.includes("admin.access");
  return <Modal title={role ? `Edit ${role.name}` : "New role"} onClose={onClose} wide
    footer={<><button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn pri" disabled={d.name.trim().length < 2 || save.isPending || losingAdmin} onClick={() => save.mutate(undefined, { onSuccess: onClose })}>{role ? "Save role" : "Create role"}</button></>}>
    <div className="col gap12">
      <div className="form-grid">
        <Field label="Name" htmlFor="ro-name" hint={role?.builtin ? "Built-in roles keep their name." : role ? "Users with this role move with the new name." : undefined}>
          <input id="ro-name" className="inp" value={d.name} disabled={role?.builtin} onChange={e => setD({ ...d, name: e.target.value })} autoFocus={!role} /></Field>
        <Field label="Description" htmlFor="ro-desc"><input id="ro-desc" className="inp" value={d.description} onChange={e => setD({ ...d, description: e.target.value })} /></Field>
      </div>
      <div className="field"><label>Permissions <span className="dim">· {d.permissions.length} of {permissions.length}</span></label>
        <div className="grid2" style={{ gap: 10 }}>{PERM_GROUPS.map(([g, label]) => {
          const ps = permissions.filter(p => p.id.startsWith(`${g}.`));
          return ps.length ? <fieldset key={g} className="panel panel-b" style={{ margin: 0 }}><legend className="xs dim" style={{ padding: "0 4px" }}>{label}</legend>
            <div className="col">{ps.map(p => <label key={p.id} className="chk"><input type="checkbox" checked={d.permissions.includes(p.id)} onChange={() => flip(p.id)} />
              <span>{p.label} <span className="xs dim mono">{p.id}</span></span></label>)}</div></fieldset> : null;
        })}</div></div>
      {losingAdmin && <div className="demo-flag"><AlertTriangle /><span>This is your own role. Removing administration access would lock you out of this page.</span></div>}
    </div>
  </Modal>;
}

function DeleteRoleModal({ role, onClose }: { role: Role; onClose: () => void }) {
  const del = useAdminMutation(() => api.del(`/admin/roles/${role.id}`), `Deleted ${role.name}`);
  return <Modal title={`Delete ${role.name}?`} sub="No users have this role. Deleting it cannot be undone." onClose={onClose}
    footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn danger" disabled={del.isPending} onClick={() => del.mutate(undefined, { onSuccess: onClose })}>Delete role</button></>}>
    <p className="small">{role.permissions.length} permissions</p>
  </Modal>;
}

// ------------------------------------------------------------------ settings
type Editable = Omit<WorkspaceSettings, "system">;

function SettingsTab() {
  const s = useQuery({ queryKey: ["admin-settings"], queryFn: () => api.get<WorkspaceSettings>("/admin/settings") });
  const [d, setD] = useState<Editable | null>(null);
  useEffect(() => { if (s.data) { const { system: _s, ...rest } = s.data; setD(rest); } }, [s.data]);
  const save = useAdminMutation((body: Partial<Editable>) => api.patch<WorkspaceSettings>("/admin/settings", body), "Settings saved");
  if (s.isLoading || !d || !s.data) return <p className="muted">Loading…</p>;
  const sys = s.data.system;
  const changed = (Object.keys(d) as (keyof Editable)[]).filter(k => d[k] !== s.data![k]);
  const num = (k: keyof Editable, min: number, max: number) => ({
    type: "number", min, max, value: d[k] as number, className: "inp",
    onChange: (e: ChangeEvent<HTMLInputElement>) => setD({ ...d, [k]: e.target.value === "" ? min : Math.max(min, Math.min(max, Number(e.target.value))) }),
  });
  return <div className="col" style={{ gap: 16, maxWidth: 880 }}>
    <section className="panel"><div className="panel-h"><h3>Workspace</h3></div><div className="panel-b form-grid">
      <Field label="Workspace name" htmlFor="s-name" hint="Shown in the top bar for everyone."><input id="s-name" className="inp" value={d.workspace_name} onChange={e => setD({ ...d, workspace_name: e.target.value })} /></Field>
      <Field label="Default case visibility" htmlFor="s-vis" hint="Used when a new case does not choose one. Private: only the owner and administrators.">
        <select id="s-vis" className="sel" value={d.default_case_visibility} onChange={e => setD({ ...d, default_case_visibility: e.target.value as Editable["default_case_visibility"] })}>
          {["Private", "Team", "Organization"].map(v => <option key={v}>{v}</option>)}</select></Field>
    </div></section>

    <section className="panel"><div className="panel-h"><h3>Security</h3></div><div className="panel-b form-grid">
      <Field label="Session length (hours)" htmlFor="s-sess" hint="How long a sign-in lasts, 1–72. Applies to new sign-ins."><input id="s-sess" {...num("session_hours", 1, 72)} /></Field>
      <Field label="Minimum password length" htmlFor="s-pwlen" hint="For passwords an administrator sets, 8–64."><input id="s-pwlen" {...num("password_min_length", 8, 64)} /></Field>
      {sys.jwt_secret_is_default && <div className="demo-flag" style={{ gridColumn: "1 / -1" }}><AlertTriangle /><span>The server's token secret is a placeholder or too short. Set a random <code>JWT_SECRET</code> of 32+ characters in <code>backend/.env</code> before sharing this instance.</span></div>}
    </div></section>

    <section className="panel"><div className="panel-h"><h3>New environment defaults</h3><span className="xs dim">Each environment can still change these.</span></div><div className="panel-b form-grid">
      <Field label="Simulation rounds" htmlFor="s-rounds" hint="1–200 rounds (one simulated hour each by default)."><input id="s-rounds" {...num("sim_rounds", 1, 200)} /></Field>
      <Field label="LLM-written personas" htmlFor="s-pers" hint="0–50. Each takes 15–40 s on a CPU."><input id="s-pers" {...num("sim_llm_personas", 0, 50)} /></Field>
      <Field label="LLM-written posts per round" htmlFor="s-posts" hint="0–20. The rest use stance-aware templates."><input id="s-posts" {...num("sim_llm_posts_per_round", 0, 20)} /></Field>
      <div className="field"><label>Real actors</label>
        <button type="button" className="tgl" style={{ alignSelf: "flex-start" }} aria-pressed={d.sim_real_actors_context_only}
          onClick={() => setD({ ...d, sim_real_actors_context_only: !d.sim_real_actors_context_only })}><span className="switch" />Context only</button>
        <span className="hint">When on, real people, parties and governments shape the scenario but never get posts written in their name.</span></div>
    </div></section>

    <section className="panel"><div className="panel-h"><h3>System</h3><span className="xs dim">Read only · set in <code>backend/.env</code></span></div><div className="panel-b">
      <ul className="svc-list" aria-label="Service health">{(Object.keys(SERVICE_LABEL) as ServiceName[]).map(k => {
        const v = sys.services[k];
        return <li key={k}><span className={`dstat ${v.ok ? "ok" : v.optional ? "run" : "err"}`}><i /></span>
          <div className="grow" style={{ minWidth: 0 }}><b className="small">{SERVICE_LABEL[k]}</b><div className="xs dim" style={{ overflowWrap: "anywhere" }}>{v.detail || (v.ok ? "OK" : "Not reachable")}</div></div>
          {v.ms != null && <span className="xs dim mono">{v.ms} ms</span>}</li>;
      })}</ul>
      <div className="row mb12"><span className="xs dim grow">Checked every 15 s.</span><button className="btn ghost sm" onClick={() => s.refetch()} disabled={s.isFetching}><RefreshCw />Check again</button></div>
      <dl className="kv kv-wide">
        <dt>Language model</dt><dd><span className={`dstat ${sys.llm.available ? "ok" : "err"}`}><i />{sys.llm.provider === "none" ? "Disabled" : `${sys.llm.model} · ${sys.llm.available ? "available" : "not reachable"}`}</span></dd>
        <dt>Ollama URL</dt><dd className="mono small">{sys.llm.url}</dd>
        <dt>Extraction</dt><dd>{sys.extractor}</dd>
        <dt>Embeddings</dt><dd>{sys.embedder}</dd>
        <dt>Upload limit</dt><dd>{sys.max_upload_mb} MB per file</dd>
        <dt>File storage</dt><dd>{sys.storage}</dd>
        <dt>Demo sign-in list</dt><dd>{sys.demo_accounts ? <span className="badge b-warn"><i />shown · set DEMO_ACCOUNTS=false for shared use</span> : "hidden"}</dd>
      </dl></div></section>

    <div className="row savebar">
      <span className="small muted grow">{changed.length ? `${changed.length} unsaved change${changed.length > 1 ? "s" : ""}` : "All changes saved"}</span>
      <button className="btn" disabled={!changed.length} onClick={() => { const { system: _s, ...rest } = s.data!; setD(rest); }}>Discard</button>
      <button className="btn pri" disabled={!changed.length || d.workspace_name.trim().length < 2 || save.isPending}
        onClick={() => save.mutate(Object.fromEntries(changed.map(k => [k, d[k]])) as Partial<Editable>)}>{save.isPending && <Spinner />}<Shield />Save settings</button>
    </div>
  </div>;
}

const SERVICE_LABEL: Record<ServiceName, string> = { database: "Database (PostgreSQL)", graph: "Graph database (Neo4j)", jobs: "Job queue", embeddings: "Embedding model (search)", llm: "Local language model (optional)" };

// ------------------------------------------------------------------ activity
const GROUP_LABEL: Record<string, string> = { auth: "Sign-ins", account: "Account", admin: "Administration", cases: "Cases", sources: "Sources",
  graph: "Graph", workflow: "Simulation & reports" };

function describe(e: AuditEntry): string {
  const verb: Record<string, string> = {
    "auth.login": "signed in", "account.update": "updated their profile", "account.password": "changed their password",
    "admin.user.create": "added user", "admin.user.update": "changed user", "admin.user.password": "reset the password of",
    "admin.user.delete": "deleted user", "admin.role.create": "created role", "admin.role.update": "changed role", "admin.role.delete": "deleted role",
    "admin.settings.update": "changed workspace settings", "case.create": "created case", "case.update": "edited case", "case.archive": "archived case",
    "case.restore": "restored case", "doc.upload": "uploaded", "doc.delete": "deleted source",
    "graph.build.start": "started a graph build for", "graph.review": "reviewed", "graph.approve": "approved graph", "graph.draft": "opened a draft of",
    "graph.export": "exported graph", "graphrag.query": "asked the graph:", "environment.create": "created environment",
    "environment.edit": "edited environment", "environment.personas": "imported personas into", "environment.approve": "approved environment",
    "environment.delete": "deleted environment", "simulation.start": "started simulation", "simulation.trigger": "triggered",
    "simulation.delete": "deleted simulation", "report.create": "generated", "report.edit": "edited", "report.approve": "approved",
  };
  const v = verb[e.action];
  if (!v) return `${e.action.replace(/[._]/g, " ")} · ${e.target}`;
  return ["auth.login", "account.update", "account.password", "admin.settings.update"].includes(e.action) ? v : `${v} ${e.target}`;
}

function ActivityTab() {
  const [group, setGroup] = useState("");
  const [actor, setActor] = useState("");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => { const t = setTimeout(() => setQuery(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const params = (before: string) => new URLSearchParams({ limit: "40", ...(group && { group }), ...(actor && { actor }), ...(query && { q: query }), ...(before && { before }) }).toString();
  const results = useInfiniteQuery({
    queryKey: ["admin-audit", group, actor, query],
    queryFn: ({ pageParam }) => api.get<AuditPage>(`/admin/audit?${params(pageParam)}`),
    initialPageParam: "",
    getNextPageParam: last => last.next ?? undefined,
  });
  const data = results.data?.pages ?? [];
  const items = data.flatMap(p => p.items);
  const actors = data[0]?.actors ?? [];
  return <>
    <div className="toolbar mb12">
      <select className="sel tb-sel" aria-label="Kind of activity" value={group} onChange={e => setGroup(e.target.value)}>
        <option value="">All activity</option>{Object.entries(GROUP_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
      <select className="sel tb-sel" aria-label="Person" value={actor} onChange={e => setActor(e.target.value)}>
        <option value="">Everyone</option>{actors.map(a => <option key={a}>{a}</option>)}</select>
      <input className="inp tb-search" placeholder="Search target, action or case" value={q} onChange={e => setQ(e.target.value)} aria-label="Search activity" />
    </div>
    <div className="panel">
      {results.isLoading ? <p className="panel-b muted">Loading…</p> : !items.length ? <Empty icon={<Activity />} title="No activity matches" text="Change the filters to see more." /> :
        <ul className="audit-list">{items.map(e => <li key={e.id}>
          <Avatar name={e.actor} size={26} />
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="small"><b>{e.actor}</b> {describe(e)}</div>
            <div className="xs dim">{e.case_title && <>{e.case_title} · </>}<span className="mono">{e.action}</span></div>
          </div>
          <time className="xs dim" dateTime={e.at} title={fmtDate(e.at)}>{ago(e.at)}</time>
        </li>)}</ul>}
    </div>
    {results.hasNextPage && <div className="row mt8" style={{ justifyContent: "center" }}>
      <button className="btn" disabled={results.isFetchingNextPage} onClick={() => results.fetchNextPage()}>{results.isFetchingNextPage && <Spinner />}Load older activity</button></div>}
  </>;
}
