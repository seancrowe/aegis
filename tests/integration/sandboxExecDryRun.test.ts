/**
 * macOS sandbox-exec dry-run integration tests.
 * Runs aegis as a child process with --dry-run and verifies the sandbox-exec
 * command + generated SBPL profile. Skipped on non-darwin platforms.
 */
import { describe as _describe, test, expect, beforeEach, afterEach } from "bun:test";
import { chmod, mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "bun";
import { seedCatalogConfigForHome } from "../utils/catalogConfig";

const describe = process.platform === "darwin" ? _describe : _describe.skip;

const AEGIS_PATH = resolve(__dirname, "../../src/main.ts");
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

async function runAegis(
  tool: string,
  toolArgs: string[],
  env: Record<string, string>,
  cwd: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn({
    cmd: ["bun", "run", AEGIS_PATH, tool, ...toolArgs],
    env: { ...process.env, ...env },
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
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
    await seedCatalogConfigForHome(tempHome);
    realProject = realpathSync(tempProject);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("emits a sandbox-exec command with -p and a profile", async () => {
    const { output, exitCode } = await runAegisDryRun(
      "claude",
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
      expect(stderr).toContain("Invalid writable path:");
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
      expect(output?.cmd).toBe("sandbox-exec");
    }
  });

  describe("tool resolution", () => {
    async function configureAndRun(
      cliCmd: string,
      path: string = process.env.PATH ?? ""
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
      const configHome = join(tempDir, "config");
      const fakeBin = join(tempDir, "bin");
      await mkdir(join(configHome, "aegis"), { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      const fakeSandboxExec = join(fakeBin, "sandbox-exec");
      await writeFile(
        fakeSandboxExec,
        '#!/bin/sh\n' +
          'while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\n' +
          '[ "$#" -gt 0 ] || { echo "missing -- separator" >&2; exit 64; }\n' +
          'shift\n' +
          'exec "$@"\n'
      );
      await chmod(fakeSandboxExec, 0o755);
      await writeFile(
        join(configHome, "aegis", "config.toml"),
        `hideHomeAlways = false
hide = []

[tools.probe]
name = "probe"
cliCmd = ${JSON.stringify(cliCmd)}
`
      );
      return runAegis(
        "probe",
        ["resolved"],
        {
          HOME: tempHome,
          XDG_CONFIG_HOME: configHome,
          PATH: `${fakeBin}:${path}`,
        },
        tempProject
      );
    }

    test("an existing absolute cliCmd resolves and runs", async () => {
      const result = await configureAndRun("/bin/echo");
      expect(result).toMatchObject({
        exitCode: 0,
        stdout: "resolved\n",
        stderr: "",
      });
    });

    test("a missing absolute cliCmd errors with the unresolved value", async () => {
      const missing = join(tempDir, "missing-tool");
      const result = await configureAndRun(missing);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe(`${missing} not found in PATH\n`);
    });

    test("a bare cliCmd resolves through PATH and runs", async () => {
      const bareTool = join(tempDir, "bare-bin", "path-probe");
      await mkdir(join(tempDir, "bare-bin"), { recursive: true });
      await writeFile(bareTool, "#!/bin/sh\nprintf 'bare:%s\\n' \"$1\"\n");
      await chmod(bareTool, 0o755);

      const result = await configureAndRun(
        "path-probe",
        `${join(tempDir, "bare-bin")}:${process.env.PATH ?? ""}`
      );
      expect(result).toMatchObject({
        exitCode: 0,
        stdout: "bare:resolved\n",
        stderr: "",
      });
    });

    test("a missing bare cliCmd errors with the unresolved value", async () => {
      const result = await configureAndRun("definitely-missing-aegis-tool");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe(
        "definitely-missing-aegis-tool not found in PATH\n"
      );
    });
  });

  test("profile is read-only root with the cwd writable", async () => {
    const { output } = await runAegisDryRun(
      "claude",
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
      "claude",
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
      "claude",
      ["--version"],
      ["--hide", secret],
      { HOME: tempHome },
      tempProject
    );
    expect(profileOf(output)).toContain(
      `(deny file-read* file-write* (subpath "${secret}"))`
    );
  });

  test("relative --hide resolves against cwd before profile emission", async () => {
    const relativeHide = "relative-secret";
    await mkdir(join(tempProject, relativeHide));

    const { output, exitCode } = await runAegisDryRun(
      "claude",
      ["--version"],
      ["--hide", relativeHide],
      { HOME: tempHome },
      tempProject
    );

    expect(exitCode).toBe(0);
    expect(profileOf(output)).toContain(
      `(deny file-read* file-write* (subpath "${join(realProject, relativeHide)}"))`
    );
    expect(profileOf(output)).not.toContain(
      `(deny file-read* file-write* (subpath "${relativeHide}"))`
    );
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
    expect(profileOf(output)).toContain(
      `(deny file-read* file-write* (subpath "${ssh}"))`
    );
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

  test("missing CLI --hide remains a hard error", async () => {
    const missing = join(tempProject, "missing-hide");
    const { exitCode, stderr } = await runAegisDryRun(
      "claude",
      ["--version"],
      ["--hide", "missing-hide"],
      { HOME: tempHome },
      tempProject
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain(missing);
  });

  test("homeAccess allowlist still enforces hide paths outside $HOME", async () => {
    // The security case. Masking $HOME subsumes hide entries *under* home, but
    // an absolute path elsewhere is not covered by that mask. Dropping it in
    // allowlist mode would mean the stricter-sounding mode silently unhides
    // something the user explicitly listed.
    const configHome = join(tempDir, "config");
    const outsideHide = join(tempDir, "outside-secrets");
    await mkdir(join(configHome, "aegis"), { recursive: true });
    await mkdir(outsideHide, { recursive: true });
    await writeFile(
      join(configHome, "aegis", "config.toml"),
      `hideHomeAlways = false
homeAccess = "allowlist"
hide = []

[tools.claude]
name = "claude code"
cliCmd = "claude"
rwDirs = [".claude"]
hide = [${JSON.stringify(outsideHide)}]
`
    );

    const { output, exitCode } = await runAegisDryRun(
      "claude",
      ["--version"],
      [],
      { HOME: tempHome, XDG_CONFIG_HOME: configHome },
      tempProject
    );
    expect(exitCode).toBe(0);
    // Asserted on the configured spelling, not its realpath: expandHidePaths
    // does not canonicalize, so the rule is emitted exactly as written.
    expect(profileOf(output)).toContain(
      `(deny file-read* file-write* (subpath "${outsideHide}"))`
    );
  });

  test("per-tool hide and extraWritable extend their global lists", async () => {
    const configHome = join(tempDir, "config");
    const globalHide = join(tempDir, "global-hide");
    const toolHide = join(tempDir, "tool-hide");
    const globalWritable = join(tempHome, "global-cache");
    const toolWritable = join(tempHome, "tool-cache");
    await mkdir(join(configHome, "aegis"), { recursive: true });
    for (const path of [
      globalHide,
      toolHide,
      globalWritable,
      toolWritable,
    ]) {
      await mkdir(path, { recursive: true });
    }
    await writeFile(
      join(configHome, "aegis", "config.toml"),
      `hideHomeAlways = false
hide = [${JSON.stringify(globalHide)}]
extraWritable = ["~/global-cache"]

[tools.claude]
name = "claude code"
cliCmd = "claude"
rwDirs = [".claude"]
hide = [${JSON.stringify(toolHide)}]
extraWritable = ["~/tool-cache"]
`
    );

    const { output, exitCode } = await runAegisDryRun(
      "claude",
      ["--version"],
      [],
      { HOME: tempHome, XDG_CONFIG_HOME: configHome },
      tempProject
    );
    expect(exitCode).toBe(0);
    const profile = profileOf(output);
    for (const path of [globalHide, toolHide]) {
      expect(profile).toContain(
        `(deny file-read* file-write* (subpath "${path}"))`
      );
    }
    for (const path of [globalWritable, toolWritable]) {
      expect(profile).toContain(
        `(allow file-read* file-write* (subpath "${path}"))`
      );
    }
  });

  test("per-tool hideHomeAlways masks only that tool", async () => {
    const configHome = join(tempDir, "config");
    await mkdir(join(configHome, "aegis"), { recursive: true });
    await writeFile(
      join(configHome, "aegis", "config.toml"),
      `hideHomeAlways = false
hide = []

[tools.masked]
name = "masked"
cliCmd = "masked"
rwDirs = [".masked"]
hideHomeAlways = true

[tools.plain]
name = "plain"
cliCmd = "plain"
rwDirs = [".plain"]
`
    );
    const env = { HOME: tempHome, XDG_CONFIG_HOME: configHome };
    const masked = await runAegisDryRun(
      "masked",
      ["--version"],
      [],
      env,
      tempProject
    );
    const plain = await runAegisDryRun(
      "plain",
      ["--version"],
      [],
      env,
      tempProject
    );
    const homeDeny =
      `(deny file-read* file-write* (subpath "${tempHome}"))`;
    expect(masked.exitCode).toBe(0);
    expect(plain.exitCode).toBe(0);
    expect(profileOf(masked.output)).toContain(homeDeny);
    expect(profileOf(plain.output)).not.toContain(homeDeny);
  });

  test("per-tool false cannot unset global hideHomeAlways", async () => {
    const configHome = join(tempDir, "config");
    await mkdir(join(configHome, "aegis"), { recursive: true });
    await writeFile(
      join(configHome, "aegis", "config.toml"),
      `hideHomeAlways = true
hide = []

[tools.explicit-false]
name = "explicit false"
cliCmd = "explicit-false"
rwDirs = [".explicit-false"]
hideHomeAlways = false

[tools.omitted]
name = "omitted"
cliCmd = "omitted"
rwDirs = [".omitted"]
`
    );
    const env = { HOME: tempHome, XDG_CONFIG_HOME: configHome };
    for (const tool of ["explicit-false", "omitted"]) {
      const result = await runAegisDryRun(
        tool,
        ["--version"],
        [],
        env,
        tempProject
      );
      expect(result.exitCode).toBe(0);
      expect(profileOf(result.output)).toContain(
        `(deny file-read* file-write* (subpath "${tempHome}"))`
      );
    }
  });

  test("CLI and per-tool hide are strict while global config hide remains lenient", async () => {
    const configHome = join(tempDir, "config");
    const configPath = join(configHome, "aegis", "config.toml");
    const missingGlobal = join(tempDir, "missing-global");
    const missingTool = join(tempDir, "missing-tool");
    await mkdir(join(configHome, "aegis"), { recursive: true });
    await writeFile(
      configPath,
      `hideHomeAlways = false
hide = [${JSON.stringify(missingGlobal)}]

[tools.claude]
name = "claude code"
cliCmd = "claude"
rwDirs = [".claude"]
hide = [${JSON.stringify(missingTool)}]
`
    );
    const env = { HOME: tempHome, XDG_CONFIG_HOME: configHome };
    const strict = await runAegisDryRun(
      "claude",
      ["--version"],
      [],
      env,
      tempProject
    );
    expect(strict.exitCode).toBe(1);
    expect(strict.stderr).toContain(configPath);
    expect(strict.stderr).toContain('tool "claude"');
    expect(strict.stderr).toContain(missingTool);

    await writeFile(
      configPath,
      `hideHomeAlways = false
hide = [${JSON.stringify(missingGlobal)}]

[tools.claude]
name = "claude code"
cliCmd = "claude"
rwDirs = [".claude"]
`
    );
    const lenient = await runAegisDryRun(
      "claude",
      ["--version"],
      [],
      env,
      tempProject
    );
    expect(lenient.exitCode).toBe(0);
    expect(profileOf(lenient.output)).not.toContain(missingGlobal);
  });

  test("homeAccess allowlist masks home and re-exposes allowRead read-only", async () => {
    const configHome = join(tempDir, "config");
    const readable = join(tempHome, "Library", "Fonts");
    const legacyHide = join(tempHome, ".ssh");
    await mkdir(join(configHome, "aegis"), { recursive: true });
    await mkdir(readable, { recursive: true });
    await mkdir(legacyHide, { recursive: true });
    await writeFile(
      join(configHome, "aegis", "config.toml"),
      `hideHomeAlways = false
homeAccess = "allowlist"
hide = [${JSON.stringify(legacyHide)}]
allowRead = ["~/Library/Fonts"]

[tools.claude]
name = "claude code"
cliCmd = "claude"
rwDirs = [".claude"]
rwFiles = [".claude.json"]
`
    );

    const { output, exitCode } = await runAegisDryRun(
      "claude",
      ["--version"],
      [],
      {
        HOME: tempHome,
        XDG_CONFIG_HOME: configHome,
      },
      tempProject
    );
    expect(exitCode).toBe(0);
    const profile = profileOf(output);
    expect(profile).toContain(
      `(deny file-read* file-write* (subpath "${tempHome}"))`
    );
    expect(profile).toContain(`(allow file-read* (subpath "${readable}"))`);
    // allowRead is read-only; the write knob is extraWritable.
    expect(profile).not.toContain(
      `(allow file-read* file-write* (subpath "${readable}"))`
    );
    // A hide entry under $HOME is redundant here (the mask already covers it)
    // but is still emitted — hide only ever subtracts, so re-stating it costs
    // nothing and keeps one code path for both modes.
    expect(profile).toContain(
      `(deny file-read* file-write* (subpath "${legacyHide}"))`
    );
  });

  test("rejects a content-substitution override with a clear error", async () => {
    // Exercise the project policy source rather than the global config source.
    await writeFile(join(tempProject, ".env"), "REAL=secret");
    await writeFile(join(tempProject, ".env.sandbox"), "FAKE=1");
    await writeFile(
      join(tempProject, ".aegis.toml"),
      'overrides = [{ target = ".env", override = ".env.sandbox" }]\n'
    );
    const { exitCode, stderr } = await runAegisDryRun(
      "claude",
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
      join(tempProject, ".aegis.toml"),
      'overrides = ["secrets/"]\n'
    );
    const { output, exitCode } = await runAegisDryRun(
      "claude",
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
