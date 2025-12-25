#!/usr/bin/env bun
import { $ } from "bun";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { acquireLock, readState, releaseLock, writeState, type StateFile } from "./storage";

const CCENV_DIR = ".ccenv";
const ENVS_DIR = path.join(CCENV_DIR, "envs");
const STATE_FILE = path.join(CCENV_DIR, "state");
const LOCK_FILE = path.join(CCENV_DIR, "lock");
const CONFIG_FILE = path.join(CCENV_DIR, "config.json");
const DEFAULT_HOST_ENV = "default";

type EnvInfo = {
  headHash: string;
  branch: string;
  timestamp: number;
};

async function gitOutput(args: string[]): Promise<string> {
  return await $`git ${args}`.text();
}

async function gitText(args: string[]): Promise<string> {
  return (await gitOutput(args)).trim();
}

async function getRepoRoot(): Promise<string> {
  try {
    const root = (await $`git rev-parse --show-toplevel`.text()).trim();
    if (!root) throw new Error();
    return root;
  } catch {
    throw new Error("Not inside a Git repository.");
  }
}

async function ensureCcenvDirs(): Promise<void> {
  await fs.mkdir(ENVS_DIR, { recursive: true });
  try {
    await fs.access(CONFIG_FILE);
  } catch {
    await Bun.write(CONFIG_FILE, "{}\n");
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function fileNotEmpty(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.size > 0;
  } catch {
    return false;
  }
}

async function writeInfo(targetDir: string): Promise<void> {
  const headHash = (await gitText(["rev-parse", "HEAD"])).trim();
  const branch = (await gitText(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  const info: EnvInfo = { headHash, branch, timestamp: Date.now() };
  await Bun.write(path.join(targetDir, "info.json"), JSON.stringify(info, null, 2) + "\n");
}

async function dumpEnv(targetDir: string): Promise<void> {
  await fs.mkdir(targetDir, { recursive: true });

  const untrackedList = (await gitText(["ls-files", "--others", "--exclude-standard"])).trim();
  const tarPath = path.join(targetDir, "untracked.tar.gz");
  const untrackedFiltered = untrackedList
    .split("\n")
    .filter(Boolean)
    .filter((entry) => entry !== ".ccenv" && !entry.startsWith(".ccenv/"));
  if (untrackedFiltered.length > 0) {
    const listPath = path.join(targetDir, "untracked.list");
    await Bun.write(listPath, untrackedFiltered.join("\n") + "\n");
    await $`tar -czf ${tarPath} -T ${listPath}`;
    await fs.rm(listPath);
  } else if (await fileExists(tarPath)) {
    await fs.rm(tarPath);
  }

  const stagedPath = path.join(targetDir, "staged.patch");
  await $`git diff --cached --binary --output=${stagedPath}`;

  const unstagedPath = path.join(targetDir, "unstaged.patch");
  await $`git diff --binary --output=${unstagedPath}`;

  await writeInfo(targetDir);
}


async function cleanWorkspace(): Promise<void> {
  await $`git reset --hard HEAD`;
  await $`git clean -fd -e .ccenv/ -e .ccenv`;
}

async function restoreEnv(sourceDir: string, opts: { clean: boolean }): Promise<void> {
  if (opts.clean) {
    await cleanWorkspace();
  }

  const tarPath = path.join(sourceDir, "untracked.tar.gz");
  if (await fileExists(tarPath)) {
    await $`tar -xzf ${tarPath}`;
  }

  const stagedPatch = path.join(sourceDir, "staged.patch");
  if (await fileNotEmpty(stagedPatch)) {
    await $`git apply --cached ${stagedPatch}`;
    await $`git apply ${stagedPatch}`;
  }

  const unstagedPatch = path.join(sourceDir, "unstaged.patch");
  if (await fileNotEmpty(unstagedPatch)) {
    await $`git apply ${unstagedPatch}`;
  }
}

function resolveEnvName(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.CCENV_ACTIVE) return process.env.CCENV_ACTIVE;
  throw new Error("Environment name is required. Use --env <name> or ccenv activate.");
}

async function ensureEnvDir(name: string): Promise<string> {
  const envDir = path.join(ENVS_DIR, name);
  await fs.mkdir(envDir, { recursive: true });
  return envDir;
}

async function enterEnv(name: string): Promise<void> {
  await ensureCcenvDirs();
  const envDir = path.join(ENVS_DIR, name);
  if (!(await fileExists(envDir))) {
    throw new Error(`Environment not found: ${name}`);
  }
  const state = await readState(STATE_FILE);
  if (state) {
    throw new Error(`Already inside environment: ${state.activeEnv}`);
  }
  await acquireLock(LOCK_FILE);

  try {
    const hostDir = await ensureEnvDir(DEFAULT_HOST_ENV);
    await dumpEnv(hostDir);

    await cleanWorkspace();

    await restoreEnv(envDir, { clean: false });

    await writeState(STATE_FILE, { activeEnv: name, hostEnv: DEFAULT_HOST_ENV, timestamp: Date.now() });
  } catch (error) {
    await releaseLock(LOCK_FILE);
    throw error;
  }
}

async function exitEnv(): Promise<void> {
  const state = await readState(STATE_FILE);
  if (!state) {
    throw new Error("Not inside an environment.");
  }

  try {
    const envDir = await ensureEnvDir(state.activeEnv);
    await dumpEnv(envDir);

    await cleanWorkspace();

    const hostDir = path.join(ENVS_DIR, state.hostEnv);
    if (!(await fileExists(hostDir))) {
      throw new Error(`Host snapshot not found: ${state.hostEnv}`);
    }
    await restoreEnv(hostDir, { clean: false });
    await fs.rm(STATE_FILE);
  } finally {
    await releaseLock(LOCK_FILE);
  }
}

async function applyEnv(name: string): Promise<void> {
  await ensureCcenvDirs();
  const envDir = path.join(ENVS_DIR, name);
  if (!(await fileExists(envDir))) {
    throw new Error(`Environment not found: ${name}`);
  }
  await restoreEnv(envDir, { clean: false });
}

async function createEnv(name: string, opts: { empty: boolean }): Promise<void> {
  await ensureCcenvDirs();
  const envDir = path.join(ENVS_DIR, name);
  if (await fileExists(envDir)) {
    throw new Error(`Environment already exists: ${name}`);
  }
  await fs.mkdir(envDir, { recursive: true });
  if (opts.empty) {
    await Bun.write(path.join(envDir, "staged.patch"), "");
    await Bun.write(path.join(envDir, "unstaged.patch"), "");
    await writeInfo(envDir);
    return;
  }
  await Bun.write(path.join(envDir, "staged.patch"), "");
  await Bun.write(path.join(envDir, "unstaged.patch"), "");
  await writeInfo(envDir);
}

function printHelp(): void {
  const text = `
ccenv - Claude Code Environment Manager

Usage:
  ccenv create <name> [--empty]
  ccenv activate <name>
  ccenv run [--env <name>] <command...>
  ccenv enter [<name>]
  ccenv exit
  ccenv apply [<name>]
`;
  console.log(text.trim());
}

async function runCommand(envName: string, command: string[]): Promise<number> {
  const child = Bun.spawn({
    cmd: command,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, CCENV_ACTIVE: envName }
  });
  return await child.exited;
}

async function main(): Promise<void> {
  const repoRoot = await getRepoRoot();
  process.chdir(repoRoot);

  const [, , command, ...rest] = process.argv;
  if (!command || command === "-h" || command === "--help") {
    printHelp();
    return;
  }

  switch (command) {
    case "create": {
      const name = rest.find((arg) => !arg.startsWith("--"));
      if (!name) throw new Error("Missing environment name.");
      const empty = rest.includes("--empty");
      await createEnv(name, { empty });
      return;
    }
    case "activate": {
      const name = rest[0];
      if (!name) throw new Error("Missing environment name.");
      console.log(`export CCENV_ACTIVE=${name}`);
      return;
    }
    case "enter": {
      const name = resolveEnvName(rest[0]);
      await enterEnv(name);
      return;
    }
    case "exit": {
      await exitEnv();
      return;
    }
    case "apply": {
      const name = resolveEnvName(rest[0]);
      await applyEnv(name);
      return;
    }
    case "run": {
      let envName: string | undefined;
      let commandIndex = 0;
      if (rest[0] === "--env") {
        envName = rest[1];
        commandIndex = 2;
      }
      const commandArgs = rest.slice(commandIndex);
      if (!commandArgs.length) {
        throw new Error("Missing command to run.");
      }
      const resolvedEnv = resolveEnvName(envName);

      let entered = false;
      let signalHandled = false;
      const onSignal = async (signal: NodeJS.Signals, code: number) => {
        if (signalHandled) return;
        signalHandled = true;
        if (entered) {
          try {
            await exitEnv();
          } catch {
            // Ignore cleanup errors on signal.
          }
        }
        process.exit(code);
      };

      const sigint = () => void onSignal("SIGINT", 130);
      const sigterm = () => void onSignal("SIGTERM", 143);
      process.on("SIGINT", sigint);
      process.on("SIGTERM", sigterm);

      let exitCode = 1;
      try {
        await enterEnv(resolvedEnv);
        entered = true;
        exitCode = await runCommand(resolvedEnv, commandArgs);
      } finally {
        if (entered && !signalHandled) {
          await exitEnv();
        }
        process.off("SIGINT", sigint);
        process.off("SIGTERM", sigterm);
      }
      process.exit(exitCode);
    }
    default:
      printHelp();
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error) => {
  console.error(`ccenv: ${error.message ?? error}`);
  process.exit(1);
});
