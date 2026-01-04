#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";
import { acquireLock, readState, releaseLock, writeState } from "./storage";

const CCENV_DIR = ".ccenv";
const ENVS_DIR = path.join(CCENV_DIR, "envs");
const STATE_FILE = path.join(CCENV_DIR, "state");
const LOCK_FILE = path.join(CCENV_DIR, "lock");
const CONFIG_FILE = path.join(CCENV_DIR, "config.json");
const DEFAULT_HOST_ENV = "default";
const INTERNAL_LOG_FILE = path.join(CCENV_DIR, "internal.log");

async function logInternal(msg: string) {
	try {
		const time = new Date().toISOString();
		await fs.appendFile(
			INTERNAL_LOG_FILE,
			`[${time}] [pid:${process.pid}] [ppid:${process.ppid}] ${msg}\n`,
		);
	} catch {}
}

type EnvInfo = {
	headHash: string;
	branch: string;
	timestamp: number;
};

async function gitOutput(args: string[]): Promise<string> {
	return await $`git ${args}`.quiet().text();
}

async function gitText(args: string[]): Promise<string> {
	return (await gitOutput(args)).trim();
}

async function getRepoRoot(): Promise<string> {
	try {
		const root = (await $`git rev-parse --show-toplevel`.quiet().text()).trim();
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
	await Bun.write(
		path.join(targetDir, "info.json"),
		`${JSON.stringify(info, null, 2)}\n`,
	);
}

async function dumpEnv(targetDir: string): Promise<void> {
	await fs.mkdir(targetDir, { recursive: true });

	const untrackedList = (
		await gitText(["ls-files", "--others", "--exclude-standard"])
	).trim();
	const tarPath = path.join(targetDir, "untracked.tar.gz");
	const untrackedFiltered = untrackedList
		.split("\n")
		.filter(Boolean)
		.filter((entry) => entry !== ".ccenv" && !entry.startsWith(".ccenv/"));
	if (untrackedFiltered.length > 0) {
		const listPath = path.join(targetDir, "untracked.list");
		await Bun.write(listPath, `${untrackedFiltered.join("\n")}\n`);
		await $`tar -czf ${tarPath} -T ${listPath}`.quiet();
		await fs.rm(listPath);
	} else if (await fileExists(tarPath)) {
		await fs.rm(tarPath);
	}

	const stagedPath = path.join(targetDir, "staged.patch");
	await $`git diff --cached --binary --output=${stagedPath}`.quiet();

	const unstagedPath = path.join(targetDir, "unstaged.patch");
	await $`git diff --binary --output=${unstagedPath}`.quiet();

	await writeInfo(targetDir);
}

async function cleanWorkspace(): Promise<void> {
	await $`git reset --hard HEAD`.quiet();
	await $`git clean -fd -e .ccenv/ -e .ccenv`.quiet();
}

async function restoreEnv(
	sourceDir: string,
	opts: { clean: boolean },
): Promise<void> {
	if (opts.clean) {
		await cleanWorkspace();
	}

	const infoPath = path.join(sourceDir, "info.json");
	if (await fileExists(infoPath)) {
		try {
			const info = (await Bun.file(infoPath).json()) as EnvInfo;
			if (info.branch && info.branch !== "HEAD") {
				try {
					await $`git checkout ${info.branch}`.quiet();
				} catch {
					if (info.headHash) {
						await $`git checkout ${info.headHash}`.quiet();
					}
				}
			} else if (info.headHash) {
				await $`git checkout ${info.headHash}`.quiet();
			}
		} catch (error) {
			await logInternal(
				`restoreEnv warning: failed to restore git state: ${error}`,
			);
		}
	}

	const tarPath = path.join(sourceDir, "untracked.tar.gz");
	if (await fileExists(tarPath)) {
		await $`tar -xzf ${tarPath}`.quiet();
	}

	const stagedPatch = path.join(sourceDir, "staged.patch");
	if (await fileNotEmpty(stagedPatch)) {
		await $`git apply --cached ${stagedPatch}`.quiet();
		await $`git apply ${stagedPatch}`.quiet();
	}

	const unstagedPatch = path.join(sourceDir, "unstaged.patch");
	if (await fileNotEmpty(unstagedPatch)) {
		await $`git apply ${unstagedPatch}`.quiet();
	}
}

function resolveEnvName(explicit?: string): string {
	if (explicit) return explicit;
	if (process.env.CCENV_ACTIVE) return process.env.CCENV_ACTIVE;
	throw new Error(
		"Environment name is required. Use --env <name> or ccenv activate.",
	);
}

async function ensureEnvDir(name: string): Promise<string> {
	const envDir = path.join(ENVS_DIR, name);
	await fs.mkdir(envDir, { recursive: true });
	return envDir;
}

async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function enterEnv(name: string): Promise<boolean> {
	await logInternal(`enterEnv(${name}) start`);
	await ensureCcenvDirs();
	const envDir = path.join(ENVS_DIR, name);
	if (!(await fileExists(envDir))) {
		throw new Error(`Environment not found: ${name}`);
	}

	const start = Date.now();
	const timeoutMs = 300000; // 5 minutes wait for other tools

	while (true) {
		if (Date.now() - start > timeoutMs) {
			throw new Error(`Timeout waiting for environment to be free`);
		}

		await acquireLock(LOCK_FILE);

		try {
			const state = await readState(STATE_FILE);
			if (state) {
				if (state.activeEnv === name) {
					await logInternal(`enterEnv(${name}) already active, skipping`);
					return false;
				}
				// Environment is busy. Release lock and wait.
				// However, if WE (this session) are the one who entered manually, we deadlock.
				// But since hooks run in subshells, they are distinct "owners".
				await releaseLock(LOCK_FILE);
				await logInternal(
					`enterEnv(${name}) busy (active: ${state.activeEnv}), waiting...`,
				);
				await sleep(1000);
				continue;
			}

			// No state, free to enter
			const hostDir = await ensureEnvDir(DEFAULT_HOST_ENV);
			await logInternal(`enterEnv(${name}) dumping host`);
			await dumpEnv(hostDir);

			await logInternal(`enterEnv(${name}) cleaning workspace`);
			await cleanWorkspace();

			await logInternal(`enterEnv(${name}) restoring env`);
			await restoreEnv(envDir, { clean: false });

			await writeState(STATE_FILE, {
				activeEnv: name,
				hostEnv: DEFAULT_HOST_ENV,
				timestamp: Date.now(),
			});
			await logInternal(`enterEnv(${name}) swapped and state written`);
			return true; // Success, lock released in finally
		} catch (error) {
			await logInternal(`enterEnv(${name}) error: ${error}`);
			throw error;
		} finally {
			await releaseLock(LOCK_FILE);
		}
	}
}

async function exitEnv(
	opts: { force: boolean } = { force: false },
): Promise<void> {
	await logInternal(`exitEnv() requesting lock`);
	await acquireLock(LOCK_FILE); // Ensure we hold the lock to modify state
	try {
		const state = await readState(STATE_FILE);
		if (!state) {
			// If already exited (e.g. by another tool if we allow race?), or redundant call.
			// We treat it as success to be safe.
			await logInternal("exitEnv() no state found, already exited?");
			return;
		}

		if (!opts.force) {
			const currentEnv = process.env.CCENV_ACTIVE;
			if (currentEnv !== state.activeEnv) {
				throw new Error(
					`Cannot exit environment '${state.activeEnv}' because you are currently in '${currentEnv || "(none)"}'. Use --force to ignore.`,
				);
			}
		}

		const envDir = await ensureEnvDir(state.activeEnv);
		await logInternal(`exitEnv() dumping env`);
		await dumpEnv(envDir);

		await logInternal(`exitEnv() cleaning workspace`);
		await cleanWorkspace();

		const hostDir = path.join(ENVS_DIR, state.hostEnv);
		if (!(await fileExists(hostDir))) {
			throw new Error(`Host snapshot not found: ${state.hostEnv}`);
		}
		await logInternal(`exitEnv() restoring host`);
		await restoreEnv(hostDir, { clean: false });
		await fs.rm(STATE_FILE);
		await logInternal(`exitEnv() state removed`);
	} catch (error) {
		await logInternal(`exitEnv() error: ${error}`);
		throw error;
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

async function createEnv(
	name: string,
	opts: { empty: boolean },
): Promise<void> {
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

async function listEnvs(): Promise<void> {
	await ensureCcenvDirs();
	const entries = await fs.readdir(ENVS_DIR);
	const state = await readState(STATE_FILE);
	const activeEnv = state?.activeEnv;

	const envs = entries.filter(
		(entry) => entry !== DEFAULT_HOST_ENV && !entry.startsWith("."),
	);
	if (envs.length === 0) {
		console.log("No environments found.");
		return;
	}

	for (const env of envs) {
		const prefix = env === activeEnv ? "* " : "  ";
		console.log(`${prefix}${env}`);
	}
}

async function deleteEnv(name: string): Promise<void> {
	await ensureCcenvDirs();
	const envDir = path.join(ENVS_DIR, name);
	if (!(await fileExists(envDir))) {
		throw new Error(`Environment not found: ${name}`);
	}

	const state = await readState(STATE_FILE);
	if (state?.activeEnv === name) {
		throw new Error(`Cannot delete active environment: ${name}`);
	}

	await fs.rm(envDir, { recursive: true, force: true });
	console.log(`Deleted environment: ${name}`);
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
  ccenv list
  ccenv delete <name>
  ccenv status
  ccenv update
  ccenv deactivate (use 'deactivate' shell function after activation)
  ccenv install <package>
`;
	console.log(text.trim());
}

async function updateSelf(): Promise<void> {
	const currentScriptPath = path.resolve(process.argv[1]);
	// Expected structure: .../ccenv/src/ccenv.ts
	// root is .../ccenv
	const installDir = path.resolve(path.dirname(currentScriptPath), "..");

	const gitDir = path.join(installDir, ".git");
	if (!(await fileExists(gitDir))) {
		throw new Error(
			`Cannot update: ${installDir} is not a git repository. This command is intended for installed versions.`,
		);
	}

	console.log(`Updating ccenv in ${installDir}...`);

	try {
		const currentBranch = (
			await $`git -C ${installDir} rev-parse --abbrev-ref HEAD`.quiet().text()
		).trim();
		console.log(`Pulling latest changes for branch '${currentBranch}'...`);

		await $`git -C ${installDir} pull origin ${currentBranch}`.quiet();

		console.log("Installing dependencies...");
		await $`bun install --production --cwd ${installDir}`.quiet();

		console.log("Update complete.");
	} catch (error) {
		throw new Error(`Update failed: ${error}`);
	}
}

async function printStatus(): Promise<void> {
	const envVar = process.env.CCENV_ACTIVE;
	const state = await readState(STATE_FILE);

	console.log(`Shell:  ${envVar ? `Active (${envVar})` : "Inactive (Host)"}`);

	if (state) {
		console.log(`System: Locked by ${state.activeEnv}`);
		console.log(
			`        (Since: ${new Date(state.timestamp).toLocaleString()})`,
		);
	} else {
		console.log(`System: Free (Host)`);
	}
}

async function installGeminiHooks(): Promise<void> {
	const geminiDir = ".gemini";
	const geminiSettings = path.join(geminiDir, "settings.json");
	const hooksDir = path.join(CCENV_DIR, "hooks");

	await fs.mkdir(geminiDir, { recursive: true });
	await fs.mkdir(hooksDir, { recursive: true });

	const ccenvPath = path.resolve(process.argv[1]);
	// Ensure we use the correct invocation. If not executable directly (e.g. .ts file), prefix with current runtime (bun)
	const cmdPrefix = ccenvPath.endsWith(".ts")
		? `"${process.execPath}" "${ccenvPath}"`
		: `"${ccenvPath}"`;

	const enterScriptPath = path.join(hooksDir, "gemini-enter.sh");
	const exitScriptPath = path.join(hooksDir, "gemini-exit.sh");

	const enterScript = `#!/bin/bash
if [ -n "$CCENV_ACTIVE" ]; then
    if ! ${cmdPrefix} enter "$CCENV_ACTIVE"; then
        echo "ccenv: Failed to enter environment '$CCENV_ACTIVE'" >&2
        exit 2
    fi
fi
`;

	const exitScript = `#!/bin/bash
if [ -n "$CCENV_ACTIVE" ]; then
    if ! ${cmdPrefix} exit; then
        echo "ccenv: Failed to exit environment" >&2
        # Don't block exit
    fi
fi
`;

	await Bun.write(enterScriptPath, enterScript);
	await Bun.write(exitScriptPath, exitScript);
	await $`chmod +x ${enterScriptPath} ${exitScriptPath}`.quiet();

	let settings: any = {};
	if (await fileExists(geminiSettings)) {
		try {
			settings = JSON.parse(await Bun.file(geminiSettings).text());
		} catch {
			// ignore parse error, start fresh or partial
		}
	}

	// Enable hooks explicitly (required for Gemini CLI 0.20+)
	if (!settings.tools) settings.tools = {};
	settings.tools.enableHooks = true;

	if (!settings.hooks) settings.hooks = {};

	// BeforeTool hook
	if (!settings.hooks.BeforeTool) settings.hooks.BeforeTool = [];
	// Remove existing ccenv hooks to avoid duplicates
	settings.hooks.BeforeTool = settings.hooks.BeforeTool.filter(
		(h: any) =>
			!h.hooks?.some(
				(sub: any) => sub.name === "ccenv-enter" || sub.name === "ccenv-debug",
			),
	);

	settings.hooks.BeforeTool.unshift({
		hooks: [
			{
				name: "ccenv-enter",
				type: "command",
				command: ".ccenv/hooks/gemini-enter.sh",
				timeout: 300000, // 5 minutes (enter might be slow due to git)
			},
		],
	});

	// AfterTool hook
	if (!settings.hooks.AfterTool) settings.hooks.AfterTool = [];
	settings.hooks.AfterTool = settings.hooks.AfterTool.filter(
		(h: any) => !h.hooks?.some((sub: any) => sub.name === "ccenv-exit"),
	);

	settings.hooks.AfterTool.push({
		hooks: [
			{
				name: "ccenv-exit",
				type: "command",
				command: ".ccenv/hooks/gemini-exit.sh",
				timeout: 300000,
			},
		],
	});

	await Bun.write(geminiSettings, `${JSON.stringify(settings, null, 2)}\n`);
	console.log("Installed gemini-cli hooks.");
}

async function installClaudeHooks(): Promise<void> {
	const claudeDir = ".claude";
	const claudeSettings = path.join(claudeDir, "settings.json");
	const hooksDir = path.join(CCENV_DIR, "hooks");

	await fs.mkdir(claudeDir, { recursive: true });
	await fs.mkdir(hooksDir, { recursive: true });

	const ccenvPath = path.resolve(process.argv[1]);
	const cmdPrefix = ccenvPath.endsWith(".ts")
		? `"${process.execPath}" "${ccenvPath}"`
		: `"${ccenvPath}"`;

	const enterScriptPath = path.join(hooksDir, "claude-enter.sh");
	const exitScriptPath = path.join(hooksDir, "claude-exit.sh");
	const logFile = path.resolve(CCENV_DIR, "claude-hook.log");
	const logCmd = `echo "[$(date '+%Y-%m-%d %H:%M:%S')] [$$] $1" >> "${logFile}"`;

	const enterScript = `#!/bin/bash
if [ -n "$CCENV_ACTIVE" ]; then
    ${logCmd.replace("$1", "Enter requested for $CCENV_ACTIVE")}
    if ! ${cmdPrefix} enter "$CCENV_ACTIVE"; then
        ${logCmd.replace("$1", "FAILED to enter $CCENV_ACTIVE")}
        echo "ccenv: Failed to enter environment '$CCENV_ACTIVE'" >&2
        exit 2
    fi
    ${logCmd.replace("$1", "Entered $CCENV_ACTIVE")}
else
    ${logCmd.replace("$1", "Enter skipped (no CCENV_ACTIVE)")}
fi
`;

	const exitScript = `#!/bin/bash
if [ -n "$CCENV_ACTIVE" ]; then
    ${logCmd.replace("$1", "Exit requested")}
    if ! ${cmdPrefix} exit; then
        ${logCmd.replace("$1", "FAILED to exit")}
        echo "ccenv: Failed to exit environment" >&2
        # Don't block exit
    fi
    ${logCmd.replace("$1", "Exited")}
else
    ${logCmd.replace("$1", "Exit skipped (no CCENV_ACTIVE)")}
fi
`;

	await Bun.write(enterScriptPath, enterScript);
	await Bun.write(exitScriptPath, exitScript);
	await $`chmod +x ${enterScriptPath} ${exitScriptPath}`.quiet();

	let settings: any = {};
	if (await fileExists(claudeSettings)) {
		try {
			settings = JSON.parse(await Bun.file(claudeSettings).text());
		} catch {
			// ignore parse error
		}
	}

	// Enable hooks explicitly
	if (!settings.tools) settings.tools = {};
	settings.tools.enableHooks = true;

	if (!settings.hooks) settings.hooks = {};

	// PreToolUse hook (Enter)
	if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];
	settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(
		(h: any) => !h.hooks?.some((sub: any) => sub.name === "ccenv-enter"),
	);

	// Unshift to run first (wrap outer)
	settings.hooks.PreToolUse.unshift({
		matcher: "*",
		hooks: [
			{
				name: "ccenv-enter",
				type: "command",
				command: "$CLAUDE_PROJECT_DIR/.ccenv/hooks/claude-enter.sh",
				timeout: 300000,
			},
		],
	});

	// PostToolUse hook (Exit)
	if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];
	settings.hooks.PostToolUse = settings.hooks.PostToolUse.filter(
		(h: any) => !h.hooks?.some((sub: any) => sub.name === "ccenv-exit"),
	);

	// Push to run last (wrap outer)
	settings.hooks.PostToolUse.push({
		matcher: "*",
		hooks: [
			{
				name: "ccenv-exit",
				type: "command",
				command: "$CLAUDE_PROJECT_DIR/.ccenv/hooks/claude-exit.sh",
				timeout: 300000,
			},
		],
	});

	await Bun.write(claudeSettings, `${JSON.stringify(settings, null, 2)}\n`);
	console.log("Installed claude-code hooks.");
}

async function installPackage(pkg: string): Promise<void> {
	if (pkg === "gemini-cli") {
		await installGeminiHooks();
	} else if (pkg === "claude-code") {
		await installClaudeHooks();
	} else {
		throw new Error(`Unknown package: ${pkg}`);
	}
}

function getActivateScript(name: string): string {
	const isZsh = process.env.SHELL?.endsWith("zsh");

	// Prompt modification
	let ps1Modification = "";
	if (isZsh) {
		// Bold Green: %B%F{green} ... %f%b
		ps1Modification = `export PS1="(%B%F{green}${name}%f%b) $PS1"`;
	} else {
		// Assume Bash or compatible
		// Bold Green: \033[1;32m -> \e[1;32m
		// Wrapped in \[ \] for Bash prompt length calculation.
		ps1Modification = `export PS1="(\\[\\033[1;32m\\]${name}\\[\\033[0m\\]) $PS1"`;
	}

	return `
export CCENV_ACTIVE="${name}"
if [ -z "\${CCENV_OLD_PS1+x}" ]; then
    export CCENV_OLD_PS1="$PS1"
fi

deactivate() {
    if [ -n "\${CCENV_OLD_PS1+x}" ]; then
        export PS1="$CCENV_OLD_PS1"
        unset CCENV_OLD_PS1
    fi
    unset CCENV_ACTIVE
    unset -f deactivate
}

${ps1Modification}
`.trim();
}

function escapeShellArg(arg: string): string {
	return `'${arg.replace(/'/g, "'\\''")}'`;
}

async function runCommand(envName: string, command: string[]): Promise<number> {
	const script = command.map(escapeShellArg).join(" ");
	const child = Bun.spawn({
		cmd: ["bash", "-c", script],
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
		env: { ...process.env, CCENV_ACTIVE: envName },
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
		case "list": {
			await listEnvs();
			return;
		}
		case "status": {
			await printStatus();
			return;
		}
		case "update": {
			await updateSelf();
			return;
		}
		case "delete": {
			const name = rest[0];
			if (!name) throw new Error("Missing environment name.");
			await deleteEnv(name);
			return;
		}
		case "activate": {
			const name = rest[0];
			if (!name) throw new Error("Missing environment name.");
			console.log(getActivateScript(name));
			return;
		}
		case "deactivate": {
			console.error("To deactivate, run the 'deactivate' shell function.");
			console.error(
				"If you haven't activated, there is nothing to deactivate.",
			);
			return;
		}
		case "install": {
			const pkg = rest[0];
			if (!pkg) throw new Error("Missing package name.");
			await installPackage(pkg);
			return;
		}
		case "enter": {
			const name = resolveEnvName(rest[0]);
			await enterEnv(name);
			return;
		}
		case "exit": {
			const force = rest.includes("--force");
			await exitEnv({ force });
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
			let commandArgs = rest.slice(commandIndex);
			if (commandArgs[0] === "--") {
				commandArgs = commandArgs.slice(1);
			}
			if (!commandArgs.length) {
				throw new Error("Missing command to run.");
			}
			const resolvedEnv = resolveEnvName(envName);

			let entered = false;
			let signalHandled = false;
			const onSignal = async (_signal: NodeJS.Signals, code: number) => {
				if (signalHandled) return;
				signalHandled = true;
				if (entered) {
					try {
						await exitEnv({ force: true });
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
				entered = await enterEnv(resolvedEnv);
				exitCode = await runCommand(resolvedEnv, commandArgs);
			} finally {
				if (entered && !signalHandled) {
					await exitEnv({ force: true });
				}
				process.off("SIGINT", sigint);
				process.off("SIGTERM", sigterm);
			}
			process.exit(exitCode);
			return;
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
