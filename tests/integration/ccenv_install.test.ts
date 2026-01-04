import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const CLI_PATH = path.resolve(import.meta.dir, "../../src/ccenv.ts");

type CmdResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
};

async function runCmd(cmd: string[], cwd: string): Promise<CmdResult> {
	const proc = Bun.spawn({
		cmd,
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		Bun.readableStreamToText(proc.stdout),
		Bun.readableStreamToText(proc.stderr),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

async function runCcenv(args: string[], cwd: string): Promise<CmdResult> {
	return await runCmd(["bun", CLI_PATH, ...args], cwd);
}

async function runGit(args: string[], cwd: string): Promise<CmdResult> {
	return await runCmd(["git", ...args], cwd);
}

async function makeRepo(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ccenv-it-install-"));
	const realDir = await fs.realpath(dir);
	await runGit(["init"], realDir);
	await runGit(["config", "user.email", "test@example.com"], realDir);
	await runGit(["config", "user.name", "Test User"], realDir);
	await fs.writeFile(path.join(realDir, "file.txt"), "base\n");
	await runGit(["add", "file.txt"], realDir);
	await runGit(["commit", "-m", "init"], realDir);
	return realDir;
}

describe("ccenv install", () => {
	it("installs gemini-cli hooks correctly", async () => {
		const repo = await makeRepo();

		const result = await runCcenv(["install", "gemini-cli"], repo);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Installed gemini-cli hooks.");

		// Check hook scripts
		const enterScript = path.join(repo, ".ccenv", "hooks", "gemini-enter.sh");
		const exitScript = path.join(repo, ".ccenv", "hooks", "gemini-exit.sh");
		await expect(fs.stat(enterScript)).resolves.toBeDefined();
		await expect(fs.stat(exitScript)).resolves.toBeDefined();

		// Check execution permissions (basic check)
		// fs.access with X_OK
		await expect(fs.access(enterScript, fs.constants.X_OK)).resolves.toBeNull();
		await expect(fs.access(exitScript, fs.constants.X_OK)).resolves.toBeNull();

		// Check settings.json
		const settingsPath = path.join(repo, ".gemini", "settings.json");
		const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));

		expect(settings.tools).toBeDefined();
		expect(settings.tools.enableHooks).toBe(true);
		expect(settings.hooks).toBeDefined();
		expect(settings.hooks.BeforeTool).toBeDefined();
		expect(settings.hooks.AfterTool).toBeDefined();

		const enterHook = settings.hooks.BeforeTool.find((h: any) =>
			h.hooks.some((sub: any) => sub.name === "ccenv-enter"),
		);
		expect(enterHook).toBeDefined();
		expect(enterHook.matcher).toBeUndefined();
		expect(enterHook.hooks[0].name).toBe("ccenv-enter");
		expect(enterHook.hooks[0].command).toBe(".ccenv/hooks/gemini-enter.sh");

		// Verify script content has error handling
		const enterScriptContent = await fs.readFile(enterScript, "utf8");
		expect(enterScriptContent).toContain("exit 2");

		const exitHook = settings.hooks.AfterTool.find((h: any) =>
			h.hooks.some((sub: any) => sub.name === "ccenv-exit"),
		);
		expect(exitHook).toBeDefined();
		expect(exitHook.matcher).toBeUndefined();
		expect(exitHook.hooks[0].command).toBe(".ccenv/hooks/gemini-exit.sh");
	});

	it("fails for unknown packages", async () => {
		const repo = await makeRepo();
		const result = await runCcenv(["install", "unknown-pkg"], repo);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("Unknown package: unknown-pkg");
	});

	it("preserves existing hooks and wraps them", async () => {
		const repo = await makeRepo();
		const settingsPath = path.join(repo, ".gemini", "settings.json");
		await fs.mkdir(path.dirname(settingsPath), { recursive: true });

		const existingSettings = {
			hooks: {
				BeforeTool: [
					{
						hooks: [
							{
								name: "existing-before",
								type: "command",
								command: "echo before",
							},
						],
					},
				],
				AfterTool: [
					{
						hooks: [
							{
								name: "existing-after",
								type: "command",
								command: "echo after",
							},
						],
					},
				],
			},
		};
		await fs.writeFile(settingsPath, JSON.stringify(existingSettings));

		await runCcenv(["install", "gemini-cli"], repo);

		const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));

		// Check BeforeTool order: [ccenv-enter, existing-before]
		expect(settings.hooks.BeforeTool).toHaveLength(2);
		expect(settings.hooks.BeforeTool[0].hooks[0].name).toBe("ccenv-enter");
		expect(settings.hooks.BeforeTool[1].hooks[0].name).toBe("existing-before");

		// Check AfterTool order: [existing-after, ccenv-exit]
		expect(settings.hooks.AfterTool).toHaveLength(2);
		expect(settings.hooks.AfterTool[0].hooks[0].name).toBe("existing-after");
		expect(settings.hooks.AfterTool[1].hooks[0].name).toBe("ccenv-exit");
	});

	it("installs claude-code hooks correctly", async () => {
		const repo = await makeRepo();

		const result = await runCcenv(["install", "claude-code"], repo);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Installed claude-code hooks.");

		// Check hook scripts
		const enterScript = path.join(repo, ".ccenv", "hooks", "claude-enter.sh");
		await expect(fs.stat(enterScript)).resolves.toBeDefined();

		// Check settings.json
		const settingsPath = path.join(repo, ".claude", "settings.json");
		const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));

		expect(settings.tools).toBeDefined();
		expect(settings.tools.enableHooks).toBe(true);
		expect(settings.hooks).toBeDefined();
		expect(settings.hooks.PreToolUse).toBeDefined();
		expect(settings.hooks.PostToolUse).toBeDefined();

		const enterHook = settings.hooks.PreToolUse.find((h: any) =>
			h.hooks.some((sub: any) => sub.name === "ccenv-enter"),
		);
		expect(enterHook).toBeDefined();
		expect(enterHook.matcher).toBe("*");
		expect(enterHook.hooks[0].command).toBe(
			"$CLAUDE_PROJECT_DIR/.ccenv/hooks/claude-enter.sh",
		);

		const exitHook = settings.hooks.PostToolUse.find((h: any) =>
			h.hooks.some((sub: any) => sub.name === "ccenv-exit"),
		);
		expect(exitHook).toBeDefined();
		expect(exitHook.hooks[0].command).toBe(
			"$CLAUDE_PROJECT_DIR/.ccenv/hooks/claude-exit.sh",
		);
	});
});
