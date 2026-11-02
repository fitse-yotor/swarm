// Typed client for the M2 Swarm API (backend/app/schemas.py is the source of truth).

// The first eight are extracted from sources; reaction / agent / statement exist only in the reaction and simulation layers.
export type EntityType = "person" | "organization" | "country" | "location" | "event" | "policy" | "topic" | "document" | "reaction" | "agent" | "statement";
export type ClaimStatus = "pending" | "approved" | "rejected" | "conflict" | "manual" | "hypothesis" | "simulated" | "selected" | "excluded";

export interface User { id: string; name: string; email: string; role: string; status: string; permissions: string[] }

export interface Case {
  id: string; title: string; description: string; research_question: string; objective: string;
  scope_type: "person" | "organization" | "country" | null; tags: string[]; visibility: string; status: string;
  stage: number; extract_types: EntityType[]; current_version_id: string | null; revision: number; owner_name: string;
  created_at: string; updated_at: string; document_count: number; graph_label: string | null; graph_status: string | null;
}

export interface Doc {
  id: string; case_id: string; filename: string; kind: string; size: number; checksum: string; status: string;
  parser: string | null; page_count: number | null; error: string | null; warnings: string[]; uploaded_by: string;
  uploaded_at: string; extracted_at: string | null; chunk_count: number; claim_count: number;
}

export interface Chunk { id: string; ordinal: number; page: number; section: string; text: string; char_start: number; char_end: number }

export interface Job {
  id: string; case_id: string; kind: string; status: "queued" | "running" | "done" | "failed" | "cancelled";
  stage: number; progress: number; logs: { t: string; m: string; k: string }[]; per_doc: Record<string, number>;
  stats: Record<string, unknown>; error: string | null; created_by: string; created_at: string; finished_at: string | null;
  stages: string[];
}

export interface Version {
  id: string; number: number; label: string; status: "draft" | "approved"; note: string; parent_id: string | null;
  extractor: string; created_by: string; created_at: string; approved_by: string | null; approved_at: string | null;
  content_hash: string | null; node_count: number; edge_count: number;
}

export interface GNode {
  id: string; type: EntityType; name: string; aliases: string[]; description: string | null; status: ClaimStatus;
  confidence: number; doc_ids: string[]; evidence_ids: string[]; dup_of: string | null; not_dup: boolean;
  attrs: Record<string, string>; community: string | null; degree: number;
}

export interface GEdge {
  id: string; s: string; o: string; type: string; statement: string | null; confidence: number; status: ClaimStatus;
  flag: string | null; directed: boolean; epistemic_status: string | null; evidence_ids: string[];
  valid_from: string | null; valid_to: string | null;
}

export interface Community { id: string; name: string; size: number; hub: string }

export interface Graph {
  version: Version; versions: Version[]; nodes: GNode[]; edges: GEdge[]; communities: Community[];
  community_method: string; documents: Record<string, string>; editable: boolean;
}

export interface Evidence {
  id: string; document_id: string; document: string; chunk_id: string; page: number; section: string; quote: string;
  char_start: number; char_end: number; support_type: "supports" | "contradicts"; extractor: string; confidence: number;
}

export interface HistoryItem { id: string; object_kind: string; object_id: string; action: string; actor: string; at: string }
export interface AuditItem { id: string; case_id: string | null; actor: string; action: string; target: string; at: string }

export interface Diff {
  added_nodes: { name: string; type: EntityType }[]; removed_nodes: { name: string; type: EntityType }[];
  changed_nodes: { name: string; type: EntityType; status: string }[];
  added_edges: { s: string; type: string; o: string }[]; removed_edges: { s: string; type: string; o: string }[];
}

export interface RagAnswer {
  question: string; version: string; answer: string; support: "supported" | "partial" | "unsupported"; caveats: string;
  model: string | null; label: string; cited_sources: string[]; cited_relationships: string[];
  chunks: { chunk_id: string; document_id: string; document: string; page: number; section: string; text: string; score: number }[];
  relationships: { edge_id: string; s: string; o: string; subject: string; type: string; object: string; status: string; confidence: number }[];
}

export interface ServiceCheck { ok: boolean; detail?: string; ms?: number; optional?: boolean }
export type ServiceName = "database" | "graph" | "jobs" | "llm";
export interface SystemStatus {
  llm: { provider: string; model: string; available: boolean; url: string }; extractor: string; embedder: string;
  services?: Record<ServiceName, ServiceCheck>;
}

export interface Behavior { preset: string; mix: Record<string, number>; responsiveness: number; reply_style: string }
export interface BehaviorPreset { id: string; label: string; desc: string; mix: Record<string, number>; responsiveness: number; reply_style: string }
export interface BehaviorCatalogue { presets: BehaviorPreset[]; actions: string[]; reply_styles: string[] }

export interface Agent {
  id: string; node_id: string; name: string; handle: string; kind: "individual" | "institution" | "state"; entity_type: EntityType;
  profession: string; interests: string[]; bio: string; persona: string; facts: string[]; stance: number;
  stance_source: "graph" | "allies" | "model" | "none"; influence: number; activity: number; tone: string; followers: number;
  platforms: string[]; generated_by: string; x: number; y: number;
  synthetic?: boolean; speaks?: boolean; country?: string; viewpoint?: string; persona_id?: string; behavior?: Behavior;
}
export interface AgentLink { id: string; s: string; o: string; kind: "ally" | "opponent" | "contact" | "shared"; relation: string; weight: number }
export interface EnvConfig {
  platforms: string[]; rounds: number; minutes_per_round: number; seed: number; llm_personas: number; llm_posts_per_round: number;
  inject_round: number; epsilon: number; mu: number; backfire: number; focus_node_id?: string | null; focus_name?: string;
  real_actors_context_only?: boolean; scenario_shock?: number;
}
export interface Environment {
  id: string; case_id: string; version_id: string; version_label: string; version_status: string | null; name: string; scenario: string;
  status: "preparing" | "ready" | "approved" | "failed"; config: EnvConfig; revision: number; created_by: string; created_at: string;
  updated_at: string; job_id: string | null; agent_count: number; link_count: number; simulation_count: number;
  agents?: Agent[]; links?: AgentLink[]; seed_posts?: { round: number; content: string; source: string }[]; job?: Job | null;
}
export interface RoundMetric {
  round: number; hour: number; active: number; actions: Record<string, number>; platforms: Record<string, number>;
  mean_stance: number; polarization: number; support: number; oppose: number;
}
export interface SimStats {
  engine: string; agents: number; rounds: number; events: number; llm_posts: number; llm_model: string | null;
  totals: Record<string, number>; platform_totals: Record<string, number>; stance_start: number; stance_end: number;
  polarization_start: number; polarization_end: number; series: Record<string, number[]>; focus: string;
  coalitions: Record<"support" | "neutral" | "oppose", { id: string; name: string; stance: number }[]>;
  movers: { id: string; name: string; from: number; to: number }[]; most_engaged: { id: string; name: string; received: number }[];
  top_posts: { id: string; agent: string; platform: string; round: number; content: string; engagement: number; stance: number; generated_by: string }[];
}
export interface Simulation {
  id: string; case_id: string; environment_id: string; environment_name: string; name: string; engine: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled"; created_by: string; created_at: string; finished_at: string | null;
  job_id: string | null; rounds_total: number; rounds_done: number; platforms: string[]; agent_count: number; report_count: number;
  rounds?: RoundMetric[]; stats?: SimStats; agents?: Agent[]; links?: AgentLink[]; config?: EnvConfig; job?: Job | null; scenario?: string;
}
export interface SimEvent {
  id: string; round: number; platform: string; agent_id: string; agent_name: string; action: string; content: string;
  target_id: string | null; stance: number; likes: number; replies: number; reposts: number; generated_by: string;
}
export interface ReportSection { id: string; title: string; kind: "computed" | "generated" | "evidence" | "edited"; body: string; sources?: RagAnswer["chunks"] }
export interface Report {
  id: string; case_id: string; simulation_id: string; simulation_name: string; title: string; status: "generating" | "draft" | "approved" | "failed";
  model: string; created_by: string; created_at: string; approved_by: string | null; approved_at: string | null; job_id: string | null;
  sections?: ReportSection[]; facts?: Record<string, unknown>; job?: Job | null;
}
export interface ChatMessage { role: "user" | "assistant"; content: string; at: string; model?: string }
export interface Conversation {
  id: string; case_id: string; simulation_id: string | null; target: string; title: string; created_by: string; created_at: string;
  updated_at: string; message_count: number; messages?: ChatMessage[];
}

export interface ReactionGraph {
  scope: "agents" | "post" | "agent" | "run" | "thread"; events: number; roots?: string[]; focus?: string[];
  nodes: { id: string; name: string; type: "persona" | "actor" | "post" | "comment" | "repost"; stance?: number; synthetic?: boolean; round?: number;
    platform?: string; likes?: number; reposts?: number; replies?: number; text?: string; author?: string; root?: boolean; generated_by?: string;
    layer?: "base" | "interaction"; profile?: string; actions?: Record<string, number>; speaks?: boolean; lean?: "support" | "neutral" | "oppose" }[];
  links: { source: string; target: string; type: string; count?: number; kind?: string; layer?: "base" | "interaction" }[];
}
export interface TriggerResponse {
  agent_id: string; agent_name: string; profile: string; role: "author" | "bystander";
  decision: "replied" | "liked" | "reposted" | "disliked" | "ignored"; reason: string; event_id: string | null;
}
export interface TriggerResult { events: SimEvent[]; target: { id: string; likes: number; reposts: number; replies: number } | null; responses?: TriggerResponse[] }

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const TOKEN_KEY = "m2swarm.token";
export const token = {
  get: () => { try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set: (t: string | null) => { try { t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY); } catch { /* storage blocked */ } },
};

let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn; };

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const t = token.get();
  if (t) headers.Authorization = `Bearer ${t}`;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await fetch(`/api/v1${path}`, { method, headers, body: payload });
  if (res.status === 401 && !path.startsWith("/auth/login")) onUnauthorized();
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = await res.json();
      msg = typeof j.detail === "string" ? j.detail : Array.isArray(j.detail) ? j.detail.map((d: { msg: string }) => d.msg).join("; ") : msg;
    } catch { /* not JSON */ }
    throw new ApiError(res.status, msg);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export async function download(path: string, filename: string) {
  const res = await fetch(`/api/v1${path}`, { headers: { Authorization: `Bearer ${token.get()}` } });
  if (!res.ok) throw new ApiError(res.status, "Export failed");
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** POST and stream a plain-text response, calling onText with the accumulated text. */
export async function streamText(path: string, body: unknown, onText: (text: string) => void): Promise<string> {
  const res = await fetch(`/api/v1${path}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token.get()}` }, body: JSON.stringify(body) });
  if (res.status === 401) onUnauthorized();
  if (!res.ok || !res.body) {
    let msg = res.statusText;
    try { msg = (await res.json()).detail ?? msg; } catch { /* not JSON */ }
    throw new ApiError(res.status, msg);
  }
  const reader = res.body.getReader(), dec = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
    onText(text);
  }
  return text;
}

export const api = {
  get: <T,>(p: string) => request<T>("GET", p),
  post: <T,>(p: string, b?: unknown) => request<T>("POST", p, b ?? {}),
  patch: <T,>(p: string, b: unknown) => request<T>("PATCH", p, b),
  del: (p: string) => request<void>("DELETE", p),
  upload: <T,>(p: string, files: File[]) => { const f = new FormData(); files.forEach(x => f.append("files", x)); return request<T>("POST", p, f); },
};

// ----- Administration
export interface AdminUser extends User { created_at: string; case_count: number; last_login_at: string | null }
export interface Role {
  id: string; name: string; description: string; builtin: boolean; locked: boolean; permissions: string[];
  user_count: number; updated_at: string;
}
export interface Permission { id: string; label: string }
export interface WorkspaceSettings {
  workspace_name: string; default_case_visibility: "Private" | "Team" | "Organization"; session_hours: number;
  password_min_length: number; sim_rounds: number; sim_llm_personas: number; sim_llm_posts_per_round: number;
  sim_real_actors_context_only: boolean;
  system: { llm: SystemStatus["llm"]; extractor: string; embedder: string; max_upload_mb: number; storage: string; jwt_secret_is_default: boolean;
    demo_accounts: boolean; services: Record<ServiceName, ServiceCheck> };
}
export interface Workspace { name: string; default_case_visibility: WorkspaceSettings["default_case_visibility"] }
export interface AuditEntry { id: string; at: string; actor: string; action: string; target: string; case_id: string | null; case_title: string | null; meta: Record<string, unknown> }
export interface AuditPage { items: AuditEntry[]; next: string | null; actors: string[]; groups: string[] }
export interface DemoAccount { name: string; email: string; role: string }
export interface AccountActivity { workspace: string; created_at: string; session_hours: number; events: { id: string; action: string; actor: string; at: string }[] }

// ----- Reactions (generated hypotheses), the layered dynamic graph, snapshots and the timeline
export type Layer = "research" | "reaction" | "simulation";
export type ReactionCategory = "support" | "opposition" | "concern" | "neutrality" | "negotiation" | "public_communication" | "policy_response" | "operational_response";
export type ReactionStatus = "generated" | "reviewed" | "selected" | "excluded";
export interface ReactionRun {
  id: string; case_id: string; version_id: string; number: number; status: "generating" | "ready" | "failed"; mode: "llm" | "demo-rules"; provider: string;
  template_version: string; stats: { actors?: number; reactions?: number; rejected?: number; failed_actors?: number; issue?: string; actor_selection?: { id: string; name: string; score: number; why: string }[] };
  note: string; created_by: string; created_at: string; job_id: string | null; job: { id: string; status: string; stage: number; progress: number; error: string | null } | null;
  demo: boolean; label: string;
}
export interface Reaction {
  id: string; case_id: string; run_id: string; actor_id: string; actor_name: string; actor_type: string; title: string; description: string; category: ReactionCategory;
  trigger: string; related: { id: string; name: string; relation: string }[]; evidence_ids: string[]; reasoning: string; confidence: number; uncertainty: "low" | "medium" | "high";
  assumptions: { text: string; basis: "evidence_supported" | "model_inferred" | "synthetic" }[]; warnings: string[]; provenance: string; label: string; status: ReactionStatus;
  edited: boolean; environment_id: string | null; generator: { mode: string; provider: string; template_version: string }; created_at: string; updated_at: string;
}
export interface ReactionPage { items: Reaction[]; total: number; limit: number; offset: number; run: ReactionRun | null }
export interface ReactionDetail { reaction: Reaction; evidence: Evidence[]; run: ReactionRun | null; actor: { id: string; name: string; type: string };
  basis: Record<"evidence_supported" | "model_inferred" | "synthetic", { text: string; basis: string }[]> }

export interface DynNode {
  id: string; label: string; layer: Layer; type: EntityType; status: string; provenance: "sourced" | "generated_hypothesis" | "simulation_generated"; confidence?: number;
  description?: string; evidence_ids?: string[]; stance?: number; stance0?: number; category?: string; actor_id?: string; synthetic?: boolean; speaks?: boolean; edited?: boolean; step?: number; kind?: string;
}
export interface DynEdge {
  id: string; s: string; o: string; type: string; layer: Layer; status: string; provenance: DynNode["provenance"]; confidence?: number; directed: boolean; description?: string;
  evidence_ids?: string[]; strength?: number; polarity?: string;
}
export interface Snapshot {
  id: string; case_id: string; parent_id: string | null; number: number; reason: string; note: string; version_id: string | null; simulation_id: string | null; step: number | null;
  event_seq: number | null; reaction_run_id: string | null; graph_version: number; created_by: string; created_at: string; content_hash: string; integrity: "verified" | "mismatch";
  counts: Record<Layer, { nodes: number; edges: number }>;
}
export interface DynGraph {
  nodes: DynNode[]; edges: DynEdge[]; counts: Record<Layer, { nodes: number; edges: number }>; layers: Layer[]; labels: Record<Layer, string>;
  meta: { research: { version_id: string | null; version_label: string | null; content_hash: string | null; unavailable: boolean }; reactions: { run_id: string | null; run_number: number | null; mode: string | null };
    simulation: { run_id: string; run_name: string; attempt: number; step: number; seq: number; graph_version: number } | null };
  view: { mode: "live" | "snapshot"; snapshot: Snapshot | null };
}
export interface GraphEvent {
  id: string; case_id: string; run_id: string; attempt: number; seq: number; step: number; ts: string; event_type: string; actor_ids: string[]; description: string;
  nodes: string[]; edges: string[]; before: Record<string, unknown>; after: Record<string, unknown>; trigger_event_id: string | null; provenance: string; graph_version: number;
}
export type TimelineItem = { kind: "snapshot"; ts: string; step: number | null; snapshot: Snapshot } | { kind: "event"; ts: string; step: number; event: GraphEvent };
export interface Timeline {
  items: TimelineItem[]; total: number; steps: { step: number; events: number; types: Record<string, number>; snapshot_ids: string[] }[];
  simulation: { id: string; name: string; attempt: number } | null; event_types: string[]; agents: { id: string; name: string }[];
}
export interface DiffSide { added: { id: string; label: string; type: string; layer: Layer }[]; removed: { id: string; label: string; type: string; layer: Layer }[];
  changed: { id: string; label: string; type: string; layer: Layer; fields: Record<string, [unknown, unknown]> }[] }
export interface SnapshotDiff {
  a: { id: string; label: string }; b: { id: string; label: string }; layers: Record<Layer, { nodes: DiffSide; edges: DiffSide }>;
  summary: Record<Layer, { added: number; removed: number; changed: number }>; comparable: { research: boolean };
}
export interface EntityContext { reactions: Reaction[]; events: GraphEvent[] }
