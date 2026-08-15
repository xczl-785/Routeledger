import type {
  MissionControlProjectsResponse,
  MissionControlResponse
} from "./shared/mission-control.js";

const missionControlToken = (): string => new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "";

const apiHeaders = (headers: Record<string, string> = {}): Record<string, string> => ({
  ...headers,
  "x-routeledger-ui-token": missionControlToken()
});

export const fetchMissionControlState = async (projectId?: string | null): Promise<MissionControlResponse> => {
  const query = projectId === undefined || projectId === null ? "" : `?project=${encodeURIComponent(projectId)}`;
  const response = await fetch(`/api/state${query}`, {
    cache: "no-store",
    headers: apiHeaders({
      accept: "application/json"
    })
  });

  if (!response.ok) {
    throw new Error(`state request failed with ${response.status}`);
  }

  return (await response.json()) as MissionControlResponse;
};

export const fetchMissionControlProjects = async (): Promise<MissionControlProjectsResponse> => {
  const response = await fetch("/api/projects", {
    cache: "no-store",
    headers: apiHeaders({ accept: "application/json" })
  });
  if (!response.ok) throw new Error(`projects request failed with ${response.status}`);
  return (await response.json()) as MissionControlProjectsResponse;
};

export const heartbeatMissionControl = async (): Promise<void> => {
  await fetch("/api/heartbeat", { method: "POST", cache: "no-store", keepalive: true, headers: apiHeaders() });
};

export const registerMissionControlProject = async (projectRoot: string): Promise<{ project: { id: string } }> => {
  const response = await fetch("/api/projects", {
    method: "POST",
    headers: apiHeaders({
      "content-type": "application/json",
      "x-routeledger-ui-client": "1"
    }),
    body: JSON.stringify({ path: projectRoot })
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error ?? `project registration failed with ${response.status}`);
  }
  return (await response.json()) as { project: { id: string } };
};

export const removeMissionControlProject = async (projectKey: string): Promise<void> => {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectKey)}`, {
    method: "DELETE",
    headers: apiHeaders({ "x-routeledger-ui-client": "1" })
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error ?? `project removal failed with ${response.status}`);
  }
};

export const stopMissionControl = async (): Promise<void> => {
  const response = await fetch("/api/shutdown", {
    method: "POST",
    headers: apiHeaders({ "x-routeledger-ui-client": "1" })
  });
  if (!response.ok) throw new Error(`shutdown request failed with ${response.status}`);
};
