export type RuntimeBuildProvenance = {
  sourceTreeState: "clean" | "dirty" | "unavailable";
  buildCommit: string | null;
};

export const SOURCE_TREE_STATES: readonly RuntimeBuildProvenance["sourceTreeState"][];

export const resolveRuntimeBuildProvenance: (options: {
  repositoryRoot: string;
  execFile?: (file: string, args: string[], options: unknown) => string;
}) => RuntimeBuildProvenance;
