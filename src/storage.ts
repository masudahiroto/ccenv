import * as fs from "node:fs/promises";
import * as os from "node:os";

export type StateFile = {
	activeEnv: string;
	hostEnv: string;
	timestamp: number;
};

export async function readState(stateFile: string): Promise<StateFile | null> {
	try {
		const text = await Bun.file(stateFile).text();
		return JSON.parse(text) as StateFile;
	} catch {
		return null;
	}
}

export async function writeState(
	stateFile: string,
	state: StateFile,
): Promise<void> {
	await Bun.write(stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function acquireLock(
	lockFile: string,
	timeoutMs = 30000,
): Promise<void> {
	const start = Date.now();
	while (true) {
		try {
			const handle = await fs.open(lockFile, "wx");
			const payload = {
				pid: process.pid,
				hostname: os.hostname(),
				timestamp: Date.now(),
			};
			await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`);
			await handle.close();
			return;
		} catch (error: any) {
			if (error?.code === "EEXIST") {
				if (Date.now() - start > timeoutMs) {
					let details = "";
					try {
						details = await Bun.file(lockFile).text();
					} catch {
						details = "unknown";
					}
					throw new Error(
						`Lock timeout (${timeoutMs}ms). Held by: ${details.trim()}`,
					);
				}
				await sleep(100);
				continue;
			}
			throw error;
		}
	}
}

export async function releaseLock(lockFile: string): Promise<void> {
	try {
		await fs.rm(lockFile);
	} catch {
		// Best-effort cleanup.
	}
}
