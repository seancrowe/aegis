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
import { describe, test, expect, beforeAll } from "bun:test";
import { spawn } from "bun";
import { resolve } from "node:path";
import { requireDocker } from "../utils/dockerGuard";

const AEGIS_PATH = resolve(__dirname, "../../src/main.ts");
const FIXTURES_BIN_TOOLS = resolve(__dirname, "../fixtures/bin-tools");

// -----------------------------------------------------------------------------
// Output Parsing Helpers
// -----------------------------------------------------------------------------

interface LsSection {
  label: string;
  entries: string[];
  error?: string;
}

/**
 * Parse ls output sections from fake CLI output.
 * Sections are delimited by "=== LS:LABEL ===" headers.
 */
function parseLsOutput(stdout: string): Map<string, LsSection> {
  const sections = new Map<string, LsSection>();
  const lines = stdout.split("\n");

  let currentSection: LsSection | null = null;

  for (const line of lines) {
    const sectionMatch = line.match(/^=== LS:(.+) ===$/);
    if (sectionMatch) {
      if (currentSection) {
        sections.set(currentSection.label, currentSection);
      }
      currentSection = { label: sectionMatch[1]!, entries: [] };
      continue;
    }

    if (currentSection) {
      if (line.startsWith("ERROR:")) {
        currentSection.error = line;
      } else if (line.trim() && !line.startsWith("===")) {
        currentSection.entries.push(line.trim());
      }
    }
  }

  if (currentSection) {
    sections.set(currentSection.label, currentSection);
  }

  return sections;
}

/**
 * Parse arguments section from fake CLI output.
 */
function parseArgs(stdout: string): string[] {
  const args: string[] = [];
  const lines = stdout.split("\n");
  let inArgsSection = false;

  for (const line of lines) {
    if (line === "=== ARGS ===") {
      inArgsSection = true;
      continue;
    }
    if (line.startsWith("=== ") && inArgsSection) {
      break;
    }
    if (inArgsSection) {
      const argMatch = line.match(/^arg: (.+)$/);
      if (argMatch) {
        args.push(argMatch[1]!);
      }
    }
  }

  return args;
}

/**
 * Check if secret credential file exists from output.
 */
function parseSecretCredentialExists(stdout: string): boolean {
  const match = stdout.match(/EXISTS=(true|false)/);
  return match ? match[1] === "true" : false;
}

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
    cmd: ["bun", "run", AEGIS_PATH, "cc", ...aegisArgs],
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
  describe("tool binary installed under $HOME", () => {
    test("baseline: one-hop install runs without --hide-home", async () => {
      if (!bwrapAvailable) return;

      const { stdout, exitCode } = await runAegisHomeInstalled("cc");
      expect(exitCode).toBe(0);
      expect(parseHomeInstalledMarker(stdout)).toBe("claude");
    });

    test("one-hop install still runs with --hide-home", async () => {
      if (!bwrapAvailable) return;

      const { stdout, stderr, exitCode } = await runAegisHomeInstalled("cc", [
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
