/**
 * macOS sandbox-exec dry-run integration tests.
 * Runs aegis as a child process with --dry-run and verifies the sandbox-exec
 * command + generated SBPL profile. Skipped on non-darwin platforms.
 */
import { describe as _describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "bun";

const describe = process.platform === "darwin" ? _describe : _describe.skip;

const AEGIS_PATH = resolve(__dirname, "../../src/main.ts");

interface DryRunOutput {
  cmd: string;
  args: string[];
}

async function runAegisDryRun(
  tool: string,
  toolArgs: string[] = [],
  aegisArgs: string[] = [],
  env: Record<string, string> = {},
  cwd?: string
): Promise<{ output: DryRunOutput | null; stderr: string; exitCode: number }> {
  const proc = spawn({
    cmd: ["bun", "run", AEGIS_PATH, tool, "--dry-run", ...aegisArgs, ...toolArgs],
    env: { ...process.env, ...env },
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  let output: DryRunOutput | null = null;
  try {
    const trimmed = stdout.trim();
    if (trimmed) output = JSON.parse(trimmed);
  } catch {
    // not JSON
  }
  return { output, stderr, exitCode };
}

/** Extract the SBPL profile (the arg following "-p"). */
function profileOf(output: DryRunOutput | null): string {
  if (!output) return "";
  const i = output.args.indexOf("-p");
  return i >= 0 ? output.args[i + 1] ?? "" : "";
}

describe("sandbox-exec dry-run", () => {
  let tempDir: string;
  let tempHome: string;
  let tempProject: string;
  // The child process reports cwd via realpath(), so /tmp -> /private/tmp on macOS.
  let realProject: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "aegis-sbx-"));
    tempHome = join(tempDir, "home");
    tempProject = join(tempDir, "project");
    await mkdir(tempHome, { recursive: true });
    await mkdir(tempProject, { recursive: true });
    await mkdir(join(tempHome, ".claude"), { recursive: true });
    await writeFile(join(tempHome, ".claude.json"), "{}");
    realProject = realpathSync(tempProject);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("emits a sandbox-exec command with -p and a profile", async () => {
    const { output, exitCode } = await runAegisDryRun(
      "cc",
      ["--version"],
      [],
      { HOME: tempHome },
      tempProject
    );
    expect(exitCode).toBe(0);
    expect(output?.cmd).toBe("sandbox-exec");
    expect(output?.args[0]).toBe("-p");
    expect(output?.args).toContain("--");
    expect(profileOf(output)).toContain("(version 1)");
  });

  test("profile is read-only root with the cwd writable", async () => {
    const { output } = await runAegisDryRun(
      "cc",
      ["--version"],
      [],
      { HOME: tempHome },
      tempProject
    );
    const profile = profileOf(output);
    expect(profile).toContain("(allow default)");
    expect(profile).toContain("(deny file-write*)");
    expect(profile).toContain(
      `(allow file-read* file-write* (subpath "${realProject}"))`
    );
  });

  test("keeps /tmp and $TMPDIR writable", async () => {
    const { output } = await runAegisDryRun(
      "cc",
      ["--version"],
      [],
      { HOME: tempHome },
      tempProject
    );
    const profile = profileOf(output);
    // /tmp stays writable (reads come from `allow default`).
    expect(profile).toContain('(allow file-write* (subpath "/tmp"))');
    expect(profile).toContain(
      `(allow file-write* (subpath "${realpathSync("/tmp")}"))`
    );
    // The per-user $TMPDIR (canonicalized) is writable too.
    expect(profile).toContain(
      `(allow file-write* (subpath "${realpathSync(tmpdir())}"))`
    );
  });

  test("--hide adds a deny rule for the hidden path", async () => {
    const secret = join(tempHome, ".ssh");
    await mkdir(secret, { recursive: true });
    const { output } = await runAegisDryRun(
      "cc",
      ["--version"],
      ["--hide", secret],
      { HOME: tempHome },
      tempProject
    );
    expect(profileOf(output)).toContain(
      `(deny file-read* file-write* (subpath "${secret}"))`
    );
  });

  test("rejects a content-substitution override with a clear error", async () => {
    // .aegis.json with a substitution override
    await writeFile(join(tempProject, ".env"), "REAL=secret");
    await writeFile(join(tempProject, ".env.sandbox"), "FAKE=1");
    await writeFile(
      join(tempProject, ".aegis.json"),
      JSON.stringify([{ target: ".env", override: ".env.sandbox" }])
    );
    const { exitCode, stderr } = await runAegisDryRun(
      "cc",
      ["--version"],
      [],
      { HOME: tempHome },
      tempProject
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("file-content override is not supported");
    expect(stderr).toContain(".env");
  });

  test("masking override (no override field) is allowed and becomes a deny", async () => {
    await mkdir(join(tempProject, "secrets"), { recursive: true });
    await writeFile(
      join(tempProject, ".aegis.json"),
      JSON.stringify(["secrets/"])
    );
    const { output, exitCode } = await runAegisDryRun(
      "cc",
      ["--version"],
      [],
      { HOME: tempHome },
      tempProject
    );
    expect(exitCode).toBe(0);
    expect(profileOf(output)).toContain(
      `(deny file-read* file-write* (subpath "${join(realProject, "secrets")}"))`
    );
  });
});
