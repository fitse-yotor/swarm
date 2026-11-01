import type { ClaimStatus, EntityType } from "./api";

export type Shape = "circle" | "square" | "diamond" | "triangle" | "hexagon" | "pentagon" | "ring" | "doc";

export const ETYPES: Record<EntityType, { label: string; shape: Shape; desc: string }> = {
  person: { label: "Person", shape: "circle", desc: "Named individuals: officials, experts, journalists, leaders." },
  organization: { label: "Organization", shape: "square", desc: "Agencies, ministries, companies, unions, NGOs and media outlets." },
  country: { label: "Country", shape: "diamond", desc: "Sovereign states and their national-level positions." },
  location: { label: "Location", shape: "triangle", desc: "Places, infrastructure, regions and geographic features." },
  event: { label: "Event", shape: "hexagon", desc: "Meetings, protests, incidents and dated occurrences." },
  policy: { label: "Policy", shape: "pentagon", desc: "Agreements, laws, protocols, tariffs and formal rules." },
  topic: { label: "Topic", shape: "ring", desc: "Themes and issues discussed across sources." },
  document: { label: "Document", shape: "doc", desc: "Source documents represented as nodes for provenance." },
};
export const TYPE_KEYS = Object.keys(ETYPES) as EntityType[];

export const STATUS: Record<ClaimStatus, { label: string; cls: string }> = {
  approved: { label: "Verified", cls: "b-ok" },
  pending: { label: "Pending review", cls: "b-warn" },
  rejected: { label: "Rejected", cls: "b-err" },
  conflict: { label: "Conflicting evidence", cls: "b-warn" },
  manual: { label: "Analyst-added", cls: "b-acc" },
};

export const STAGES = ["Graph build", "Environment", "Simulation", "Report", "Interaction"];
export const COMM_COL = ["#60A5FA", "#A78BFA", "#34D399", "#FBBF24", "#F472B6", "#22D3EE", "#FB7185", "#94A3B8", "#C084FC", "#4ADE80"];

export const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
export const typeColor = (t: string) => cssVar(`--${t}`) || "#94A3B8";

export const pct = (v: number) => `${Math.round(v * 100)}%`;
export const fmtBytes = (b: number) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : b > 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`);
export const fmtDate = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
export function ago(iso: string) {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}
export const initials = (n: string) => n.replace(/[^A-Za-z ]/g, "").split(" ").filter(Boolean).slice(0, 2).map(w => w[0]).join("").toUpperCase();
export function avatarBg(n: string) { let h = 0; for (const c of n) h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 45% 42%)`; }
