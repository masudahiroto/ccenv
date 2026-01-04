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

async function runCmd(
	cmd: string[],
	cwd: string,
	env: Record<string, string> = {},
): Promise<CmdResult> {
	const newEnv = { ...process.env };
	delete newEnv.CCENV_ACTIVE;
	const finalEnv = { ...newEnv, ...env };

	const proc = Bun.spawn({
		cmd,
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: finalEnv,
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		Bun.readableStreamToText(proc.stdout),
		Bun.readableStreamToText(proc.stderr),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

async function runCcenv(
	args: string[],
	cwd: string,
	env: Record<string, string> = {},
): Promise<CmdResult> {
	return await runCmd(["bun", CLI_PATH, ...args], cwd, env);
}

async function runGit(args: string[], cwd: string): Promise<CmdResult> {
	return await runCmd(["git", ...args], cwd);
}

async function makeRepo(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ccenv-it-status-"));
	const realDir = await fs.realpath(dir);
	await runGit(["init"], realDir);
	await runGit(["config", "user.email", "test@example.com"], realDir);
	await runGit(["config", "user.name", "Test User"], realDir);
	await fs.writeFile(path.join(realDir, "file.txt"), "base\n");
	await runGit(["add", "file.txt"], realDir);
	await runGit(["commit", "-m", "init"], realDir);
	return realDir;
}

describe("ccenv status", () => {
	it("reports inactive status by default", async () => {
		const repo = await makeRepo();
		const result = await runCcenv(["status"], repo);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Shell:  Inactive (Host)");
		expect(result.stdout).toContain("System: Free (Host)");
	});

	it("reports active shell environment", async () => {
		const repo = await makeRepo();
		await runCcenv(["create", "env-stat"], repo);
		// Simulate being inside an activated shell
		const result = await runCcenv(["status"], repo, {
			CCENV_ACTIVE: "env-stat",
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Shell:  Active (env-stat)");
		expect(result.stdout).toContain("System: Free (Host)");
	});

	it("reports system lock status", async () => {
		const repo = await makeRepo();
		await runCcenv(["create", "env-lock"], repo);

		// We need to simulate the system being locked.
		// We can do this by manually entering and then running status from *another* process?
		// Or just manually writing the state file.

		await fs.mkdir(path.join(repo, ".ccenv"), { recursive: true });
		await fs.writeFile(
			path.join(repo, ".ccenv", "state"),
			JSON.stringify({
				activeEnv: "env-lock",
				hostEnv: "default",
				timestamp: Date.now(),
			}),
		);

		const result = await runCcenv(["status"], repo);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Shell:  Inactive (Host)");
		expect(result.stdout).toContain("System: Locked by env-lock");
	});

	it("reports matched status", async () => {
		const repo = await makeRepo();
		await runCcenv(["create", "env-match"], repo);

		await fs.mkdir(path.join(repo, ".ccenv"), { recursive: true });
		await fs.writeFile(
			path.join(repo, ".ccenv", "state"),
			JSON.stringify({
				activeEnv: "env-match",
				hostEnv: "default",
				timestamp: Date.now(),
			}),
		);

		const result = await runCcenv(["status"], repo, {
			CCENV_ACTIVE: "env-match",
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Shell:  Active (env-match)");
		expect(result.stdout).toContain("System: Locked by env-match");
		expect(result.stdout).not.toContain("WARNING");
	});
});
