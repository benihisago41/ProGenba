import useSWR from "swr";
import { apiFetch } from "./auth";
import { API_ENDPOINTS, LookupsDto, ProjectCostCockpitDto } from "./bindings";

export async function readApi<T>(url: string): Promise<T> {
  const response = await apiFetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    let message = `データを取得できませんでした（HTTP ${response.status}）。`;
    try { const data = await response.json(); if (typeof data.message === "string") message = data.message; } catch { /* JSONでない通信エラーにも再試行を案内する */ }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export interface ProjectSelection { projectCode: string; branchCode: string }
export const ALL_BRANCHES = "__ALL__";
export const branchKey = (project: ProjectCostCockpitDto) => `${project.key.project_code}::${project.key.branch_code}`;
export const branchLabel = (branch: string, name: string) => branch === "000" ? "本工事" : `追加工事 ${branch} · ${name}`;

export function useProjectData(companyCode: string) {
  const query = `?company_code=${encodeURIComponent(companyCode)}`;
  const options = { revalidateOnFocus: false, shouldRetryOnError: false };
  const cockpit = useSWR<ProjectCostCockpitDto[]>(API_ENDPOINTS.COCKPIT + query, readApi, options);
  const lookups = useSWR<LookupsDto>(API_ENDPOINTS.MASTER_LOOKUPS + query, readApi, options);
  const refresh = async () => {
    const results = await Promise.allSettled([
      cockpit.mutate(readApi<ProjectCostCockpitDto[]>(API_ENDPOINTS.COCKPIT + query), { revalidate: false, throwOnError: true }),
      lookups.mutate(readApi<LookupsDto>(API_ENDPOINTS.MASTER_LOOKUPS + query), { revalidate: false, throwOnError: true }),
    ]);
    return results.every(result => result.status === "fulfilled");
  };
  return { cockpit, lookups, refresh };
}
