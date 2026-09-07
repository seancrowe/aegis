/**
 * Layer 2: CLI dry-run integration tests.
 * These tests run aegis as a child process with --dry-run and verify the output.
 * No actual bubblewrap execution occurs.
 */
import { describe as _describe, test, expect, beforeEach, afterEach } from "bun:test";
import { appendFile, mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawn } from "bun";
import { seedCatalogConfigForHome } from "../utils/catalogConfig";
import { OVERLAY_PREFIX } from "../../src/sandbox/bwrap";

// These tests assert the bwrap argv shape, so they only run on Linux.
// The sandbox-exec (macOS) dry-run path is covered by sandboxExecDryRun.test.ts.
const describe = process.platform === "linux" ? _describe : _describe.skip;

const AEGIS_PATH = resolve(__dirname, "../../src/main.ts");
const CLAUDE_TOOL_TOML = `
[tools.claude]
name = "claude code"
cliCmd = "claude"
yoloArg = "--dangerously-skip-permissions"
rwDirs = [".claude"]
rwFiles = [".claude.json"]
`;
const REJECTED_WRITABLE_PATHS = [
  "~", "~/", "~/.", "~/./", "~//", "~/..", "~/../..", "~/x/../",
  "~/a/..//", "~/../shared", "~//../etc", "~//../../etc",
  "~///../../../tmp", "/", "/Users/../..", "foo", "../../..",
];
const ACCEPTED_WRITABLE_PATHS = [
  "~/.npm",
  "~/a/../b",
  "~/Library/Caches",
  "~/foo/",
  "/Users/user",
  "/opt/cache",
];

interface DryRunOutput {
  cmd: string;
  args: string[];
}

function containsSequence(values: string[], sequence: string[]): boolean {
  return values.some((_, index) =>
    sequence.every((value, offset) => values[index + offset] === value)
  );
}

/**
 * Build the child-process environment for a spawned aegis run.
 *
 * Tests routinely override only HOME, expecting the child to be fully
 * isolated from the developer's machine. But aegis resolves its config
 * directory from XDG_CONFIG_HOME, and loadConfig() scaffolds a config file
 * when none exists -- so a developer with XDG_CONFIG_HOME exported in their
 * shell would have these tests read from (and write into) their real config
 * directory. Derive XDG_CONFIG_HOME from the overridden HOME so that
 * "override HOME" means what every call site already assumes it means.
 *
 * An explicit XDG_CONFIG_HOME from the caller always wins.
 */
export function buildChildEnv(
  env: Record<string, string>
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = {
    ...process.env,
    ...env,
  };
  if (env.HOME !== undefined && env.XDG_CONFIG_HOME === undefined) {
    merged.XDG_CONFIG_HOME = join(env.HOME, ".config");
  }
  return merged;
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
    env: buildChildEnv(env),
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

// Platform-independent: this guards the test harness itself, not bwrap argv.
_describe("child env isolation", () => {
  test("derives XDG_CONFIG_HOME from an overridden HOME", () => {
    const merged = buildChildEnv({ HOME: "/tmp/fake-home" });
    expect(merged.XDG_CONFIG_HOME).toBe(join("/tmp/fake-home", ".config"));
  });

  test("an explicit XDG_CONFIG_HOME wins over the derived one", () => {
    const merged = buildChildEnv({
      HOME: "/tmp/fake-home",
      XDG_CONFIG_HOME: "/tmp/explicit-config",
    });
    expect(merged.XDG_CONFIG_HOME).toBe("/tmp/explicit-config");
  });

  test("leaves the inherited XDG_CONFIG_HOME alone when HOME is not overridden", () => {
    const merged = buildChildEnv({ PATH: "/nowhere" });
    expect(merged.XDG_CONFIG_HOME).toBe(process.env.XDG_CONFIG_HOME);
    expect(merged.HOME).toBe(process.env.HOME);
  });
});

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
    // The first-run scaffold configures no tools, so opt the catalog in
    // before `aegis <tool>` has a subcommand to dispatch.
    await seedCatalogConfigForHome(tempHome);
    await mkdir(join(tempHome, ".codex"), { recursive: true });
    await mkdir(join(tempHome, ".gemini"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("outputs JSON with cmd and args for claude", async () => {
    const { output, exitCode } = await runAegisDryRun(
      "claude",
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

  test("rejects a hide covering the working directory", async () => {
    const { output, stderr, exitCode } = await runAegisDryRun(
      "claude",
      [],
      ["--hide", "."],
      { HOME: tempHome },
      tempProject
    );

    expect(exitCode).toBe(1);
    expect(output).toBeNull();
    expect(stderr).toContain("covers the working directory");
  });

  test("rejects a configured hide covering a tool config path", async () => {
    await writeFile(
      join(tempHome, ".config", "aegis", "config.toml"),
      `hideHomeAlways = false
hide = []

[tools.claude]
name = "claude code"
cliCmd = "claude"
rwDirs = [".claude"]
hide = ["~/.claude"]
`
    );

    const { output, stderr, exitCode } = await runAegisDryRun(
      "claude",
      [],
      [],
      { HOME: tempHome },
      tempProject
    );

    expect(exitCode).toBe(1);
    expect(output).toBeNull();
    expect(stderr).toContain("covers tool config path");
  });

  test("warns when a writable grant is shadowed without polluting stdout", async () => {
    await mkdir(join(tempHome, ".ssh"));
    const { output, stderr, exitCode } = await runAegisDryRun(
      "claude",
      [],
      ["-w", join(tempHome, ".ssh")],
      { HOME: tempHome },
      tempProject
    );

    expect(exitCode).toBe(0);
    expect(stderr).toContain("and has no effect");
    expect(output).not.toBeNull();
  });

  test("rejects every unsafe CLI -w spelling before expansion", async () => {
    for (const path of REJECTED_WRITABLE_PATHS) {
      const { output, stderr, exitCode } = await runAegisDryRun(
        "claude",
        ["--version"],
        ["-w", path],
        { HOME: tempHome },
        tempProject
      );
      expect(exitCode).not.toBe(0);
      expect(output).toBeNull();
      expect(stderr).toContain(`Invalid writable path:`);
      expect(stderr).toContain(JSON.stringify(path));
    }
  });

  test("accepts every safe CLI -w spelling", async () => {
    for (const path of ACCEPTED_WRITABLE_PATHS) {
      const { output, exitCode } = await runAegisDryRun(
        "claude",
        ["--version"],
        ["-w", path],
        { HOME: tempHome },
        tempProject
      );
      expect(exitCode).toBe(0);
      expect(output?.cmd).toBe("bwrap");
    }
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
    // The first-run scaffold configures no tools, so opt the catalog in
    // before `aegis <tool>` has a subcommand to dispatch.
    await seedCatalogConfigForHome(tempHome);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("injects claude YOLO flag in args", async () => {
    const { output, exitCode } = await runAegisDryRun(
      "claude",
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
      "claude",
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
    // The first-run scaffold configures no tools, so opt the catalog in
    // before `aegis <tool>` has a subcommand to dispatch.
    await seedCatalogConfigForHome(tempHome);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("--hide-home flag is not passed to tool", async () => {
    const { output, exitCode } = await runAegisDryRun(
      "claude",
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
      "claude",
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
      "claude",
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
    // The first-run scaffold configures no tools, so opt the catalog in
    // before `aegis <tool>` has a subcommand to dispatch.
    await seedCatalogConfigForHome(tempHome);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("includes base bwrap flags", async () => {
    const { output, exitCode } = await runAegisDryRun(
      "claude",
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
      "claude",
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

describe("dry-run non-hideHome bind and ro-binds", () => {
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
    // The first-run scaffold configures no tools, so opt the catalog in
    // before `aegis <tool>` has a subcommand to dispatch.
    await seedCatalogConfigForHome(tempHome);
    // Add extra dotfiles to verify ro-bind
    await writeFile(join(tempHome, ".bashrc"), "# bashrc");
    await mkdir(join(tempHome, ".config"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("non-hideHome includes --bind for HOME", async () => {
    const { output, exitCode } = await runAegisDryRun(
      "claude",
      ["--version"],
      [],
      { HOME: tempHome },
      tempProject
    );

    expect(exitCode).toBe(0);
    const args = output?.args ?? [];
    let foundHomeBind = false;
    for (let i = 0; i < args.length - 2; i++) {
      if (args[i] === "--bind" && args[i + 1] === tempHome && args[i + 2] === tempHome) {
        foundHomeBind = true;
        break;
      }
    }
    expect(foundHomeBind).toBe(true);
  });

  test("non-hideHome includes ro-bind for home entries", async () => {
    const { output, exitCode } = await runAegisDryRun(
      "claude",
      ["--version"],
      [],
      { HOME: tempHome },
      tempProject
    );

    expect(exitCode).toBe(0);
    const args = output?.args ?? [];

    // .bashrc and .config should be ro-bound
    const bashrcRoBind = args.some((a, i) =>
      a === "--ro-bind" &&
      args[i + 1] === join(tempHome, ".bashrc") &&
      args[i + 2] === join(tempHome, ".bashrc")
    );
    const configRoBind = args.some((a, i) =>
      a === "--ro-bind" &&
      args[i + 1] === join(tempHome, ".config") &&
      args[i + 2] === join(tempHome, ".config")
    );

    expect(bashrcRoBind).toBe(true);
    expect(configRoBind).toBe(true);
  });

  test("non-hideHome: dir rwPaths are ro-bound then overridden; file rwPaths are neither", async () => {
    const { output, exitCode } = await runAegisDryRun(
      "claude",
      ["--version"],
      [],
      { HOME: tempHome },
      tempProject
    );

    expect(exitCode).toBe(0);
    const args = output?.args ?? [];

    // .claude dir should appear as both --ro-bind (from homeEntries) and --bind (RW from rwPaths)
    const claudeRoBind = args.some((a, i) =>
      a === "--ro-bind" &&
      args[i + 1] === join(tempHome, ".claude") &&
      args[i + 2] === join(tempHome, ".claude")
    );
    const claudeRwBind = args.some((a, i) =>
      a === "--bind" &&
      args[i + 1] === join(tempHome, ".claude") &&
      args[i + 2] === join(tempHome, ".claude")
    );

    expect(claudeRoBind).toBe(true);
    expect(claudeRwBind).toBe(true);

    // .claude.json (file rwPath, direct child) should NOT be individually bound or ro-bound
    // — it stays writable as part of --bind $HOME to enable atomic writes
    const claudeJsonBind = args.some((a, i) =>
      a === "--bind" &&
      args[i + 1] === join(tempHome, ".claude.json") &&
      args[i + 2] === join(tempHome, ".claude.json")
    );
    const claudeJsonRoBind = args.some((a, i) =>
      a === "--ro-bind" &&
      args[i + 1] === join(tempHome, ".claude.json") &&
      args[i + 2] === join(tempHome, ".claude.json")
    );

    expect(claudeJsonBind).toBe(false);
    expect(claudeJsonRoBind).toBe(false);
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
    // The first-run scaffold configures no tools, so opt the catalog in
    // before `aegis <tool>` has a subcommand to dispatch.
    await seedCatalogConfigForHome(tempHome);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("--hide-home includes tmpfs for HOME", async () => {
    const { output, exitCode } = await runAegisDryRun(
      "claude",
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
      "claude",
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
    // The first-run scaffold configures no tools, so opt the catalog in
    // before `aegis <tool>` has a subcommand to dispatch.
    await seedCatalogConfigForHome(tempHome);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("--hide creates overlay for hidden path", async () => {
    const { output, exitCode } = await runAegisDryRun(
      "claude",
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

  test("relative --hide resolves against cwd before bwrap emission", async () => {
    const relativeHide = "relative-hide";
    const absoluteHide = join(tempProject, relativeHide);
    await mkdir(absoluteHide);

    const { output, exitCode } = await runAegisDryRun(
      "claude",
      ["--version"],
      ["--hide", relativeHide],
      { HOME: tempHome },
      tempProject
    );

    expect(exitCode).toBe(0);
    expect(output?.args).toContain(absoluteHide);
    expect(output?.args).not.toContain(relativeHide);
  });

  test("quoted tilde --hide expands using HOME", async () => {
    const ssh = join(tempHome, ".ssh");
    await mkdir(ssh);

    const { output, exitCode } = await runAegisDryRun(
      "claude",
      ["--version"],
      ["--hide", "~/.ssh"],
      { HOME: tempHome },
      tempProject
    );

    expect(exitCode).toBe(0);
    expect(output?.args).toContain(ssh);
    expect(output?.args).not.toContain("~/.ssh");
  });

  test("rejects home/root --hide spelling before filesystem probing", async () => {
    const { output, stderr, exitCode } = await runAegisDryRun(
      "claude",
      ["--version"],
      ["--hide", "~/../.."],
      { HOME: tempHome },
      tempProject
    );

    expect(exitCode).not.toBe(0);
    expect(output).toBeNull();
    expect(stderr).toContain(
      "Invalid hide path: traversal outside $HOME is not allowed"
    );
    expect(stderr).not.toContain("Path does not exist");
  });

  test("multiple --hide flags create multiple overlays", async () => {
    const { output, exitCode } = await runAegisDryRun(
      "claude",
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
    // The first-run scaffold configures no tools, so opt the catalog in
    // before `aegis <tool>` has a subcommand to dispatch.
    await seedCatalogConfigForHome(tempHome);
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
      "claude",
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
      "claude",
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
    // The first-run scaffold configures no tools, so opt the catalog in
    // before `aegis <tool>` has a subcommand to dispatch.
    await seedCatalogConfigForHome(tempHome);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("respects hideHomeAlways from config", async () => {
    // Create config with hideHomeAlways: true
    const aegisConfigDir = join(tempConfig, "aegis");
    await mkdir(aegisConfigDir, { recursive: true });
    await writeFile(
      join(aegisConfigDir, "config.toml"),
      `hideHomeAlways = true\nhide = []\n${CLAUDE_TOOL_TOML}`
    );

    const { output, exitCode } = await runAegisDryRun(
      "claude",
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

  test("homeAccess allowlist masks home, RO-binds allowRead, and still applies config.hide", async () => {
    const readable = join(tempHome, "readable");
    const legacyHide = join(tempHome, "legacy-hide");
    await mkdir(readable, { recursive: true });
    await mkdir(legacyHide, { recursive: true });
    const aegisConfigDir = join(tempConfig, "aegis");
    await mkdir(aegisConfigDir, { recursive: true });
    await writeFile(
      join(aegisConfigDir, "config.toml"),
      `hideHomeAlways = false
homeAccess = "allowlist"
hide = [${JSON.stringify(legacyHide)}]
allowRead = ["~/readable"]
${CLAUDE_TOOL_TOML}`
    );

    const { output, exitCode } = await runAegisDryRun(
      "claude",
      ["--version"],
      [],
      { HOME: tempHome, XDG_CONFIG_HOME: tempConfig },
      tempProject
    );
    expect(exitCode).toBe(0);
    const args = output?.args ?? [];
    expect(containsSequence(args, ["--tmpfs", tempHome])).toBe(true);
    expect(containsSequence(args, ["--ro-bind", readable, readable])).toBe(true);
    // The mask already covers this entry, so the overlay is redundant here —
    // but hide is applied in both modes on purpose, so that allowlist mode can
    // never silently loosen an explicit deny. See the rationale in main.ts.
    expect(args).toContain(legacyHide);
  });

  test("merges config.hide with CLI --hide", async () => {
    const configHide = join(tempDir, "config-hide");
    const cliHide = join(tempDir, "cli-hide");
    await mkdir(configHide, { recursive: true });
    await mkdir(cliHide, { recursive: true });

    const aegisConfigDir = join(tempConfig, "aegis");
    await mkdir(aegisConfigDir, { recursive: true });
    await writeFile(
      join(aegisConfigDir, "config.toml"),
      `hideHomeAlways = false\nhide = [${JSON.stringify(configHide)}]\n${CLAUDE_TOOL_TOML}`
    );

    const { output, exitCode } = await runAegisDryRun(
      "claude",
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
      join(aegisConfigDir, "config.toml"),
      `hideHomeAlways = false\nhide = ["/this/path/does/not/exist"]\n${CLAUDE_TOOL_TOML}`
    );

    const { output, exitCode } = await runAegisDryRun(
      "claude",
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

describe("project policy", () => {
  let tempDir: string;
  let tempHome: string;
  let configPath: string;
  let proj: string;
  let sub: string;
  let other: string;
  let cache: string;
  let secret: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "aegis-project-policy-"));
    tempHome = join(tempDir, "home");
    proj = join(tempHome, "proj");
    sub = join(proj, "sub");
    other = join(tempHome, "other");
    cache = join(tempHome, "cache");
    secret = join(tempHome, "secret");
    await mkdir(join(tempHome, ".claude"), { recursive: true });
    await writeFile(join(tempHome, ".claude.json"), "{}");
    for (const path of [sub, other, cache, secret]) {
      await mkdir(path, { recursive: true });
    }
    configPath = await seedCatalogConfigForHome(tempHome);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function appendProjectConfig(config: string): Promise<void> {
    await appendFile(configPath, `\n${config}`);
  }

  /** Index of a bind whose source and target are both `path`. */
  function bindIndex(args: string[], flag: string, path: string): number {
    return args.findIndex(
      (value, index) =>
        value === flag && args[index + 1] === path && args[index + 2] === path
    );
  }

  /**
   * Index of the hide overlay for `path`. Matching the target alone is not
   * enough: in non-hideHome mode every top-level $HOME entry is re-bound
   * read-only over itself first, so a hidden direct child of $HOME would
   * match that re-bind instead. The overlay is the one whose SOURCE is the
   * empty dir.
   */
  function hideIndex(args: string[], path: string): number {
    return args.findIndex(
      (value, index) =>
        value === "--ro-bind" &&
        args[index + 2] === path &&
        basename(args[index + 1] ?? "").startsWith(OVERLAY_PREFIX)
    );
  }

  test("reports when no project blocks are configured", async () => {
    const { output, stderr } = await runAegisDryRun(
      "claude",
      ["--version"],
      [],
      { HOME: tempHome },
      proj
    );
    expect(output).not.toBeNull();
    expect(stderr).toContain("project policy: none configured");
  });

  test("reports when no project block matches", async () => {
    await appendProjectConfig(`[projects."~/proj"]\n`);

    const { output, stderr } = await runAegisDryRun(
      "claude",
      ["--version"],
      [],
      { HOME: tempHome },
      other
    );
    expect(output).not.toBeNull();
    expect(stderr).toContain("no [projects.*] block matches");
  });

  test("reports the matching project block", async () => {
    await appendProjectConfig(`[projects."~/proj"]\n`);

    const { output, stderr } = await runAegisDryRun(
      "claude",
      ["--version"],
      [],
      { HOME: tempHome },
      sub
    );
    expect(output).not.toBeNull();
    expect(stderr).toContain('matched [projects."~/proj"]');
  });

  test("reports nested matching project blocks outermost first", async () => {
    await appendProjectConfig(`[projects."~/proj"]

[projects."~/proj/sub"]
`);

    const { output, stderr } = await runAegisDryRun(
      "claude",
      ["--version"],
      [],
      { HOME: tempHome },
      sub
    );
    expect(output).not.toBeNull();
    expect(stderr).toContain(
      'matched [projects."~/proj"], [projects."~/proj/sub"]'
    );
  });

  test("reports project blocks whose directories do not exist", async () => {
    await appendProjectConfig(`[projects."~/does-not-exist"]\n`);

    const { output, stderr } = await runAegisDryRun(
      "claude",
      ["--version"],
      [],
      { HOME: tempHome },
      other
    );
    expect(output).not.toBeNull();
    expect(stderr).toContain(
      '"~/does-not-exist" does not exist on disk and never matches'
    );
  });

  test("applies extraWritable and hide only inside the project", async () => {
    await appendProjectConfig(`[projects."~/proj"]
extraWritable = ["~/cache"]
hide = ["~/secret"]
`);

    const matched = await runAegisDryRun(
      "claude",
      ["--version"],
      [],
      { HOME: tempHome },
      sub
    );
    expect(matched.exitCode).toBe(0);
    expect(
      containsSequence(matched.output?.args ?? [], ["--bind", cache, cache])
    ).toBe(true);
    expect(
      hideIndex(matched.output?.args ?? [], secret)
    ).toBeGreaterThanOrEqual(0);

    const unmatched = await runAegisDryRun(
      "claude",
      ["--version"],
      [],
      { HOME: tempHome },
      other
    );
    expect(unmatched.exitCode).toBe(0);
    expect(
      containsSequence(unmatched.output?.args ?? [], ["--bind", cache, cache])
    ).toBe(false);
    expect(hideIndex(unmatched.output?.args ?? [], secret)).toBe(-1);
  });

  test("applies hideHomeAlways only inside the project", async () => {
    await appendProjectConfig(`[projects."~/proj"]
hideHomeAlways = true
`);

    const matched = await runAegisDryRun(
      "claude",
      ["--version"],
      [],
      { HOME: tempHome },
      proj
    );
    expect(matched.exitCode).toBe(0);
    expect(containsSequence(matched.output?.args ?? [], ["--tmpfs", tempHome])).toBe(true);

    const unmatched = await runAegisDryRun(
      "claude",
      ["--version"],
      [],
      { HOME: tempHome },
      other
    );
    expect(unmatched.exitCode).toBe(0);
    expect(containsSequence(unmatched.output?.args ?? [], ["--tmpfs", tempHome])).toBe(false);
  });

  test("re-exposes project allowRead under hideHomeAlways", async () => {
    const docs = join(tempHome, "docs");
    await mkdir(docs);
    await appendProjectConfig(`[projects."~/proj"]
hideHomeAlways = true
allowRead = ["~/docs"]
`);

    const { output, exitCode } = await runAegisDryRun(
      "claude",
      ["--version"],
      [],
      { HOME: tempHome },
      proj
    );
    expect(exitCode).toBe(0);
    expect(
      containsSequence(output?.args ?? [], ["--ro-bind", docs, docs])
    ).toBe(true);
  });

  test(
    "emits a project writable grant before the existing hide overlay",
    async () => {
      const ssh = join(tempHome, ".ssh");
      await mkdir(ssh);
      await appendProjectConfig(`[projects."~/proj"]
extraWritable = ["~/.ssh"]
`);

      const { output, exitCode } = await runAegisDryRun(
        "claude",
        ["--version"],
        [],
        { HOME: tempHome },
        proj
      );
      expect(exitCode).toBe(0);
      const args = output?.args ?? [];
      const allowIndex = bindIndex(args, "--bind", ssh);
      const denyIndex = hideIndex(args, ssh);
      expect(allowIndex).toBeGreaterThanOrEqual(0);
      expect(denyIndex).toBeGreaterThan(allowIndex);
    }
  );

  test("validates missing project hides only when the block matches", async () => {
    await appendProjectConfig(`[projects."~/proj"]
hide = ["~/nope"]
`);

    const matched = await runAegisDryRun(
      "claude",
      ["--version"],
      [],
      { HOME: tempHome },
      proj
    );
    expect(matched.exitCode).toBe(1);
    expect(matched.stderr).toContain(
      'Invalid hide path "~/nope" in project "~/proj"'
    );

    const unmatched = await runAegisDryRun(
      "claude",
      ["--version"],
      [],
      { HOME: tempHome },
      other
    );
    expect(unmatched.exitCode).toBe(0);
  });

  test("warns when a project allowRead is shadowed by a hide", async () => {
    const ssh = join(tempHome, ".ssh");
    await mkdir(ssh, { recursive: true });
    await appendProjectConfig(`[projects."~/proj"]
hideHomeAlways = true
allowRead = ["~/.ssh"]
`);

    const { output, stderr, exitCode } = await runAegisDryRun(
      "claude",
      ["--version"],
      [],
      { HOME: tempHome },
      proj
    );

    expect(exitCode).toBe(0);
    expect(stderr).toContain(
      `aegis: warning: allowRead path "${ssh}" is inside hidden path`
    );
    expect(output).not.toBeNull();
  });

  test("unions nested project blocks", async () => {
    await appendProjectConfig(`[projects."~/proj"]
hide = ["~/secret"]

[projects."~/proj/sub"]
extraWritable = ["~/cache"]
`);

    const { output, exitCode } = await runAegisDryRun(
      "claude",
      ["--version"],
      [],
      { HOME: tempHome },
      sub
    );
    expect(exitCode).toBe(0);
    const args = output?.args ?? [];
    expect(hideIndex(args, secret)).toBeGreaterThanOrEqual(0);
    expect(containsSequence(args, ["--bind", cache, cache])).toBe(true);
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
    // The first-run scaffold configures no tools, so opt the catalog in
    // before `aegis <tool>` has a subcommand to dispatch.
    await seedCatalogConfigForHome(tempHome);
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
        "claude",
        "--dry-run",
        "--version",
      ],
      env: buildChildEnv({
        HOME: tempHome,
        PATH: newPath,
        AEGIS_BWRAP_SENTINEL: sentinelPath,
      }),
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
        "claude",
        "--dry-run",
        "--hide-home",
        "--version",
      ],
      env: buildChildEnv({
        HOME: tempHome,
        PATH: newPath,
        AEGIS_BWRAP_SENTINEL: sentinelPath,
      }),
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
        "claude",
        "--dry-run",
        "--hide",
        tempHide,
        "--version",
      ],
      env: buildChildEnv({
        HOME: tempHome,
        PATH: newPath,
        AEGIS_BWRAP_SENTINEL: sentinelPath,
      }),
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
