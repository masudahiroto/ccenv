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
	env?: Record<string, string>,
): Promise<CmdResult> {
	const proc = Bun.spawn({
		cmd,
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: env ? { ...process.env, ...env } : undefined,
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
	env?: Record<string, string>,
): Promise<CmdResult> {
	return await runCmd(["bun", CLI_PATH, ...args], cwd, env);
}

async function runGit(args: string[], cwd: string): Promise<CmdResult> {
	return await runCmd(["git", ...args], cwd);
}

async function makeRepo(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ccenv-it-sep-"));
	await runGit(["init"], dir);
	await runGit(["config", "user.email", "test@example.com"], dir);
	await runGit(["config", "user.name", "Test User"], dir);
	await fs.writeFile(path.join(dir, "file.txt"), "base\n");
	await runGit(["add", "file.txt"], dir);
	await runGit(["commit", "-m", "init"], dir);
	return dir;
}

describe("ccenv run separator handling", () => {
	it("ignores -- separator before command", async () => {
		const repo = await makeRepo();
		await runCcenv(["create", "env-sep"], repo);

		// Test: ccenv run -- echo hello
		const result = await runCcenv(
			["run", "--env", "env-sep", "--", "echo", "hello"],
			repo,
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("hello");
	});

	it("works without separator", async () => {
		const repo = await makeRepo();
		await runCcenv(["create", "env-nosep"], repo);

		// Test: ccenv run echo hello
		const result = await runCcenv(
			["run", "--env", "env-nosep", "echo", "hello"],
			repo,
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("hello");
	});

	it("ignores -- when not using --env flag (using CCENV_ACTIVE)", async () => {
		const repo = await makeRepo();
		await runCcenv(["create", "env-active-sep"], repo);

		// Test: ccenv run -- echo hello (with CCENV_ACTIVE set)
		const result = await runCcenv(["run", "--", "echo", "active-hello"], repo, {
			CCENV_ACTIVE: "env-active-sep",
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("active-hello");
	});
});
