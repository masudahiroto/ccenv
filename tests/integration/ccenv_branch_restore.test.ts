import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";

const CCENV_PATH = path.resolve(__dirname, "../../src/ccenv.ts");
const TEST_DIR = path.resolve(__dirname, "../../test_env_branch_restore");

async function runCcenv(args: string[]) {
	return await $`bun ${CCENV_PATH} ${args}`.cwd(TEST_DIR).text();
}

describe("ccenv branch restore", () => {
	beforeEach(async () => {
		if (await fs.exists(TEST_DIR)) {
			await fs.rm(TEST_DIR, { recursive: true, force: true });
		}
		await fs.mkdir(TEST_DIR, { recursive: true });

		// Initialize git repo
		await $`git init`.cwd(TEST_DIR).quiet();
		await $`git config user.name "Test User"`.cwd(TEST_DIR).quiet();
		await $`git config user.email "test@example.com"`.cwd(TEST_DIR).quiet();
		await $`echo "initial" > file.txt`.cwd(TEST_DIR).quiet();
		await $`git add file.txt`.cwd(TEST_DIR).quiet();
		await $`git commit -m "Initial commit"`.cwd(TEST_DIR).quiet();
	});

	afterEach(async () => {
		if (await fs.exists(TEST_DIR)) {
			await fs.rm(TEST_DIR, { recursive: true, force: true });
		}
	});

	it("should restore the original branch when entering an environment", async () => {
		// 1. Create and checkout branch-A
		await $`git checkout -b branch-A`.cwd(TEST_DIR).quiet();
		const branchBefore = (
			await $`git branch --show-current`.cwd(TEST_DIR).text()
		).trim();
		expect(branchBefore).toBe("branch-A");

		// 2. Create environment 'env-A' while on branch-A
		await runCcenv(["create", "env-A"]);

		// 3. Switch back to main
		await $`git checkout main`.cwd(TEST_DIR).quiet();
		const branchMain = (
			await $`git branch --show-current`.cwd(TEST_DIR).text()
		).trim();
		expect(branchMain).toBe("main");

		// 4. Run command in env-A and check branch
		// This implies enterEnv -> restoreEnv -> command -> exitEnv
		const output = await runCcenv([
			"run",
			"--env",
			"env-A",
			"git",
			"branch",
			"--show-current",
		]);

		expect(output.trim()).toBe("branch-A");

		// 5. Ensure we are back on main (exitEnv restores host)
		// Note: exitEnv restores the HOST environment.
		// When we ran `ccenv run`, the host environment was captured as 'default'.
		// Since we were on 'main' when we ran `ccenv run`, the host 'default' should be on 'main'.
		const branchAfter = (
			await $`git branch --show-current`.cwd(TEST_DIR).text()
		).trim();
		expect(branchAfter).toBe("main");
	});
});
