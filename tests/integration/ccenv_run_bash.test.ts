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
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ccenv-it-run-"));
	await runGit(["init"], dir);
	await runGit(["config", "user.email", "test@example.com"], dir);
	await runGit(["config", "user.name", "Test User"], dir);
	await fs.writeFile(path.join(dir, "file.txt"), "base\n");
	await runGit(["add", "file.txt"], dir);
	await runGit(["commit", "-m", "init"], dir);
	return dir;
}

describe("ccenv run bash wrapping", () => {
	it("executes command via bash", async () => {
		const repo = await makeRepo();
		await runCcenv(["create", "env-bash"], repo);

		// We expect this to run as: bash -c 'echo "hello world"'
		const result = await runCcenv(
			["run", "--env", "env-bash", "echo", "hello world"],
			repo,
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("hello world");
	});

	it("handles shell special characters correctly", async () => {
		const repo = await makeRepo();
		await runCcenv(["create", "env-special"], repo);

		// We pass "sh" "-c" "echo foo > bar.txt"
		const result = await runCcenv(
			["run", "--env", "env-special", "sh", "-c", "echo foo > bar.txt"],
			repo,
		);
		expect(result.exitCode).toBe(0);

		// file is cleaned up from workspace, so we must enter env to see it
		await runCcenv(["enter", "env-special"], repo);
		const content = await fs.readFile(path.join(repo, "bar.txt"), "utf8");
		expect(content.trim()).toBe("foo");
		await runCcenv(["exit"], repo);
	});

	it("exposes bash environment variables when explicitly invoked", async () => {
		const repo = await makeRepo();
		await runCcenv(["create", "env-vars"], repo);

		// To check variable expansion, we must run a shell that expands them.
		// The top-level bash -c wrapping preserves arguments literally.
		// So we run: bash -c 'echo $BASH_VERSION'
		const result = await runCcenv(
			["run", "--env", "env-vars", "bash", "-c", "echo $BASH_VERSION"],
			repo,
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toMatch(/^[0-9.]+/); // Expecting version number
	});
});
