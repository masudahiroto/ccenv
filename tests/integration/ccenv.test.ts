import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";

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
    stderr: "pipe"
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    proc.stdout.text(),
    proc.stderr.text(),
    proc.exited
  ]);
  return { stdout, stderr, exitCode };
}

async function runGit(args: string[], cwd: string): Promise<CmdResult> {
  return await runCmd(["git", ...args], cwd);
}

async function runCcenv(args: string[], cwd: string): Promise<CmdResult> {
  return await runCmd(["bun", CLI_PATH, ...args], cwd);
}

async function makeRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ccenv-it-"));
  await runGit(["init"], dir);
  await runGit(["config", "user.email", "test@example.com"], dir);
  await runGit(["config", "user.name", "Test User"], dir);

  await fs.writeFile(path.join(dir, "file.txt"), "base\n");
  await runGit(["add", "file.txt"], dir);
  await runGit(["commit", "-m", "init"], dir);

  return dir;
}

async function diffNames(cwd: string): Promise<string[]> {
  const result = await runGit(["diff", "--name-only"], cwd);
  return result.stdout.trim().split("\n").filter(Boolean);
}

async function cachedDiffNames(cwd: string): Promise<string[]> {
  const result = await runGit(["diff", "--cached", "--name-only"], cwd);
  return result.stdout.trim().split("\n").filter(Boolean);
}

async function untrackedNames(cwd: string): Promise<string[]> {
  const result = await runGit(["ls-files", "--others", "--exclude-standard"], cwd);
  return result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .filter((name) => !name.startsWith(".ccenv/"));
}

describe("ccenv integration", () => {
  it("swaps host state in and out of an environment", async () => {
    const repo = await makeRepo();

    await fs.writeFile(path.join(repo, "file.txt"), "base\nhost edit\n");
    await fs.writeFile(path.join(repo, "staged.txt"), "staged\n");
    await runGit(["add", "staged.txt"], repo);
    await fs.writeFile(path.join(repo, "untracked.txt"), "untracked\n");

    const createResult = await runCcenv(["create", "env-a"], repo);
    expect(createResult.exitCode).toBe(0);

    const enterResult = await runCcenv(["enter", "env-a"], repo);
    expect(enterResult.exitCode).toBe(0);

    expect(await diffNames(repo)).toEqual([]);
    expect(await cachedDiffNames(repo)).toEqual([]);
    expect(await untrackedNames(repo)).toEqual([]);
    await expect(fs.stat(path.join(repo, "untracked.txt"))).rejects.toThrow();

    await fs.writeFile(path.join(repo, "file.txt"), "base\nenv edit\n");
    await fs.writeFile(path.join(repo, "env-untracked.txt"), "env\n");
    await fs.writeFile(path.join(repo, "env-staged.txt"), "env staged\n");
    await runGit(["add", "env-staged.txt"], repo);

    const exitResult = await runCcenv(["exit"], repo);
    expect(exitResult.exitCode).toBe(0);

    const hostDiff = await diffNames(repo);
    expect(hostDiff).toEqual(["file.txt"]);
    const hostCached = await cachedDiffNames(repo);
    expect(hostCached).toEqual(["staged.txt"]);
    const hostUntracked = await untrackedNames(repo);
    expect(hostUntracked).toEqual(["untracked.txt"]);

    const enterAgain = await runCcenv(["enter", "env-a"], repo);
    expect(enterAgain.exitCode).toBe(0);

    const envDiff = await diffNames(repo);
    expect(envDiff).toEqual(["file.txt"]);
    const envCached = await cachedDiffNames(repo);
    expect(envCached).toEqual(["env-staged.txt"]);
    const envUntracked = await untrackedNames(repo);
    expect(envUntracked).toEqual(["env-untracked.txt"]);

    await runCcenv(["exit"], repo);
  });

  it("prints shell activation snippet", async () => {
    const repo = await makeRepo();

    const result = await runCcenv(["activate", "env-x"], repo);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("export CCENV_ACTIVE=env-x");
  });

  it("runs a command inside an environment and restores host state", async () => {
    const repo = await makeRepo();

    await fs.writeFile(path.join(repo, "host.txt"), "host\n");

    await runCcenv(["create", "env-run"], repo);
    const runResult = await runCcenv(
      ["run", "--env", "env-run", "sh", "-c", "echo env > run.txt"],
      repo
    );
    expect(runResult.exitCode).toBe(0);

    const hostUntracked = await untrackedNames(repo);
    expect(hostUntracked).toEqual(["host.txt"]);

    const enterEnv = await runCcenv(["enter", "env-run"], repo);
    expect(enterEnv.exitCode).toBe(0);
    const envUntracked = await untrackedNames(repo);
    expect(envUntracked).toEqual(["run.txt"]);
    await runCcenv(["exit"], repo);
  });

  it("applies environment changes onto the current workspace", async () => {
    const repo = await makeRepo();

    await runCcenv(["create", "env-apply"], repo);
    await runCcenv(["enter", "env-apply"], repo);
    await fs.writeFile(path.join(repo, "apply.txt"), "apply\n");
    await runCcenv(["exit"], repo);

    const applyResult = await runCcenv(["apply", "env-apply"], repo);
    expect(applyResult.exitCode).toBe(0);

    const untracked = await untrackedNames(repo);
    expect(untracked).toEqual(["apply.txt"]);
  });

  it("blocks nested environment entry", async () => {
    const repo = await makeRepo();

    await runCcenv(["create", "env-a"], repo);
    await runCcenv(["create", "env-b"], repo);

    const enterA = await runCcenv(["enter", "env-a"], repo);
    expect(enterA.exitCode).toBe(0);

    const enterB = await runCcenv(["enter", "env-b"], repo);
    expect(enterB.exitCode).toBe(1);
    expect(enterB.stderr).toContain("Already inside environment");

    await runCcenv(["exit"], repo);
  });

  it("restores complex state including partial staging after enter/exit", async () => {
    const repo = await makeRepo();

    await fs.writeFile(path.join(repo, "mixed.txt"), "line1\nline2\nline3\n");
    await runGit(["add", "mixed.txt"], repo);
    await runGit(["commit", "-m", "add mixed"], repo);

    await fs.writeFile(path.join(repo, "mixed.txt"), "line1 edit\nline2\nline3\n");
    await runGit(["add", "mixed.txt"], repo);
    await fs.writeFile(path.join(repo, "mixed.txt"), "line1 edit\nline2 edit\nline3\n");

    await fs.writeFile(path.join(repo, "staged.txt"), "staged\n");
    await runGit(["add", "staged.txt"], repo);
    await fs.writeFile(path.join(repo, "untracked.txt"), "untracked\n");

    await runCcenv(["create", "env-complex"], repo);
    const enterResult = await runCcenv(["enter", "env-complex"], repo);
    expect(enterResult.exitCode).toBe(0);

    expect(await diffNames(repo)).toEqual([]);
    expect(await cachedDiffNames(repo)).toEqual([]);
    expect(await untrackedNames(repo)).toEqual([]);

    const exitResult = await runCcenv(["exit"], repo);
    expect(exitResult.exitCode).toBe(0);

    const hostDiff = await diffNames(repo);
    expect(hostDiff).toEqual(["mixed.txt"]);
    const hostCached = await cachedDiffNames(repo);
    expect(hostCached).toEqual(["mixed.txt", "staged.txt"]);
    const hostUntracked = await untrackedNames(repo);
    expect(hostUntracked).toEqual(["untracked.txt"]);

    const mixedContent = await fs.readFile(path.join(repo, "mixed.txt"), "utf8");
    expect(mixedContent).toBe("line1 edit\nline2 edit\nline3\n");
  });

  it("accumulates environment changes across multiple enter/exit cycles", async () => {
    const repo = await makeRepo();

    await runCcenv(["create", "env-cycle"], repo);

    await runCcenv(["enter", "env-cycle"], repo);
    await fs.writeFile(path.join(repo, "cycle.txt"), "v1\n");
    await runCcenv(["exit"], repo);

    await runCcenv(["enter", "env-cycle"], repo);
    expect(await untrackedNames(repo)).toEqual(["cycle.txt"]);
    await runGit(["add", "cycle.txt"], repo);
    await fs.writeFile(path.join(repo, "cycle.txt"), "v2\n");
    await runCcenv(["exit"], repo);

    await runCcenv(["enter", "env-cycle"], repo);
    expect(await untrackedNames(repo)).toEqual([]);
    expect(await cachedDiffNames(repo)).toEqual(["cycle.txt"]);
    const content = await fs.readFile(path.join(repo, "cycle.txt"), "utf8");
    expect(content).toBe("v2\n");
    await runCcenv(["exit"], repo);
  });
});
