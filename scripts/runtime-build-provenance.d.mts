export type RuntimeBuildProvenance = {
  sourceTreeState: "clean" | "dirty" | "unavailable";
  buildCommit: string | null;
};

export const SOURCE_TREE_STATES: readonly RuntimeBuildProvenance["sourceTreeState"][];
export const PROVENANCE_GENERATED_PATHS: readonly string[];

export const readRecordedPluginBuildProvenance: (options: { repositoryRoot: string }) => RuntimeBuildProvenance | null;
export const isResolvableCommit: (options: {
  repositoryRoot: string;
  commit: string | null | undefined;
  execFile?: (file: string, args: string[], options: unknown) => string;
}) => boolean;
export const isReusableCleanBuildCommit: (options: {
  repositoryRoot: string;
  buildCommit: string | null | undefined;
  headCommit?: string;
  execFile?: (file: string, args: string[], options: unknown) => string;
}) => boolean;

export const resolveRuntimeBuildProvenance: (options: {
  repositoryRoot: string;
  execFile?: (file: string, args: string[], options: unknown) => string;
  recordedProvenance?: RuntimeBuildProvenance | null;
}) => RuntimeBuildProvenance;
