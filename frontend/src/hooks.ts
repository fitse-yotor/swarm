import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type Case, type Conversation, type Environment, type Job, type Report, type Simulation, type SystemStatus, type Workspace } from "./api";

const live = (j?: Job | null) => !!j && (j.status === "queued" || j.status === "running");

export const useSystem = () =>
  useQuery({ queryKey: ["system"], queryFn: () => api.get<SystemStatus>("/system/status"), refetchInterval: 30_000, staleTime: 20_000 });

export const useCases = () => useQuery({ queryKey: ["cases"], queryFn: () => api.get<Case[]>("/cases") });

export const useCaseJobs = (caseId: string | null) =>
  useQuery({
    queryKey: ["jobs", caseId], enabled: !!caseId, queryFn: () => api.get<Job[]>(`/cases/${caseId}/jobs`),
    refetchInterval: q => ((q.state.data ?? []).some(live) ? 1500 : 10_000),
  });

export const useJob = (jobId: string | null | undefined) =>
  useQuery({
    queryKey: ["job", jobId], enabled: !!jobId, queryFn: () => api.get<Job>(`/jobs/${jobId}`),
    refetchInterval: q => (q.state.data && !live(q.state.data) ? false : 1200),
  });

export const useEnvs = (caseId: string | null) =>
  useQuery({ queryKey: ["envs", caseId], enabled: !!caseId, queryFn: () => api.get<Environment[]>(`/cases/${caseId}/environments`),
    refetchInterval: q => ((q.state.data ?? []).some(e => e.status === "preparing") ? 2000 : false) });
export const useSims = (caseId: string | null) =>
  useQuery({ queryKey: ["sims", caseId], enabled: !!caseId, queryFn: () => api.get<Simulation[]>(`/cases/${caseId}/simulations`),
    refetchInterval: q => ((q.state.data ?? []).some(s => s.status === "running" || s.status === "queued") ? 2000 : false) });
export const useReports = (caseId: string | null) =>
  useQuery({ queryKey: ["reports", caseId], enabled: !!caseId, queryFn: () => api.get<Report[]>(`/cases/${caseId}/reports`),
    refetchInterval: q => ((q.state.data ?? []).some(r => r.status === "generating") ? 2000 : false) });
export const useConvs = (caseId: string | null) =>
  useQuery({ queryKey: ["convs", caseId], enabled: !!caseId, queryFn: () => api.get<Conversation[]>(`/cases/${caseId}/conversations`) });

export const isLive = live;

/** Current color theme; re-renders when the shell toggles <html data-theme>. Canvas/WebGL views read colors from it. */
export function useTheme(): string {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? "dark");
  useEffect(() => {
    const mo = new MutationObserver(() => setTheme(document.documentElement.dataset.theme ?? "dark"));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);
  return theme;
}

/** Workspace name and defaults (cached; the shell loads it on every page). */
export const useWorkspace = () =>
  useQuery({ queryKey: ["workspace"], queryFn: () => api.get<Workspace>("/workspace"), staleTime: 60_000 });
