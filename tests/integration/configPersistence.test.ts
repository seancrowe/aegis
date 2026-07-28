/**
 * Layer 2: Config persistence integration tests.
 * These tests verify that CLI flags do NOT modify persistent config.
 *
 * The key invariant is that runtime CLI flags (like --hide <dir>) should
 * only affect the current invocation and never be written to config.toml.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "bun";
import { defaultHidePaths } from "../../src/config/config";

const AEGIS_PATH = resolve(__dirname, "../../src/main.ts");

interface AegisConfig {
  hideHomeAlways: boolean;
  hide: string[];
}

function configToml(hideHomeAlways: boolean, hide: string[]): string {
  return `hideHomeAlways = ${hideHomeAlways}
hide = [${hide.map((path) => JSON.stringify(path)).join(", ")}]

[tools.cc]
name = "claude code"
cliCmd = "claude"
yoloArg = "--dangerously-skip-permissions"
rwDirs = [".claude"]
rwFiles = [".claude.json"]
`;
}

function parseConfigToml(content: string): AegisConfig {
  return Bun.TOML.parse(content) as unknown as AegisConfig;
}

/**
 * Run aegis with --dry-run and return the result.
 */
async function runAegisDryRun(
  tool: string,
  toolArgs: string[] = [],
  aegisArgs: string[] = [],
  env: Record<string, string> = {},
  cwd?: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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
  return { stdout, stderr, exitCode };
}

describe("config persistence - CLI flags should not modify config.toml", () => {
  let tempDir: string;
  let tempHome: string;
  let tempConfig: string;
  let tempProject: string;
  let tempHide: string;
  let configPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "aegis-config-persist-"));
    tempHome = join(tempDir, "home");
    tempConfig = join(tempDir, "config");
    tempProject = join(tempDir, "project");
    tempHide = join(tempDir, "hideme");

    // Create directories
    await mkdir(tempHome, { recursive: true });
    await mkdir(tempConfig, { recursive: true });
    await mkdir(tempProject, { recursive: true });
    await mkdir(tempHide, { recursive: true });

    // Create tool config directories
    await mkdir(join(tempHome, ".claude"), { recursive: true });
    await writeFile(join(tempHome, ".claude.json"), "{}");

    // Create aegis config directory and config file
    const aegisConfigDir = join(tempConfig, "aegis");
    await mkdir(aegisConfigDir, { recursive: true });
    configPath = join(aegisConfigDir, "config.toml");

    // Start with empty hide array in config
    await writeFile(configPath, configToml(false, []));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("--hide flag does NOT persist to config.toml", async () => {
    // Read initial config
    const initialConfigContent = await readFile(configPath, "utf-8");
    const initialConfig = parseConfigToml(initialConfigContent);
    expect(initialConfig.hide).toEqual([]);

    // Run aegis with --hide flag
    const { exitCode } = await runAegisDryRun(
      "cc",
      ["--version"],
      ["--hide", tempHide],
      { HOME: tempHome, XDG_CONFIG_HOME: tempConfig },
      tempProject
    );

    expect(exitCode).toBe(0);

    // Re-read config after running aegis
    const afterConfigContent = await readFile(configPath, "utf-8");
    const afterConfig = parseConfigToml(afterConfigContent);

    // Assert the hide path was NOT persisted
    expect(afterConfig.hide).toEqual([]);
    expect(afterConfig.hide).not.toContain(tempHide);
  });

  test("--hide-home flag does NOT persist hideHomeAlways to config.toml", async () => {
    // Read initial config
    const initialConfigContent = await readFile(configPath, "utf-8");
    const initialConfig = parseConfigToml(initialConfigContent);
    expect(initialConfig.hideHomeAlways).toBe(false);

    // Run aegis with --hide-home flag
    const { exitCode } = await runAegisDryRun(
      "cc",
      ["--version"],
      ["--hide-home"],
      { HOME: tempHome, XDG_CONFIG_HOME: tempConfig },
      tempProject
    );

    expect(exitCode).toBe(0);

    // Re-read config after running aegis
    const afterConfigContent = await readFile(configPath, "utf-8");
    const afterConfig = parseConfigToml(afterConfigContent);

    // Assert hideHomeAlways was NOT changed
    expect(afterConfig.hideHomeAlways).toBe(false);
  });

  test("multiple --hide flags do NOT persist to config.toml", async () => {
    const tempHide2 = join(tempDir, "hideme2");
    await mkdir(tempHide2, { recursive: true });

    // Read initial config
    const initialConfigContent = await readFile(configPath, "utf-8");
    const initialConfig = parseConfigToml(initialConfigContent);
    expect(initialConfig.hide).toEqual([]);

    // Run aegis with multiple --hide flags
    const { exitCode } = await runAegisDryRun(
      "cc",
      ["--version"],
      ["--hide", tempHide, "--hide", tempHide2],
      { HOME: tempHome, XDG_CONFIG_HOME: tempConfig },
      tempProject
    );

    expect(exitCode).toBe(0);

    // Re-read config after running aegis
    const afterConfigContent = await readFile(configPath, "utf-8");
    const afterConfig = parseConfigToml(afterConfigContent);

    // Assert none of the hide paths were persisted
    expect(afterConfig.hide).toEqual([]);
    expect(afterConfig.hide).not.toContain(tempHide);
    expect(afterConfig.hide).not.toContain(tempHide2);
  });

  test("config with existing hide paths is not modified by CLI --hide", async () => {
    // Create a pre-existing hide path in config
    const existingHidePath = join(tempDir, "existing-hide");
    await mkdir(existingHidePath, { recursive: true });

    // Update config with existing hide path
    await writeFile(configPath, configToml(false, [existingHidePath]));

    // Run aegis with a new --hide flag
    const { exitCode } = await runAegisDryRun(
      "cc",
      ["--version"],
      ["--hide", tempHide],
      { HOME: tempHome, XDG_CONFIG_HOME: tempConfig },
      tempProject
    );

    expect(exitCode).toBe(0);

    // Re-read config after running aegis
    const afterConfigContent = await readFile(configPath, "utf-8");
    const afterConfig = parseConfigToml(afterConfigContent);

    // Assert config still has only the existing path, not the CLI path
    expect(afterConfig.hide).toEqual([existingHidePath]);
    expect(afterConfig.hide).not.toContain(tempHide);
  });

  test("CLI hide paths are not persisted even when config is auto-created", async () => {
    // Remove the config file to trigger auto-creation
    await rm(configPath);

    // Run aegis with --hide flag
    const { exitCode } = await runAegisDryRun(
      "cc",
      ["--version"],
      ["--hide", tempHide],
      { HOME: tempHome, XDG_CONFIG_HOME: tempConfig },
      tempProject
    );

    // Per plan.md: "If config file missing: create directories + write default config."
    // The command should succeed
    expect(exitCode).toBe(0);

    // Config file should be created (per plan.md spec). Comments are native
    // TOML, so the same parser used by aegis can inspect it.
    const afterConfigContent = await readFile(configPath, "utf-8");
    const afterConfig = parseConfigToml(afterConfigContent);

    // Critical invariant: CLI hide path must NOT be persisted
    expect(afterConfig.hide).toEqual(defaultHidePaths());
    expect(afterConfig.hide).not.toContain(tempHide);

    // Default config values per spec
    expect(afterConfig.hideHomeAlways).toBe(false);
  });
});
