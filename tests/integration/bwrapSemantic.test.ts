/**
 * Layer 3: Bubblewrap semantic integration tests.
 * Tests sandbox filesystem visibility using ls-based fake CLI.
 *
 * These tests verify that --hide-home and --hide flags correctly
 * control what directories are visible inside the sandbox.
 *
 * These tests must run inside Docker for a predictable filesystem.
 * Use: bun run scripts/test.ts layer3
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawn } from "bun";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { requireDocker } from "../utils/dockerGuard";
import { seedCatalogConfigForHome } from "../utils/catalogConfig";
import {
  parseArgs,
  parseLsOutput,
  parseSecretCredentialExists,
} from "../utils/semanticOutput";

const AEGIS_PATH = resolve(__dirname, "../../src/main.ts");
const FIXTURES_BIN_TOOLS = resolve(__dirname, "../fixtures/bin-tools");

// -----------------------------------------------------------------------------
// Test Runner
// -----------------------------------------------------------------------------

/**
 * Check if bwrap is available and functional.
 */
async function isBwrapAvailable(): Promise<boolean> {
  try {
    const proc = spawn({
      cmd: ["bwrap", "--version"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

// Default project directory for cwd - use env var or fallback to known path
const DEFAULT_PROJECT_DIR = process.env.AEGIS_TEST_PROJECT_DIR || "/home/testuser/project";

/**
 * Run aegis with fake claude CLI in sandbox.
 * Explicitly sets cwd to avoid relying on Dockerfile WORKDIR.
 */
async function runAegis(
  aegisArgs: string[] = [],
  env: Record<string, string> = {},
  cwd: string = DEFAULT_PROJECT_DIR
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const newPath = `${FIXTURES_BIN_TOOLS}:${process.env.PATH}`;

  const proc = spawn({
    cmd: ["bun", "run", AEGIS_PATH, "claude", ...aegisArgs],
    env: {
      ...process.env,
      ...env,
      PATH: newPath,
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

const HOME_DIR = process.env.HOME || "/home/testuser";
const HOME_BIN = `${HOME_DIR}/.local/bin`;

/**
 * Run aegis against a tool resolved from ~/.local/bin instead of the repo
 * fixtures, so the tool binary sits inside the region --hide-home masks.
 * Deliberately omits FIXTURES_BIN_TOOLS from PATH — those shadow the
 * home-installed tools of the same name.
 */
async function runAegisHomeInstalled(
  subCmd: string,
  aegisArgs: string[] = [],
  cwd: string = DEFAULT_PROJECT_DIR
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn({
    cmd: ["bun", "run", AEGIS_PATH, subCmd, ...aegisArgs],
    env: {
      ...process.env,
      PATH: `${HOME_BIN}:${process.env.PATH}`,
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

/**
 * Extract the marker printed by the home-installed fixture tools.
 */
function parseHomeInstalledMarker(stdout: string): string | undefined {
  return stdout.match(/HOME_INSTALLED_TOOL=(\w+)/)?.[1];
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("bwrap semantic tests", () => {
  let bwrapAvailable = false;

  beforeAll(async () => {
    // Ensure this test only runs in Docker
    requireDocker("Layer 3 (bwrap semantic)");

    // The first-run scaffold configures no tools, so `aegis claude` only has a
    // subcommand to dispatch once the catalog is written into $HOME's config.
    await seedCatalogConfigForHome(HOME_DIR);

    bwrapAvailable = await isBwrapAvailable();
    if (!bwrapAvailable) {
      console.warn(
        "WARNING: bwrap not available or not functional. Skipping semantic tests."
      );
    }
  });

  describe("basic sandbox functionality", () => {
    test("claude receives --dangerously-skip-permissions flag", async () => {
      if (!bwrapAvailable) return;

      const { stdout, exitCode } = await runAegis();
      expect(exitCode).toBe(0);

      const args = parseArgs(stdout);
      expect(args).toContain("--dangerously-skip-permissions");
    });

    test(".claude directory is visible and contains config", async () => {
      if (!bwrapAvailable) return;

      const { stdout, exitCode } = await runAegis();
      expect(exitCode).toBe(0);

      const sections = parseLsOutput(stdout);
      const claudeDir = sections.get("HOME/.claude");

      expect(claudeDir).toBeDefined();
      expect(claudeDir?.error).toBeUndefined();
      expect(claudeDir?.entries).toContain("settings.json");
    });
  });

  describe("--hide-home mode", () => {
    test("hides ~/.ssh directory contents", async () => {
      if (!bwrapAvailable) return;

      const { stdout, exitCode } = await runAegis(["--hide-home"]);
      expect(exitCode).toBe(0);

      const sections = parseLsOutput(stdout);
      const sshDir = sections.get("HOME/.ssh");

      // Either doesn't exist, has error, or is empty
      if (sshDir && !sshDir.error) {
        expect(sshDir.entries).toHaveLength(0);
      }
    });

    test("hides ~/.aws directory contents", async () => {
      if (!bwrapAvailable) return;

      const { stdout, exitCode } = await runAegis(["--hide-home"]);
      expect(exitCode).toBe(0);

      const sections = parseLsOutput(stdout);
      const awsDir = sections.get("HOME/.aws");

      if (awsDir && !awsDir.error) {
        expect(awsDir.entries).toHaveLength(0);
      }
    });

    test("hides ~/.gnupg directory contents", async () => {
      if (!bwrapAvailable) return;

      const { stdout, exitCode } = await runAegis(["--hide-home"]);
      expect(exitCode).toBe(0);

      const sections = parseLsOutput(stdout);
      const gnupgDir = sections.get("HOME/.gnupg");

      if (gnupgDir && !gnupgDir.error) {
        expect(gnupgDir.entries).toHaveLength(0);
      }
    });

    test("hides ~/.secret-credentials file", async () => {
      if (!bwrapAvailable) return;

      const { stdout, exitCode } = await runAegis(["--hide-home"]);
      expect(exitCode).toBe(0);

      const exists = parseSecretCredentialExists(stdout);
      expect(exists).toBe(false);
    });

    test("preserves ~/.claude directory access", async () => {
      if (!bwrapAvailable) return;

      const { stdout, exitCode } = await runAegis(["--hide-home"]);
      expect(exitCode).toBe(0);

      const sections = parseLsOutput(stdout);
      const claudeDir = sections.get("HOME/.claude");

      expect(claudeDir).toBeDefined();
      expect(claudeDir?.error).toBeUndefined();
      expect(claudeDir?.entries).toContain("settings.json");
    });

    test("home directory itself still exists (as tmpfs)", async () => {
      if (!bwrapAvailable) return;

      const { stdout, exitCode } = await runAegis(["--hide-home"]);
      expect(exitCode).toBe(0);

      const sections = parseLsOutput(stdout);
      const homeDir = sections.get("HOME");

      expect(homeDir).toBeDefined();
      expect(homeDir?.error).toBeUndefined();
      // Should contain .claude (mounted back in)
      expect(homeDir?.entries).toContain(".claude");
    });
  });

  describe("--hide flag for specific directories", () => {
    test("hides /project/secrets contents", async () => {
      if (!bwrapAvailable) return;

      const projectDir = process.env.AEGIS_TEST_PROJECT_DIR || "/home/testuser/project";

      const { stdout, exitCode } = await runAegis(
        ["--hide", `${projectDir}/secrets`],
        { AEGIS_TEST_PROJECT_DIR: projectDir }
      );
      expect(exitCode).toBe(0);

      const sections = parseLsOutput(stdout);
      const secretsDir = sections.get("PROJECT/secrets");

      // Directory exists but is empty
      expect(secretsDir).toBeDefined();
      if (secretsDir && !secretsDir.error) {
        expect(secretsDir.entries).toHaveLength(0);
      }
    });

    test("without --hide, /project/secrets is visible", async () => {
      if (!bwrapAvailable) return;

      const projectDir = process.env.AEGIS_TEST_PROJECT_DIR || "/home/testuser/project";

      const { stdout, exitCode } = await runAegis([], {
        AEGIS_TEST_PROJECT_DIR: projectDir,
      });
      expect(exitCode).toBe(0);

      const sections = parseLsOutput(stdout);
      const secretsDir = sections.get("PROJECT/secrets");

      expect(secretsDir).toBeDefined();
      expect(secretsDir?.entries).toContain("api-key.txt");
      expect(secretsDir?.entries).toContain("db-password.txt");
    });
  });

  describe("default mode (without --hide-home)", () => {
    test("sensitive directories are hidden by default config", async () => {
      if (!bwrapAvailable) return;

      const { stdout, exitCode } = await runAegis([]);
      expect(exitCode).toBe(0);

      const sections = parseLsOutput(stdout);

      // Default config.hide includes ~/.ssh and ~/.aws, so they should be hidden
      const sshDir = sections.get("HOME/.ssh");
      const awsDir = sections.get("HOME/.aws");

      // Both should be empty or have errors (hidden by default hide paths)
      if (sshDir && !sshDir.error) {
        expect(sshDir.entries).toHaveLength(0);
      }
      if (awsDir && !awsDir.error) {
        expect(awsDir.entries).toHaveLength(0);
      }
    });

    test("secret credentials file is visible (not in default hide paths)", async () => {
      if (!bwrapAvailable) return;

      const { stdout, exitCode } = await runAegis([]);
      expect(exitCode).toBe(0);

      // ~/.secret-credentials is not in the default hide paths
      const exists = parseSecretCredentialExists(stdout);
      expect(exists).toBe(true);
    });
  });

  /**
   * The real agents install themselves inside $HOME — the official installers
   * produce ~/.local/bin/claude -> ~/.local/share/claude/versions/<v>, and
   * ~/.local/bin/codex -> .../current/bin/codex -> .../releases/<v>/bin/codex.
   *
   * --hide-home puts a tmpfs over $HOME, which does not merely deny access to
   * those paths: it removes them from the mount namespace, so there is nothing
   * left for the kernel to resolve and exec fails with ENOENT. The launcher
   * symlink and every hop of its chain have to be bound back in.
   *
   * This is a bwrap-specific problem. macOS masks $HOME with seatbelt deny
   * rules, where the files still exist and exec of the resolved image is
   * permitted, so the same layout works there untouched.
   */
  /**
   * The Seatbelt backend has to emit its masked-home deny at BOTH the written
   * and the realpath spelling of $HOME, and therefore has to emit the rwPath
   * re-allows at both too — the kernel matches the resolved path, so a deny at
   * one spelling paired with an allow at the other silently locks the tool out
   * of its own config directory.
   *
   * bwrap does not need the equivalent change, and cannot: it has no separate
   * deny and allow to keep in sync. `--tmpfs $HOME` and the rwPath `--bind`s
   * name one destination each, the kernel resolves each destination once inside
   * the new root, and if that resolution fails the whole launch aborts. There
   * is no state in which the mask lands and the carve-out misses.
   *
   * What a symlinked $HOME does produce on Linux is a hard, pre-existing
   * failure to launch, in BOTH modes: an absolute symlink inside the new root
   * resolves against bwrap's own root during setup, where the target does not
   * exist, so bwrap aborts before exec'ing anything. This is fail-closed —
   * nothing is exposed — but it is a real limitation, and pinning it here
   * records which behavior is the known one.
   */
  describe("symlinked $HOME", () => {
    const linkRoot = "/home/testuser/symlinked-home-probe";
    const realHome = `${linkRoot}/real-home`;
    const linkedHome = `${linkRoot}/linked-home`;

    beforeAll(async () => {
      await rm(linkRoot, { recursive: true, force: true });
      await mkdir(`${realHome}/.claude`, { recursive: true });
      await writeFile(`${realHome}/.claude/settings.json`, '{"version": 1}\n');
      await writeFile(`${realHome}/.claude.json`, "{}\n");
      // These runs override $HOME, which moves the config lookup with it.
      // Seeding the real home covers the linked spelling too — it resolves to
      // the same directory.
      await seedCatalogConfigForHome(realHome);
      await symlink(realHome, linkedHome, "dir");
    });

    afterAll(async () => {
      await rm(linkRoot, { recursive: true, force: true });
    });

    test("control: the same layout works when $HOME is the real path", async () => {
      if (!bwrapAvailable) return;

      const { stdout, stderr, exitCode } = await runAegis(["--hide-home"], {
        HOME: realHome,
      });
      expect({ exitCode, stderr }).toMatchObject({ exitCode: 0 });

      const claudeDir = parseLsOutput(stdout).get("HOME/.claude");
      expect(claudeDir?.error).toBeUndefined();
      expect(claudeDir?.entries).toContain("settings.json");
    });

    test("--hide-home aborts at the tmpfs rather than launching unmasked", async () => {
      if (!bwrapAvailable) return;

      const { stdout, exitCode } = await runAegis(["--hide-home"], {
        HOME: linkedHome,
      });

      // Fail-closed: bwrap refuses, the tool never runs.
      expect(exitCode).not.toBe(0);
      expect(stdout).not.toContain("=== DONE ===");
    });

    test("plain mode aborts at the $HOME bind for the same reason", async () => {
      if (!bwrapAvailable) return;

      const { stdout, exitCode } = await runAegis([], { HOME: linkedHome });

      expect(exitCode).not.toBe(0);
      expect(stdout).not.toContain("=== DONE ===");
    });
  });

  describe("tool binary installed under $HOME", () => {
    test("baseline: one-hop install runs without --hide-home", async () => {
      if (!bwrapAvailable) return;

      const { stdout, exitCode } = await runAegisHomeInstalled("claude");
      expect(exitCode).toBe(0);
      expect(parseHomeInstalledMarker(stdout)).toBe("claude");
    });

    test("one-hop install still runs with --hide-home", async () => {
      if (!bwrapAvailable) return;

      const { stdout, stderr, exitCode } = await runAegisHomeInstalled("claude", [
        "--hide-home",
      ]);
      expect({ exitCode, stderr }).toMatchObject({ exitCode: 0 });
      expect(parseHomeInstalledMarker(stdout)).toBe("claude");
    });

    test("baseline: two-hop install runs without --hide-home", async () => {
      if (!bwrapAvailable) return;

      const { stdout, exitCode } = await runAegisHomeInstalled("codex");
      expect(exitCode).toBe(0);
      expect(parseHomeInstalledMarker(stdout)).toBe("codex");
    });

    test("two-hop install still runs with --hide-home", async () => {
      if (!bwrapAvailable) return;

      const { stdout, stderr, exitCode } = await runAegisHomeInstalled("codex", [
        "--hide-home",
      ]);
      expect({ exitCode, stderr }).toMatchObject({ exitCode: 0 });
      expect(parseHomeInstalledMarker(stdout)).toBe("codex");
    });
  });
});

// Export test helpers for potential reuse
export {
  parseLsOutput,
  parseArgs,
  parseSecretCredentialExists,
  runAegis,
  isBwrapAvailable,
};
