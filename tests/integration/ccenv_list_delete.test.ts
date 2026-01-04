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

async function runCmd(cmd: string[], cwd: string, env: Record<string, string> = {}): Promise<CmdResult> {
	const proc = Bun.spawn({
		cmd,
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...env },
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		Bun.readableStreamToText(proc.stdout),
		Bun.readableStreamToText(proc.stderr),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

async function runGit(args: string[], cwd: string): Promise<CmdResult> {
	return await runCmd(["git", ...args], cwd);
}

async function runCcenv(args: string[], cwd: string, env: Record<string, string> = {}): Promise<CmdResult> {
	return await runCmd(["bun", CLI_PATH, ...args], cwd, env);
}

async function makeRepo(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ccenv-it-ld-"));
	await runGit(["init"], dir);
	await runGit(["config", "user.email", "test@example.com"], dir);
	await runGit(["config", "user.name", "Test User"], dir);

	await fs.writeFile(path.join(dir, "file.txt"), "base\n");
	await runGit(["add", "file.txt"], dir);
	await runGit(["commit", "-m", "init"], dir);

	return dir;
}

describe("ccenv list & delete", () => {
	it("lists environments correctly", async () => {
		const repo = await makeRepo();

		// Initially empty (besides maybe default host tracking folder, but list implementation filters that)
		// Actually, ensureCcenvDirs runs on commands. createEnv calls it.
		// If we just run 'list', it calls ensureCcenvDirs.
		// If no envs, it prints "No environments found."
		// But since ENVS_DIR might just be created empty, readdir returns [].
		// Let's see if ENVS_DIR exists after `list`.
		// Yes, ensureCcenvDirs creates ENVS_DIR.
		// So readdir returns []. listEnvs prints "No environments found."
		let listResult = await runCcenv(["list"], repo);
		expect(listResult.exitCode).toBe(0);
		expect(listResult.stdout.trim()).toBe("No environments found.");

		// Create environments
		await runCcenv(["create", "env-a"], repo);
		await runCcenv(["create", "env-b"], repo);

		listResult = await runCcenv(["list"], repo);
		expect(listResult.exitCode).toBe(0);
		// Split lines but keep indentation
		const lines = listResult.stdout.split("\n").filter((l) => l.length > 0);
		// Check that we have lines containing the env names with correct prefix
		// Since readdir order is not guaranteed, we check for existence
		expect(lines).toContain("  env-a");
		expect(lines).toContain("  env-b");

		// Enter environment
		await runCcenv(["enter", "env-a"], repo);
		listResult = await runCcenv(["list"], repo);
		expect(listResult.exitCode).toBe(0);
		expect(listResult.stdout).toContain("* env-a");
		expect(listResult.stdout).toContain("  env-b");

		await runCcenv(["exit"], repo);
	});

	it("deletes environments correctly", async () => {
		const repo = await makeRepo();

		await runCcenv(["create", "env-del"], repo);
		let listResult = await runCcenv(["list"], repo);
		expect(listResult.stdout).toContain("  env-del");

		// Delete it
		const delResult = await runCcenv(["delete", "env-del"], repo);
		expect(delResult.exitCode).toBe(0);
		expect(delResult.stdout.trim()).toBe("Deleted environment: env-del");

		listResult = await runCcenv(["list"], repo);
		expect(listResult.stdout.trim()).toBe("No environments found.");

		// Check directory is gone
		const envPath = path.join(repo, ".ccenv", "envs", "env-del");
		await expect(fs.stat(envPath)).rejects.toThrow();
	});

	it("prevents deleting active environment", async () => {
		const repo = await makeRepo();
		await runCcenv(["create", "env-active"], repo);
		await runCcenv(["enter", "env-active"], repo);

		const delResult = await runCcenv(["delete", "env-active"], repo);
		expect(delResult.exitCode).toBe(1);
		expect(delResult.stderr).toContain("Cannot delete active environment");

		await runCcenv(["exit"], repo, { CCENV_ACTIVE: "env-active" });
		// Now can delete
		const delResult2 = await runCcenv(["delete", "env-active"], repo);
		expect(delResult2.exitCode).toBe(0);
	});

	it("fails when deleting non-existent environment", async () => {
		const repo = await makeRepo();
		const delResult = await runCcenv(["delete", "env-ghost"], repo);
		expect(delResult.exitCode).toBe(1);
		expect(delResult.stderr).toContain("Environment not found: env-ghost");
	});
});
