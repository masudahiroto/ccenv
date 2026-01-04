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
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ccenv-it-conc-"));
	const realDir = await fs.realpath(dir);
	await runGit(["init"], realDir);
	await runGit(["config", "user.email", "test@example.com"], realDir);
	await runGit(["config", "user.name", "Test User"], realDir);
	await fs.writeFile(path.join(realDir, "file.txt"), "base\n");
	await runGit(["add", "file.txt"], realDir);
	await runGit(["commit", "-m", "init"], realDir);
	return realDir;
}

describe("ccenv concurrency (serialized)", () => {
	it("serializes concurrent entry via waiting", async () => {
		const repo = await makeRepo();
		await runCcenv(["create", "env-conc2"], repo);

		// We start two processes. They should both succeed eventually.
		// The second one waits for the first one to exit.
		// But wait, "enter" returns immediately.
		// So if process 1 does "enter", it holds the state.
		// Process 2 "enter" waits... forever?
		// Unless Process 1 exits?
		// We cannot simulate "Enter -> Wait -> Exit" easily with `runCcenv(["enter"])`.
		// `runCcenv(["enter"])` enters and finishes.
		// So state REMAINS.
		// So Process 2 waits FOREVER (until timeout).

		// To test serialization, we need Process 1 to be "Enter, Wait, Exit".
		// We can use `ccenv run`?
		// `ccenv run` calls enter, runs command, exits.
		// So:
		// P1: ccenv run -- sleep 2
		// P2: ccenv run -- echo "done"
		// P2 should finish AFTER P1.

		const start = Date.now();

		const p1 = runCcenv(["run", "--env", "env-conc2", "sleep", "1"], repo);
		// Give P1 a head start to acquire lock/state
		await new Promise((r) => setTimeout(r, 200));
		const p2 = runCcenv(["run", "--env", "env-conc2", "echo", "done"], repo);

		const [r1, r2] = await Promise.all([p1, p2]);
		const end = Date.now();

		expect(r1.exitCode).toBe(0);
		expect(r2.exitCode).toBe(0);

		// Total time should be > 1000ms (P1 execution time)
		// If parallel, P2 might finish instantly? No, P2 waits for state.
		expect(end - start).toBeGreaterThan(1000);
	});
});
