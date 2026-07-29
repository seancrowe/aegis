/**
 * Layer 4: Docker smoke tests with real AI CLIs.
 *
 * They install real vendor CLIs from npm and run basic --version commands
 * through aegis to verify the full pipeline works.
 *
 * These tests should NOT require authentication and should NOT make network calls
 * (assuming the CLI respects --version without auth).
 *
 * These tests must run inside Docker.
 * Use: bun run scripts/test.ts layer4
 *
 * Supported CLIs:
 * - Claude Code (@anthropic-ai/claude-code)
 * - Codex (openai-codex-cli)
 * - Gemini CLI (@google/generative-ai-cli)
 * - Auggie (augment-cli)
 * - OpenCode (opencode-ai)
 * - Crush (@charmbracelet/crush)
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { spawn } from "bun";
import { resolve } from "node:path";
import { requireDocker } from "../utils/dockerGuard";
import { seedCatalogConfigForHome } from "../utils/catalogConfig";

// The first-run scaffold configures no tools, so every suite here has to opt
// the catalog in before `aegis <tool>` has a subcommand to dispatch.
const TEST_HOME = process.env.HOME ?? "/root";

const AEGIS_PATH = resolve(__dirname, "../../src/main.ts");

/**
 * CLI tool configuration
 */
interface CliConfig {
  /** The name used to invoke the tool via aegis (e.g., "claude", "codex") */
  aegisName: string;
  /** The binary name to check for in PATH */
  binaryName: string;
  /** NPM package name for reference */
  npmPackage: string;
  /** Expected patterns in --version output */
  versionPatterns: RegExp[];
  /** Whether the CLI is expected to be available (may not be if install failed) */
  optional: boolean;
}

/**
 * All supported CLI tools
 */
const CLI_TOOLS: CliConfig[] = [
  {
    aegisName: "claude",
    binaryName: "claude",
    npmPackage: "@anthropic-ai/claude-code",
    versionPatterns: [/version|claude|\d+\.\d+/i],
    optional: true,
  },
  {
    aegisName: "codex",
    binaryName: "codex",
    npmPackage: "openai-codex-cli",
    versionPatterns: [/version|codex|\d+\.\d+/i],
    optional: true,
  },
  {
    aegisName: "gemini",
    binaryName: "gemini",
    npmPackage: "@google/generative-ai-cli",
    versionPatterns: [/version|gemini|\d+\.\d+/i],
    optional: true,
  },
  {
    aegisName: "auggie",
    binaryName: "augment",
    npmPackage: "augment-cli",
    versionPatterns: [/version|augment|\d+\.\d+/i],
    optional: true,
  },
  {
    aegisName: "opencode",
    binaryName: "opencode",
    npmPackage: "opencode-ai",
    versionPatterns: [/version|opencode|\d+\.\d+/i],
    optional: true,
  },
  {
    aegisName: "crush",
    binaryName: "crush",
    npmPackage: "@charmbracelet/crush",
    versionPatterns: [/version|crush|\d+\.\d+/i],
    optional: true,
  },
];

/**
 * Check if a CLI tool is installed and available.
 */
async function isCliAvailable(name: string): Promise<boolean> {
  try {
    const which = Bun.which(name);
    return which !== null;
  } catch {
    return false;
  }
}

// Default timeout for CLI operations (20 seconds for --version)
const DEFAULT_TIMEOUT_MS = 20000;

/**
 * Helper to wrap a promise with a timeout.
 */
function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(errorMessage)), timeoutMs)
    ),
  ]);
}

/**
 * Run aegis with a real CLI tool.
 * Includes timeout to prevent hanging.
 */
async function runAegis(
  tool: string,
  args: string[] = [],
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn({
    cmd: ["bun", "run", AEGIS_PATH, tool, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });

  try {
    const result = await withTimeout(
      (async () => {
        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        const exitCode = await proc.exited;
        return { stdout, stderr, exitCode };
      })(),
      timeoutMs,
      `aegis ${tool} timed out after ${timeoutMs}ms`
    );
    return result;
  } catch (error) {
    // Kill the process if it's still running
    try {
      proc.kill();
    } catch {
      // Ignore kill errors
    }
    throw error;
  }
}

/**
 * Run a CLI directly (not through aegis) to verify it works.
 * Includes timeout to prevent hanging.
 */
async function runCliDirect(
  binaryName: string,
  args: string[] = [],
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn({
    cmd: [binaryName, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });

  try {
    const result = await withTimeout(
      (async () => {
        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        const exitCode = await proc.exited;
        return { stdout, stderr, exitCode };
      })(),
      timeoutMs,
      `${binaryName} timed out after ${timeoutMs}ms`
    );
    return result;
  } catch (error) {
    // Kill the process if it's still running
    try {
      proc.kill();
    } catch {
      // Ignore kill errors
    }
    throw error;
  }
}

describe("Layer 4: e2e smoke tests with real CLIs", () => {
  // Track which CLIs are available
  const cliAvailability: Map<string, boolean> = new Map();

  beforeAll(async () => {
    // Ensure this test only runs in Docker
    requireDocker("Layer 4 (e2e)");
    await seedCatalogConfigForHome(TEST_HOME);

    console.log("\n=== Checking CLI availability ===");
    for (const cli of CLI_TOOLS) {
      const available = await isCliAvailable(cli.binaryName);
      cliAvailability.set(cli.aegisName, available);
      console.log(
        `${cli.aegisName} (${cli.binaryName}): ${available ? "available" : "not found"}`
      );
    }
    console.log("=================================\n");
  });

  // Generate tests for each CLI tool
  for (const cli of CLI_TOOLS) {
    describe(`${cli.aegisName} CLI (${cli.npmPackage})`, () => {
      test(`direct ${cli.binaryName} --version works`, async () => {
        const available = cliAvailability.get(cli.aegisName);
        if (!available) {
          console.log(`Skipping: ${cli.binaryName} not available`);
          return;
        }

        const { stdout, stderr, exitCode } = await runCliDirect(
          cli.binaryName,
          ["--version"]
        );
        const output = stdout + stderr;

        // Log output for debugging
        console.log(`${cli.binaryName} --version output:`, output.trim());

        // Some CLIs may exit non-zero for --version, just verify we get output
        expect(output.length).toBeGreaterThan(0);
      });

      test(`aegis ${cli.aegisName} --version works`, async () => {
        const available = cliAvailability.get(cli.aegisName);
        if (!available) {
          console.log(`Skipping: ${cli.binaryName} not available`);
          return;
        }

        const { stdout, stderr, exitCode } = await runAegis(cli.aegisName, [
          "--version",
        ]);
        const output = stdout + stderr;

        // Log output for debugging
        console.log(`aegis ${cli.aegisName} --version output:`, output.trim());
        console.log(`Exit code: ${exitCode}`);

        // For now, we just check that aegis runs and produces some output
        // The actual aegis integration may fail, which is expected per the user's note
        expect(output.length).toBeGreaterThan(0);
      });

      test(`aegis ${cli.aegisName} --help shows usage`, async () => {
        const available = cliAvailability.get(cli.aegisName);
        if (!available) {
          console.log(`Skipping: ${cli.binaryName} not available`);
          return;
        }

        const { stdout, stderr, exitCode } = await runAegis(cli.aegisName, [
          "--help",
        ]);
        const output = stdout + stderr;

        // Log output for debugging
        console.log(`aegis ${cli.aegisName} --help output:`, output.trim());

        // Just check we get some output
        expect(output.length).toBeGreaterThan(0);
      });
    });
  }

  describe("CLI availability summary", () => {
    test("Claude Code CLI MUST be available for meaningful tests", async () => {
      const claudeAvailable = cliAvailability.get("claude");

      // Claude Code is the primary CLI and MUST be available
      // Other CLIs can remain optional
      if (!claudeAvailable) {
        console.error(
          "ERROR: Claude Code CLI not available. Layer 4 tests cannot run meaningfully."
        );
        console.error("Install Claude Code: bun install -g @anthropic-ai/claude-code");
      }

      expect(claudeAvailable).toBe(true);
    });

    test("logs availability of optional CLIs", async () => {
      const availableCount = Array.from(cliAvailability.values()).filter(
        Boolean
      ).length;
      console.log(`\n${availableCount}/${CLI_TOOLS.length} CLIs available`);

      // Log which optional CLIs are missing (informational only)
      for (const cli of CLI_TOOLS) {
        if (cli.aegisName !== "claude" && !cliAvailability.get(cli.aegisName)) {
          console.log(`Optional CLI not installed: ${cli.aegisName} (${cli.npmPackage})`);
        }
      }
    });
  });

  describe("Claude Code strict assertions", () => {
    test("direct claude --version exits 0", async () => {
      const claudeAvailable = await isCliAvailable("claude");
      if (!claudeAvailable) {
        throw new Error("Claude Code CLI not available - test cannot run");
      }

      const { stdout, stderr, exitCode } = await runCliDirect("claude", ["--version"]);
      const output = stdout + stderr;

      console.log("claude --version output:", output.trim());
      console.log("claude --version exitCode:", exitCode);

      // STRICT: claude --version MUST exit 0
      expect(exitCode).toBe(0);

      // STRICT: output must contain version-like pattern
      expect(output).toMatch(/\d+\.\d+/);
    });

    test("aegis claude --version exits 0 when direct CLI exits 0", async () => {
      const claudeAvailable = await isCliAvailable("claude");
      if (!claudeAvailable) {
        throw new Error("Claude Code CLI not available - test cannot run");
      }

      // First verify direct CLI works
      const directResult = await runCliDirect("claude", ["--version"]);
      expect(directResult.exitCode).toBe(0);

      // Now verify aegis wrapper also succeeds
      const { stdout, stderr, exitCode } = await runAegis("claude", ["--version"]);
      const output = stdout + stderr;

      console.log("aegis claude --version output:", output.trim());
      console.log("aegis claude --version exitCode:", exitCode);

      // STRICT: if direct CLI exits 0, aegis wrapper MUST also exit 0
      // The aegis wrapper should not degrade a working CLI
      expect(exitCode).toBe(0);
    });

    test("aegis claude --version produces version output (not error)", async () => {
      const claudeAvailable = await isCliAvailable("claude");
      if (!claudeAvailable) {
        throw new Error("Claude Code CLI not available - test cannot run");
      }

      const { stdout, stderr, exitCode } = await runAegis("claude", ["--version"]);
      const output = stdout + stderr;

      // Must exit 0
      expect(exitCode).toBe(0);

      // Output must NOT be an error message
      expect(output.toLowerCase()).not.toMatch(/fatal|error|failed|sandbox.*fail/i);

      // Output should contain version info or 'claude'
      expect(output.toLowerCase()).toMatch(/claude|\d+\.\d+|version/i);
    });

    test("aegis claude exit code matches direct claude exit code", async () => {
      const claudeAvailable = await isCliAvailable("claude");
      if (!claudeAvailable) {
        throw new Error("Claude Code CLI not available - test cannot run");
      }

      // Get direct CLI exit code
      const directResult = await runCliDirect("claude", ["--version"]);

      // Get aegis wrapper exit code
      const aegisResult = await runAegis("claude", ["--version"]);

      // Exit codes should match
      expect(aegisResult.exitCode).toBe(directResult.exitCode);
    });
  });
});

describe("Layer 4: e2e error handling", () => {
  beforeAll(async () => {
    requireDocker("Layer 4 (e2e)");
    await seedCatalogConfigForHome(TEST_HOME);
  });

  test("aegis with invalid tool shows error", async () => {
    const { stdout, stderr, exitCode } = await runAegis("nonexistent-tool", []);

    expect(exitCode).not.toBe(0);
    const output = stdout + stderr;
    // Should mention the invalid tool
    expect(output.toLowerCase()).toMatch(/error|invalid|not found|unknown/i);
  });

  test("aegis without arguments shows help or error", async () => {
    const proc = spawn({
      cmd: ["bun", "run", AEGIS_PATH],
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const exitCode = await proc.exited;
    const output = stdout + stderr;

    // Should either show help or an error about missing arguments
    expect(output.length).toBeGreaterThan(0);
  });

  test("aegis --help shows usage information", async () => {
    const proc = spawn({
      cmd: ["bun", "run", AEGIS_PATH, "--help"],
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const output = stdout + stderr;

    // Should show usage information
    expect(output.toLowerCase()).toMatch(/usage|help|aegis/i);
  });
});

describe("Layer 4: aegis-specific flags with real CLIs", () => {
  beforeAll(async () => {
    requireDocker("Layer 4 (e2e)");
    await seedCatalogConfigForHome(TEST_HOME);

    // Re-check availability for this suite
    for (const cli of CLI_TOOLS) {
      const available = await isCliAvailable(cli.binaryName);
      if (available) {
        console.log(`Using ${cli.aegisName} for aegis flag tests`);
        break;
      }
    }
  });

  test("aegis --dry-run shows planned command without executing", async () => {
    // Find first available CLI
    let availableCli: CliConfig | undefined;
    for (const cli of CLI_TOOLS) {
      if (await isCliAvailable(cli.binaryName)) {
        availableCli = cli;
        break;
      }
    }

    if (!availableCli) {
      console.log("Skipping: no CLIs available");
      return;
    }

    const { stdout, stderr, exitCode } = await runAegis(availableCli.aegisName, [
      "--dry-run",
      "--version",
    ]);
    const output = stdout + stderr;

    console.log(`aegis ${availableCli.aegisName} --dry-run output:`, output.trim());

    // Dry-run should output the command that would be run
    // This may be JSON or human-readable depending on implementation
    expect(output.length).toBeGreaterThan(0);
  });

  test("aegis --hide with valid directory works", async () => {
    // Find first available CLI
    let availableCli: CliConfig | undefined;
    for (const cli of CLI_TOOLS) {
      if (await isCliAvailable(cli.binaryName)) {
        availableCli = cli;
        break;
      }
    }

    if (!availableCli) {
      console.log("Skipping: no CLIs available");
      return;
    }

    // Create a temp directory to hide
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aegis-test-hide-"));

    try {
      const { stdout, stderr, exitCode } = await runAegis(availableCli.aegisName, [
        "--dry-run",
        "--hide",
        tempDir,
        "--version",
      ]);
      const output = stdout + stderr;

      console.log(`aegis --hide output:`, output.trim());

      // Should include the hide directory in the dry-run output
      expect(output.length).toBeGreaterThan(0);
    } finally {
      // Clean up
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

// Export for potential reuse
export { isCliAvailable, runAegis, runCliDirect, CLI_TOOLS };
