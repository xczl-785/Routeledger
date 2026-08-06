export type ActorType = "user" | "agent" | "system";

export interface Actor {
  id: string;
  type: ActorType;
  displayName?: string;
}
