import type { MissionControlResponse } from "./shared/mission-control.js";

export const fetchMissionControlState = async (): Promise<MissionControlResponse> => {
  const response = await fetch("/api/state", {
    cache: "no-store",
    headers: {
      accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`state request failed with ${response.status}`);
  }

  return (await response.json()) as MissionControlResponse;
};
