import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	acquireLock,
	readState,
	releaseLock,
	writeState,
} from "../../src/storage";

async function makeTempDir(): Promise<string> {
	return await fs.mkdtemp(path.join(os.tmpdir(), "ccenv-unit-"));
}

describe("storage", () => {
	it("reads and writes state files", async () => {
		const dir = await makeTempDir();
		const statePath = path.join(dir, "state.json");

		const state = { activeEnv: "feature", hostEnv: "default", timestamp: 123 };
		await writeState(statePath, state);

		const readBack = await readState(statePath);
		expect(readBack).toEqual(state);
	});

	it("returns null when state file is missing", async () => {
		const dir = await makeTempDir();
		const statePath = path.join(dir, "missing.json");

		const result = await readState(statePath);
		expect(result).toBeNull();
	});

	it("acquires and releases locks atomically", async () => {
		const dir = await makeTempDir();
		const lockPath = path.join(dir, "lock");

		await acquireLock(lockPath);
		// Should timeout quickly (100ms)
		await expect(acquireLock(lockPath, 100)).rejects.toThrow("Lock timeout");
		await releaseLock(lockPath);

		await acquireLock(lockPath);
		await releaseLock(lockPath);
	});
});
