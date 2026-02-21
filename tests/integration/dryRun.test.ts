/**
 * Layer 2: CLI dry-run integration tests.
 * These tests run aegis as a child process with --dry-run and verify the output.
 * No actual bubblewrap execution occurs.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "bun";

const AEGIS_PATH = resolve(__dirname, "../../src/main.ts");

interface DryRunOutput {
  cmd: string;
  args: string[];
}

/**
 * Run aegis with --dry-run and parse the JSON output.
 */
async function runAegisDryRun(
  tool: string,
  toolArgs: string[] = [],
  aegisArgs: string[] = [],
  env: Record<string, string> = {},
  cwd?: string
): Promise<{ output: DryRunOutput | null; stderr: string; exitCode: number }> {
  const proc = spawn({
    cmd: [
      "bun",
      "run",
      AEGIS_PATH,
      tool,
      "--dry-run",
      ...aegisArgs,
      ...toolArgs,
    ],
    env: {
      ...process.env,
      ...env,
    },
    cwd: cwd,
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
    // Try to parse the JSON output
    const trimmed = stdout.trim();
    if (trimmed) {
      output = JSON.parse(trimmed);
    }
  } catch {
    // Output wasn't valid JSON
  }

  return { output, stderr, exitCode };
}

describe("dry-run basic functionality", () => {
  let tempDir: string;
  let tempHome: string;
  let tempProject: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "aegis-dryrun-"));
    tempHome = join(tempDir, "home");
    tempProject = join(tempDir, "project");
    await mkdir(tempHome, { recursive: true });
    await mkdir(tempProject, { recursive: true });
    // Create tool config dirs that would normally exist
    await mkdir(join(tempHome, ".claude"), { recursive: true });
    await writeFile(join(tempHome, ".claude.json"), "{}");
    await mkdir(join(tempHome, ".codex"), { recursive: true });
    await mkdir(join(tempHome, ".gemini"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("outputs JSON with cmd and args for claude", async () => {
    const { output, exitCode } = await runAegisDryRun(
      "cc",
      ["--version"],
      [],
      { HOME: tempHome },
      tempProject
    );

    expect(exitCode).toBe(0);
    expect(output).not.toBeNull();
    expect(output?.cmd).toBe("bwrap");
    expect(Array.isArray(output?.args)).toBe(true);
    // Verify the cwd is correctly reflected in bwrap args
    if (output?.args) {
      expect(output.args).toContain(tempProject);
    }
  });

  test("outputs JSON with cmd and args for codex", async () => {
    const { output, exitCode } = await runAegisDryRun(
      "codex",
      ["--version"],
      [],
      { HOME: tempHome },
      tempProject
    );

    expect(exitCode).toBe(0);
    expect(output).not.toBeNull();
    expect(output?.cmd).toBe("bwrap");
  });

  test("outputs JSON with cmd and args for gemini", async () => {
    const { output, exitCode } = await runAegisDryRun(
      "gemini",
      ["--version"],
      [],
      { HOME: tempHome },
      tempProject
    );

    expect(exitCode).toBe(0);
    expect(output).not.toBeNull();
    expect(output?.cmd).toBe("bwrap");
  });
});

describe("dry-run YOLO flag normalization", () => {
  let tempDir: string;
  let tempHome: string;
  let tempProject: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "aegis-dryrun-"));
    tempHome = join(tempDir, "home");
    tempProject = join(tempDir, "project");
    await mkdir(tempHome, { recursive: true });
    await mkdir(tempProject, { recursive: true });
    await mkdir(join(tempHome, ".claude"), { recursive: true });
    await writeFile(join(tempHome, ".claude.json"), "{}");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("injects claude YOLO flag in args", async () => {
    const { output, exitCode } = await runAegisDryRun(
      "cc",
      ["--version"],
      [],
      { HOME: tempHome },
      tempProject
    );

    expect(exitCode).toBe(0);
    expect(output?.args).toContain("--dangerously-skip-permissions");
  });

  test("dedupes claude YOLO flag if provided", async () => {
    const { output, exitCode } = await runAegisDryRun(
      "cc",
      ["--dangerously-skip-permissions", "--version"],
      [],
      { HOME: tempHome },
      tempProject
    );

    expect(exitCode).toBe(0);
    // Should appear exactly once
    const count =
      output?.args.filter((a) => a === "--dangerously-skip-permissions")
        .length ?? 0;
    expect(count).toBe(1);
  });

  test("injects codex YOLO flag in args", async () => {
    const { output, exitCode } = await runAegisDryRun(
      "codex",
      ["--version"],
      [],
      { HOME: tempHome },
      tempProject
    );

    expect(exitCode).toBe(0);
    expect(output?.args).toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  test("injects gemini YOLO flag in args", async () => {
    const { output, exitCode } = await runAegisDryRun(
      "gemini",
      ["--version"],
      [],
      { HOME: tempHome },
      tempProject
    );

    expect(exitCode).toBe(0);
    expect(output?.args).toContain("--yolo");
  });
});

describe("dry-run aegis flags not forwarded", () => {
  let tempDir: string;
  let tempHome: string;
  let tempHide: string;
  let tempProject: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "aegis-dryrun-"));
    tempHome = join(tempDir, "home");
    tempHide = join(tempDir, "hidden");
    tempProject = join(tempDir, "project");
    await mkdir(tempHome, { recursive: true });
    await mkdir(tempHide, { recursive: true });
    await mkdir(tempProject, { recursive: true });
    await mkdir(join(tempHome, ".claude"), { recursive: true });
    await writeFile(join(tempHome, ".claude.json"), "{}");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("--hide-home flag is not passed to tool", async () => {
    const { output, exitCode } = await runAegisDryRun(
      "cc",
      ["--version"],
      ["--hide-home"],
      { HOME: tempHome },
      tempProject
    );

    expect(exitCode).toBe(0);
    // --hide-home should affect bwrap args but not be passed to claude
    expect(output?.args).not.toContain("--hide-home");
  });

  test("--hide flag is not passed to tool", async () => {
    const { output, exitCode } = await runAegisDryRun(
      "cc",
      ["--version"],
      ["--hide", tempHide],
      { HOME: tempHome },
      tempProject
    );

    expect(exitCode).toBe(0);
    // --hide should not appear in args
    expect(output?.args.includes("--hide")).toBe(false);
  });

  test("--dry-run flag is not passed to tool", async () => {
    const { output, exitCode } = await runAegisDryRun(
      "cc",
      ["--version"],
      [],
      { HOME: tempHome },
      tempProject
    );

    expect(exitCode).toBe(0);
    expect(output?.args).not.toContain("--dry-run");
  });
});

describe("dry-run bwrap base flags", () => {
  let tempDir: string;
  let tempHome: string;
  let tempProject: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "aegis-dryrun-"));
    tempHome = join(tempDir, "home");
    tempProject = join(tempDir, "project");
    await mkdir(tempHome, { recursive: true });
    await mkdir(tempProject, { recursive: true });
    await mkdir(join(tempHome, ".claude"), { recursive: true });
    await writeFile(join(tempHome, ".claude.json"), "{}");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("includes base bwrap flags", async () => {
    const { output, exitCode } = await runAegisDryRun(
      "cc",
      ["--version"],
      [],
      { HOME: tempHome },
      tempProject
    );

    expect(exitCode).toBe(0);
    const args = output?.args ?? [];
    expect(args).toContain("--die-with-parent");
    expect(args).toContain("--ro-bind");
    expect(args).toContain("--dev");
    expect(args).toContain("--proc");
    expect(args).toContain("--tmpfs");
  });

  test("includes cwd bind", async () => {
    const { output, exitCode } = await runAegisDryRun(
      "cc",
      ["--version"],
      [],
      { HOME: tempHome },
      tempProject
    );

    expect(exitCode).toBe(0);
    const args = output?.args ?? [];
    // Should bind current working directory
    expect(args).toContain("--bind");
    expect(args).toContain("--chdir");
    // Verify the explicit cwd is bound
    expect(args).toContain(tempProject);
  });
});

describe("dry-run --hide-home mode", () => {
  let tempDir: string;
  let tempHome: string;
  let tempProject: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "aegis-dryrun-"));
    tempHome = join(tempDir, "home");
    tempProject = join(tempDir, "project");
    await mkdir(tempHome, { recursive: true });
    await mkdir(tempProject, { recursive: true });
    await mkdir(join(tempHome, ".claude"), { recursive: true });
    await writeFile(join(tempHome, ".claude.json"), "{}");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("--hide-home includes tmpfs for HOME", async () => {
    const { output, exitCode } = await runAegisDryRun(
      "cc",
      ["--version"],
      ["--hide-home"],
      { HOME: tempHome },
      tempProject
    );

    expect(exitCode).toBe(0);
    const args = output?.args ?? [];
    // Should have tmpfs for home
    const tmpfsIdx = args.indexOf("--tmpfs");
    expect(tmpfsIdx).not.toBe(-1);
    // One of the tmpfs should be for HOME (may also have /tmp)
    let foundHomeTmpfs = false;
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "--tmpfs" && args[i + 1] === tempHome) {
        foundHomeTmpfs = true;
        break;
      }
    }
    expect(foundHomeTmpfs).toBe(true);
  });

  test("--hide-home still has tool config binds", async () => {
    const { output, exitCode } = await runAegisDryRun(
      "cc",
      ["--version"],
      ["--hide-home"],
      { HOME: tempHome },
      tempProject
    );

    expect(exitCode).toBe(0);
    const args = output?.args ?? [];
    // Should still bind .claude and .claude.json
    expect(args).toContain(join(tempHome, ".claude"));
    expect(args).toContain(join(tempHome, ".claude.json"));
  });
});

describe("dry-run --hide paths", () => {
  let tempDir: string;
  let tempHome: string;
  let tempHide1: string;
  let tempHide2: string;
  let tempProject: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "aegis-dryrun-"));
    tempHome = join(tempDir, "home");
    tempHide1 = join(tempDir, "hide1");
    tempHide2 = join(tempDir, "hide2");
    tempProject = join(tempDir, "project");
    await mkdir(tempHome, { recursive: true });
    await mkdir(tempHide1, { recursive: true });
    await mkdir(tempHide2, { recursive: true });
    await mkdir(tempProject, { recursive: true });
    await mkdir(join(tempHome, ".claude"), { recursive: true });
    await writeFile(join(tempHome, ".claude.json"), "{}");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("--hide creates overlay for hidden path", async () => {
    const { output, exitCode } = await runAegisDryRun(
      "cc",
      ["--version"],
      ["--hide", tempHide1],
      { HOME: tempHome },
      tempProject
    );

    expect(exitCode).toBe(0);
    const args = output?.args ?? [];
    // Hidden path should appear as a target in ro-bind
    expect(args).toContain(tempHide1);
  });

  test("multiple --hide flags create multiple overlays", async () => {
    const { output, exitCode } = await runAegisDryRun(
      "cc",
      ["--version"],
      ["--hide", tempHide1, "--hide", tempHide2],
      { HOME: tempHome },
      tempProject
    );

    expect(exitCode).toBe(0);
    const args = output?.args ?? [];
    expect(args).toContain(tempHide1);
    expect(args).toContain(tempHide2);
  });
});

describe("dry-run error cases", () => {
  let tempDir: string;
  let tempHome: string;
  let tempProject: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "aegis-dryrun-"));
    tempHome = join(tempDir, "home");
    tempProject = join(tempDir, "project");
    await mkdir(tempHome, { recursive: true });
    await mkdir(tempProject, { recursive: true });
    await mkdir(join(tempHome, ".claude"), { recursive: true });
    await writeFile(join(tempHome, ".claude.json"), "{}");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("fails with invalid tool name", async () => {
    const { output, stderr, exitCode } = await runAegisDryRun(
      "invalidtool",
      [],
      [],
      { HOME: tempHome },
      tempProject
    );

    expect(exitCode).not.toBe(0);
    expect(output).toBeNull();
  });

  test("fails with non-existent hide path", async () => {
    const nonExistent = join(tempDir, "does-not-exist");
    const { output, stderr, exitCode } = await runAegisDryRun(
      "cc",
      [],
      ["--hide", nonExistent],
      { HOME: tempHome },
      tempProject
    );

    expect(exitCode).not.toBe(0);
    // Should mention the bad path in error
    expect(stderr).toContain(nonExistent);
  });

  test("fails when hide path is a file not directory", async () => {
    const filePath = join(tempDir, "notadir.txt");
    await writeFile(filePath, "content");

    const { output, stderr, exitCode } = await runAegisDryRun(
      "cc",
      [],
      ["--hide", filePath],
      { HOME: tempHome },
      tempProject
    );

    expect(exitCode).not.toBe(0);
    expect(stderr.toLowerCase()).toContain("directory");
  });
});

describe("dry-run config integration", () => {
  let tempDir: string;
  let tempHome: string;
  let tempConfig: string;
  let tempHide: string;
  let tempProject: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "aegis-dryrun-"));
    tempHome = join(tempDir, "home");
    tempConfig = join(tempDir, "config");
    tempHide = join(tempDir, "configured-hide");
    tempProject = join(tempDir, "project");
    await mkdir(tempHome, { recursive: true });
    await mkdir(tempConfig, { recursive: true });
    await mkdir(tempHide, { recursive: true });
    await mkdir(tempProject, { recursive: true });
    await mkdir(join(tempHome, ".claude"), { recursive: true });
    await writeFile(join(tempHome, ".claude.json"), "{}");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("respects hideHomeAlways from config", async () => {
    // Create config with hideHomeAlways: true
    const aegisConfigDir = join(tempConfig, "aegis");
    await mkdir(aegisConfigDir, { recursive: true });
    await writeFile(
      join(aegisConfigDir, "config.json"),
      JSON.stringify({ hideHomeAlways: true, hide: [] })
    );

    const { output, exitCode } = await runAegisDryRun(
      "cc",
      ["--version"],
      [],
      { HOME: tempHome, XDG_CONFIG_HOME: tempConfig },
      tempProject
    );

    expect(exitCode).toBe(0);
    const args = output?.args ?? [];
    // Should have tmpfs for HOME due to config
    let foundHomeTmpfs = false;
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "--tmpfs" && args[i + 1] === tempHome) {
        foundHomeTmpfs = true;
        break;
      }
    }
    expect(foundHomeTmpfs).toBe(true);
  });

  test("merges config.hide with CLI --hide", async () => {
    const configHide = join(tempDir, "config-hide");
    const cliHide = join(tempDir, "cli-hide");
    await mkdir(configHide, { recursive: true });
    await mkdir(cliHide, { recursive: true });

    const aegisConfigDir = join(tempConfig, "aegis");
    await mkdir(aegisConfigDir, { recursive: true });
    await writeFile(
      join(aegisConfigDir, "config.json"),
      JSON.stringify({ hideHomeAlways: false, hide: [configHide] })
    );

    const { output, exitCode } = await runAegisDryRun(
      "cc",
      ["--version"],
      ["--hide", cliHide],
      { HOME: tempHome, XDG_CONFIG_HOME: tempConfig },
      tempProject
    );

    expect(exitCode).toBe(0);
    const args = output?.args ?? [];
    // Both should be hidden
    expect(args).toContain(configHide);
    expect(args).toContain(cliHide);
  });

  test("silently skips non-existent config.hide entries", async () => {
    const aegisConfigDir = join(tempConfig, "aegis");
    await mkdir(aegisConfigDir, { recursive: true });
    await writeFile(
      join(aegisConfigDir, "config.json"),
      JSON.stringify({
        hideHomeAlways: false,
        hide: ["/this/path/does/not/exist"],
      })
    );

    const { output, exitCode } = await runAegisDryRun(
      "cc",
      ["--version"],
      [],
      { HOME: tempHome, XDG_CONFIG_HOME: tempConfig },
      tempProject
    );

    // Config paths are lenient — non-existent paths are silently skipped
    expect(exitCode).toBe(0);
    expect(output).not.toBeNull();
    // The non-existent path should NOT appear in bwrap args
    expect(output?.args).not.toContain("/this/path/does/not/exist");
  });
});

describe("dry-run MUST NOT execute bwrap", () => {
  let tempDir: string;
  let tempHome: string;
  let tempProject: string;
  let sentinelPath: string;
  const FIXTURES_BIN_BWRAP = resolve(__dirname, "../fixtures/bin-bwrap");

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "aegis-dryrun-noop-"));
    tempHome = join(tempDir, "home");
    tempProject = join(tempDir, "project");
    sentinelPath = join(tempDir, "bwrap-was-called.sentinel");

    await mkdir(tempHome, { recursive: true });
    await mkdir(tempProject, { recursive: true });
    await mkdir(join(tempHome, ".claude"), { recursive: true });
    await writeFile(join(tempHome, ".claude.json"), "{}");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("--dry-run does not invoke bwrap (sentinel-based proof)", async () => {
    // Prepend our fixtures bin (with fake-bwrap) to PATH
    const newPath = `${FIXTURES_BIN_BWRAP}:${process.env.PATH}`;

    const proc = spawn({
      cmd: [
        "bun",
        "run",
        AEGIS_PATH,
        "cc",
        "--dry-run",
        "--version",
      ],
      env: {
        ...process.env,
        HOME: tempHome,
        PATH: newPath,
        AEGIS_BWRAP_SENTINEL: sentinelPath,
      },
      cwd: tempProject,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;

    // dry-run should succeed (exit 0), not exit 99 from fake-bwrap
    expect(exitCode).toBe(0);

    // Sentinel file should NOT exist (bwrap was not called)
    const sentinelExists = await Bun.file(sentinelPath).exists();
    expect(sentinelExists).toBe(false);

    // Should output valid JSON (dry-run output)
    const trimmed = stdout.trim();
    expect(trimmed.length).toBeGreaterThan(0);
    const parsed = JSON.parse(trimmed);
    expect(parsed.cmd).toBe("bwrap");
  });

  test("--dry-run with --hide-home does not invoke bwrap", async () => {
    const newPath = `${FIXTURES_BIN_BWRAP}:${process.env.PATH}`;

    const proc = spawn({
      cmd: [
        "bun",
        "run",
        AEGIS_PATH,
        "cc",
        "--dry-run",
        "--hide-home",
        "--version",
      ],
      env: {
        ...process.env,
        HOME: tempHome,
        PATH: newPath,
        AEGIS_BWRAP_SENTINEL: sentinelPath,
      },
      cwd: tempProject,
      // Use "ignore" since we only check exitCode and sentinel file
      // This avoids potential stream buffer deadlocks
      stdout: "ignore",
      stderr: "ignore",
    });

    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);

    const sentinelExists = await Bun.file(sentinelPath).exists();
    expect(sentinelExists).toBe(false);
  });

  test("--dry-run with --hide does not invoke bwrap", async () => {
    const tempHide = join(tempDir, "hideme");
    await mkdir(tempHide, { recursive: true });
    const newPath = `${FIXTURES_BIN_BWRAP}:${process.env.PATH}`;

    const proc = spawn({
      cmd: [
        "bun",
        "run",
        AEGIS_PATH,
        "cc",
        "--dry-run",
        "--hide",
        tempHide,
        "--version",
      ],
      env: {
        ...process.env,
        HOME: tempHome,
        PATH: newPath,
        AEGIS_BWRAP_SENTINEL: sentinelPath,
      },
      cwd: tempProject,
      // Use "ignore" since we only check exitCode and sentinel file
      // This avoids potential stream buffer deadlocks
      stdout: "ignore",
      stderr: "ignore",
    });

    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);

    const sentinelExists = await Bun.file(sentinelPath).exists();
    expect(sentinelExists).toBe(false);
  });
});
