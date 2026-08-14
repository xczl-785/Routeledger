import {
  getMissionControlStatus,
  openMissionControlSource,
  parseLauncherArgs,
  registerMissionControlProject,
  runMissionControlServer,
  stopMissionControlHub
} from "./launcher.js";

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  const command = argv[0]?.startsWith("--") || argv.length === 0 ? "serve" : argv[0];
  const commandArgs = command === "serve" && argv[0] !== "serve" ? argv : argv.slice(1);

  if (command === "status") {
    process.stdout.write(`${JSON.stringify(await getMissionControlStatus(), null, 2)}\n`);
    return;
  }

  if (command === "stop") {
    process.stdout.write(`${JSON.stringify(await stopMissionControlHub(), null, 2)}\n`);
    return;
  }

  const args = parseLauncherArgs(commandArgs);
  if (command === "open") {
    process.stdout.write(`${JSON.stringify(await openMissionControlSource(args), null, 2)}\n`);
    return;
  }

  if (command === "add") {
    process.stdout.write(`${JSON.stringify(await registerMissionControlProject(args), null, 2)}\n`);
    return;
  }

  if (command !== "serve") throw new Error(`Unknown RouteLedger UI command: ${command}`);
  await runMissionControlServer(args);
};

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
