import { expect, test } from "bun:test";
import * as path from "node:path";
import { $ } from "bun";

const CCENV_PATH = path.resolve(__dirname, "../../src/ccenv.ts");
const TEST_ENV_NAME = "test_exit_safety";

async function ccenv(args: string[], env: Record<string, string> = {}) {
	const baseEnv = { ...process.env };
	delete baseEnv.CCENV_ACTIVE;
	console.log("Running:", "bun", CCENV_PATH, ...args);
	return await $`bun ${CCENV_PATH} ${args}`
		.env({ ...baseEnv, ...env })
		.quiet()
		.nothrow();
}

test("debug file content", async () => {
	const content = await Bun.file(CCENV_PATH).text();
	console.log(
		"File content has modified log:",
		content.includes("requesting lock (modified)"),
	);
	console.log("CCENV_PATH is:", CCENV_PATH);
});

test("ccenv exit safety check", async () => {
	console.log("Current CCENV_ACTIVE:", process.env.CCENV_ACTIVE);

	// Setup
	await ccenv(["delete", TEST_ENV_NAME]);
	await ccenv(["create", TEST_ENV_NAME, "--empty"]);

	// 1. Enter environment
	const enterRes = await ccenv(["enter", TEST_ENV_NAME]);
	expect(enterRes.exitCode).toBe(0);

	// Check status
	const statusRes = await ccenv(["status"]);
	expect(statusRes.text()).toContain(`Locked by ${TEST_ENV_NAME}`);

	// 2. Try to exit from a "fresh" shell (no CCENV_ACTIVE)
	// TARGET BEHAVIOR: This should fail.
	const exitRes1 = await ccenv(["exit"]);
	console.log(
		"Exit attempt 1 (no env):",
		exitRes1.exitCode,
		exitRes1.stderr.toString(),
	);
	expect(exitRes1.exitCode).not.toBe(0);
	expect(exitRes1.stderr.toString()).toContain("Cannot exit");

	// Restore if it exited
	if (exitRes1.exitCode === 0) {
		await ccenv(["enter", TEST_ENV_NAME]);
	}

	// 3. Try to exit with mismatching CCENV_ACTIVE
	const exitRes2 = await ccenv(["exit"], { CCENV_ACTIVE: "other_env" });
	console.log(
		"Exit attempt 2 (mismatch):",
		exitRes2.exitCode,
		exitRes2.stderr.toString(),
	);
	expect(exitRes2.exitCode).not.toBe(0);
	expect(exitRes2.stderr.toString()).toContain("Cannot exit");

	if (exitRes2.exitCode === 0) {
		await ccenv(["enter", TEST_ENV_NAME]);
	}

	// 4. Try to exit with matching CCENV_ACTIVE
	const exitRes3 = await ccenv(["exit"], { CCENV_ACTIVE: TEST_ENV_NAME });
	console.log("Exit attempt 3 (match):", exitRes3.exitCode);
	expect(exitRes3.exitCode).toBe(0);

	if (exitRes3.exitCode === 0) {
		await ccenv(["enter", TEST_ENV_NAME]);
	}

	// 5. Try to exit with --force (no env)
	const exitRes4 = await ccenv(["exit", "--force"]);
	console.log("Exit attempt 4 (force):", exitRes4.exitCode);
	expect(exitRes4.exitCode).toBe(0);

	// Cleanup
	await ccenv(["delete", TEST_ENV_NAME]);
});
