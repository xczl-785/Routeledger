import {
  parseLauncherArgs,
  runMissionControlServer
} from "./launcher.js";

const main = async (): Promise<void> => {
  const args = parseLauncherArgs(process.argv.slice(2));
  await runMissionControlServer(args);
};

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
