/**
 * Unit tests for bubblewrap argument building.
 * Tests the pure function that generates bwrap argv from options.
 */
import { describe, test, expect } from "bun:test";
import { Result } from "typescript-result";
import {
  buildBwrapArgs,
  buildBwrapCommand,
  type BwrapOptions,
} from "../../src/sandbox/bwrap";
import { defaultCliDefs } from "../../src/config/config";
import type { CliDef } from "../../src/types";

const defaults = defaultCliDefs();
const findCli = (sub: string): CliDef => defaults.find(c => c.subCommand === sub)!;

/**
 * Helper to create default BwrapOptions for testing.
 */
function makeOpts(overrides: Partial<BwrapOptions> = {}): BwrapOptions {
  return {
    cwd: "/home/user/project",
    home: "/home/user",
    cliDef: findCli("cc"),
    toolPath: "/usr/bin/claude",
    toolArgs: ["--version"],
    hideHome: false,
    hidePaths: [],
    emptyDir: "",
    ...overrides,
  };
}

/**
 * Helper to check if an array contains a sequence of elements.
 */
function containsSequence(arr: string[], sequence: string[]): boolean {
  if (sequence.length === 0) return true;
  for (let start = 0; start <= arr.length - sequence.length; start++) {
    if (arr[start] !== sequence[0]) continue;
    let matches = true;
    for (let offset = 1; offset < sequence.length; offset++) {
      if (arr[start + offset] !== sequence[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

/**
 * Helper to find the index where a sequence starts in an array.
 * Returns -1 if not found.
 */
function findSequenceIndex(arr: string[], sequence: string[]): number {
  if (sequence.length === 0) return 0;
  for (let start = 0; start <= arr.length - sequence.length; start++) {
    if (arr[start] !== sequence[0]) continue;
    let matches = true;
    for (let offset = 1; offset < sequence.length; offset++) {
      if (arr[start + offset] !== sequence[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return start;
  }
  return -1;
}

describe("buildBwrapArgs", () => {
  describe("base sandbox flags", () => {
    test("includes --die-with-parent", () => {
      const result = buildBwrapArgs(makeOpts());
      Result.assertOk(result);
      expect(result.value).toContain("--die-with-parent");
    });

    test("includes --unshare-pid for PID namespace isolation", () => {
      const result = buildBwrapArgs(makeOpts());
      Result.assertOk(result);
      expect(result.value).toContain("--unshare-pid");
    });

    test("includes --unshare-ipc for IPC isolation", () => {
      const result = buildBwrapArgs(makeOpts());
      Result.assertOk(result);
      expect(result.value).toContain("--unshare-ipc");
    });

    test("includes --unshare-uts for hostname isolation", () => {
      const result = buildBwrapArgs(makeOpts());
      Result.assertOk(result);
      expect(result.value).toContain("--unshare-uts");
    });

    test("includes --ro-bind / /", () => {
      const result = buildBwrapArgs(makeOpts());
      Result.assertOk(result);
      expect(containsSequence(result.value, ["--ro-bind", "/", "/"])).toBe(true);
    });

    test("includes --dev /dev", () => {
      const result = buildBwrapArgs(makeOpts());
      Result.assertOk(result);
      expect(containsSequence(result.value, ["--dev", "/dev"])).toBe(true);
    });

    test("includes --proc /proc", () => {
      const result = buildBwrapArgs(makeOpts());
      Result.assertOk(result);
      expect(containsSequence(result.value, ["--proc", "/proc"])).toBe(true);
    });

    test("includes --tmpfs /tmp", () => {
      const result = buildBwrapArgs(makeOpts());
      Result.assertOk(result);
      expect(containsSequence(result.value, ["--tmpfs", "/tmp"])).toBe(true);
    });
  });

  describe("working directory", () => {
    test("includes RW bind for cwd", () => {
      const opts = makeOpts({ cwd: "/home/user/myproject" });
      const result = buildBwrapArgs(opts);
      Result.assertOk(result);
      expect(
        containsSequence(result.value, [
          "--bind",
          "/home/user/myproject",
          "/home/user/myproject",
        ])
      ).toBe(true);
    });

    test("includes --chdir to cwd", () => {
      const opts = makeOpts({ cwd: "/home/user/myproject" });
      const result = buildBwrapArgs(opts);
      Result.assertOk(result);
      expect(
        containsSequence(result.value, ["--chdir", "/home/user/myproject"])
      ).toBe(true);
    });
  });

  describe("tool config/auth paths (no hide-home)", () => {
    test("includes RW binds for claude config paths", () => {
      const opts = makeOpts({
        cliDef: findCli("cc"),
        home: "/home/user",
      });
      const result = buildBwrapArgs(opts);
      Result.assertOk(result);
      // Should bind .claude directory
      expect(
        containsSequence(result.value, [
          "--bind",
          "/home/user/.claude",
          "/home/user/.claude",
        ])
      ).toBe(true);
      // Should bind .claude.json file
      expect(
        containsSequence(result.value, [
          "--bind",
          "/home/user/.claude.json",
          "/home/user/.claude.json",
        ])
      ).toBe(true);
    });

    test("includes RW binds for codex config paths", () => {
      const opts = makeOpts({
        cliDef: findCli("codex"),
        home: "/home/user",
      });
      const result = buildBwrapArgs(opts);
      Result.assertOk(result);
      expect(
        containsSequence(result.value, [
          "--bind",
          "/home/user/.codex",
          "/home/user/.codex",
        ])
      ).toBe(true);
    });

    test("includes RW binds for gemini config paths", () => {
      const opts = makeOpts({
        cliDef: findCli("gemini"),
        home: "/home/user",
      });
      const result = buildBwrapArgs(opts);
      Result.assertOk(result);
      expect(
        containsSequence(result.value, [
          "--bind",
          "/home/user/.gemini",
          "/home/user/.gemini",
        ])
      ).toBe(true);
    });

    test("includes RW binds for auggie (augment) config paths", () => {
      const opts = makeOpts({
        cliDef: findCli("auggie"),
        home: "/home/user",
      });
      const result = buildBwrapArgs(opts);
      Result.assertOk(result);
      expect(
        containsSequence(result.value, [
          "--bind",
          "/home/user/.augment",
          "/home/user/.augment",
        ])
      ).toBe(true);
      expect(
        containsSequence(result.value, [
          "--bind",
          "/home/user/.augment/settings.json",
          "/home/user/.augment/settings.json",
        ])
      ).toBe(true);
    });

    test("includes RW binds for opencode config/auth paths", () => {
      const opts = makeOpts({
        cliDef: findCli("opencode"),
        home: "/home/user",
      });
      const result = buildBwrapArgs(opts);
      Result.assertOk(result);
      expect(
        containsSequence(result.value, [
          "--bind",
          "/home/user/.config/opencode",
          "/home/user/.config/opencode",
        ])
      ).toBe(true);
      expect(
        containsSequence(result.value, [
          "--bind",
          "/home/user/.local/share/opencode",
          "/home/user/.local/share/opencode",
        ])
      ).toBe(true);
      expect(
        containsSequence(result.value, [
          "--bind",
          "/home/user/.config/opencode/opencode.json",
          "/home/user/.config/opencode/opencode.json",
        ])
      ).toBe(true);
      expect(
        containsSequence(result.value, [
          "--bind",
          "/home/user/.local/share/opencode/auth.json",
          "/home/user/.local/share/opencode/auth.json",
        ])
      ).toBe(true);
    });

    test("includes RW binds for crush config paths", () => {
      const opts = makeOpts({
        cliDef: findCli("crush"),
        home: "/home/user",
      });
      const result = buildBwrapArgs(opts);
      Result.assertOk(result);
      expect(
        containsSequence(result.value, [
          "--bind",
          "/home/user/.config/crush",
          "/home/user/.config/crush",
        ])
      ).toBe(true);
      expect(
        containsSequence(result.value, [
          "--bind",
          "/home/user/.config/crush/crush.json",
          "/home/user/.config/crush/crush.json",
        ])
      ).toBe(true);
    });
  });

  describe("--hide-home mode", () => {
    test("includes --tmpfs $HOME when hide-home enabled", () => {
      const opts = makeOpts({
        hideHome: true,
        home: "/home/user",
      });
      const result = buildBwrapArgs(opts);
      Result.assertOk(result);
      expect(containsSequence(result.value, ["--tmpfs", "/home/user"])).toBe(
        true
      );
    });

    test("still includes tool config binds after tmpfs $HOME", () => {
      const opts = makeOpts({
        hideHome: true,
        home: "/home/user",
        cliDef: findCli("cc"),
      });
      const result = buildBwrapArgs(opts);
      Result.assertOk(result);
      const args = result.value;
      // tmpfs must come before binds
      const tmpfsIdx = args.indexOf("--tmpfs");
      const tmpfsHomeIdx =
        tmpfsIdx !== -1 && args[tmpfsIdx + 1] === "/home/user"
          ? tmpfsIdx
          : -1;

      // Find the config bind
      let bindClaudeIdx = -1;
      for (let i = 0; i < args.length - 2; i++) {
        if (
          args[i] === "--bind" &&
          args[i + 1] === "/home/user/.claude" &&
          args[i + 2] === "/home/user/.claude"
        ) {
          bindClaudeIdx = i;
          break;
        }
      }

      expect(tmpfsHomeIdx).not.toBe(-1);
      expect(bindClaudeIdx).not.toBe(-1);
      expect(tmpfsHomeIdx).toBeLessThan(bindClaudeIdx);
    });

    test("includes --dir for directory mountpoints under hide-home", () => {
      const opts = makeOpts({
        hideHome: true,
        home: "/home/user",
        cliDef: findCli("cc"),
      });
      const result = buildBwrapArgs(opts);
      Result.assertOk(result);
      const args = result.value;
      // Should create the directory mountpoint
      expect(
        containsSequence(args, ["--dir", "/home/user/.claude"])
      ).toBe(true);

      // CRITICAL: --dir must come BEFORE --bind for the same path
      // Otherwise bwrap will fail because the mountpoint doesn't exist
      const dirIdx = findSequenceIndex(args, ["--dir", "/home/user/.claude"]);
      const bindIdx = findSequenceIndex(args, ["--bind", "/home/user/.claude", "/home/user/.claude"]);

      expect(dirIdx).not.toBe(-1);
      expect(bindIdx).not.toBe(-1);
      expect(dirIdx).toBeLessThan(bindIdx);
    });

    test("includes --file for file mountpoints under hide-home", () => {
      const opts = makeOpts({
        hideHome: true,
        home: "/home/user",
        cliDef: findCli("cc"),
      });
      const result = buildBwrapArgs(opts);
      Result.assertOk(result);
      const args = result.value;

      // Find the --ro-bind /dev/null operation for .claude.json
      const fileIdx = findSequenceIndex(args, ["--ro-bind", "/dev/null", "/home/user/.claude.json"]);

      // Find the --bind for .claude.json
      let bindIdx = -1;
      for (let i = 0; i < args.length - 2; i++) {
        if (
          args[i] === "--bind" &&
          args[i + 1] === "/home/user/.claude.json"
        ) {
          bindIdx = i;
          break;
        }
      }

      expect(fileIdx).not.toBe(-1);
      expect(bindIdx).not.toBe(-1);
      // CRITICAL: --file must come BEFORE --bind
      expect(fileIdx).toBeLessThan(bindIdx);
    });

    test("all dir mountpoints have --dir before --bind under hide-home (claude)", () => {
      const claude = findCli("cc");
      const opts = makeOpts({
        hideHome: true,
        home: "/home/user",
        cliDef: claude,
      });
      const result = buildBwrapArgs(opts);
      Result.assertOk(result);
      const args = result.value;
      for (const reqPath of claude.rwPaths) {
        if (reqPath.kind === "dir") {
          const fullPath = `/home/user/${reqPath.path}`;
          const dirIdx = findSequenceIndex(args, ["--dir", fullPath]);
          const bindIdx = findSequenceIndex(args, ["--bind", fullPath, fullPath]);
          expect(dirIdx).not.toBe(-1);
          expect(bindIdx).not.toBe(-1);
          expect(dirIdx).toBeLessThan(bindIdx);
        }
      }
    });

    test("all file mountpoints have --ro-bind /dev/null before --bind under hide-home (claude)", () => {
      const claude = findCli("cc");
      const opts = makeOpts({
        hideHome: true,
        home: "/home/user",
        cliDef: claude,
      });
      const result = buildBwrapArgs(opts);
      Result.assertOk(result);
      const args = result.value;
      for (const reqPath of claude.rwPaths) {
        if (reqPath.kind === "file") {
          const fullPath = `/home/user/${reqPath.path}`;
          const fileIdx = findSequenceIndex(args, ["--ro-bind", "/dev/null", fullPath]);
          const bindIdx = findSequenceIndex(args, ["--bind", fullPath, fullPath]);
          expect(fileIdx).not.toBe(-1);
          expect(bindIdx).not.toBe(-1);
          expect(fileIdx).toBeLessThan(bindIdx);
        }
      }
    });

    test("all mountpoints have creation ops before binds under hide-home (auggie)", () => {
      const auggie = findCli("auggie");
      const opts = makeOpts({
        hideHome: true,
        home: "/home/user",
        cliDef: auggie,
      });
      const result = buildBwrapArgs(opts);
      Result.assertOk(result);
      const args = result.value;
      for (const reqPath of auggie.rwPaths) {
        const fullPath = `/home/user/${reqPath.path}`;
        const bindIdx = findSequenceIndex(args, ["--bind", fullPath, fullPath]);
        expect(bindIdx).not.toBe(-1);

        if (reqPath.kind === "dir") {
          const dirIdx = findSequenceIndex(args, ["--dir", fullPath]);
          expect(dirIdx).not.toBe(-1);
          expect(dirIdx).toBeLessThan(bindIdx);
        } else {
          const fileIdx = findSequenceIndex(args, ["--ro-bind", "/dev/null", fullPath]);
          expect(fileIdx).not.toBe(-1);
          expect(fileIdx).toBeLessThan(bindIdx);
        }
      }
    });

    test("all mountpoints have creation ops before binds under hide-home (opencode)", () => {
      const opencode = findCli("opencode");
      const opts = makeOpts({
        hideHome: true,
        home: "/home/user",
        cliDef: opencode,
      });
      const result = buildBwrapArgs(opts);
      Result.assertOk(result);
      const args = result.value;
      for (const reqPath of opencode.rwPaths) {
        const fullPath = `/home/user/${reqPath.path}`;
        const bindIdx = findSequenceIndex(args, ["--bind", fullPath, fullPath]);
        expect(bindIdx).not.toBe(-1);

        if (reqPath.kind === "dir") {
          const dirIdx = findSequenceIndex(args, ["--dir", fullPath]);
          expect(dirIdx).not.toBe(-1);
          expect(dirIdx).toBeLessThan(bindIdx);
        } else {
          const fileIdx = findSequenceIndex(args, ["--ro-bind", "/dev/null", fullPath]);
          expect(fileIdx).not.toBe(-1);
          expect(fileIdx).toBeLessThan(bindIdx);
        }
      }
    });

    test("all mountpoints have creation ops before binds under hide-home (codex)", () => {
      const codex = findCli("codex");
      const opts = makeOpts({
        hideHome: true,
        home: "/home/user",
        cliDef: codex,
      });
      const result = buildBwrapArgs(opts);
      Result.assertOk(result);
      const args = result.value;
      for (const reqPath of codex.rwPaths) {
        const fullPath = `/home/user/${reqPath.path}`;
        const bindIdx = findSequenceIndex(args, ["--bind", fullPath, fullPath]);
        expect(bindIdx).not.toBe(-1);

        if (reqPath.kind === "dir") {
          const dirIdx = findSequenceIndex(args, ["--dir", fullPath]);
          expect(dirIdx).not.toBe(-1);
          expect(dirIdx).toBeLessThan(bindIdx);
        } else {
          const fileIdx = findSequenceIndex(args, ["--ro-bind", "/dev/null", fullPath]);
          expect(fileIdx).not.toBe(-1);
          expect(fileIdx).toBeLessThan(bindIdx);
        }
      }
    });

    test("all mountpoints have creation ops before binds under hide-home (gemini)", () => {
      const gemini = findCli("gemini");
      const opts = makeOpts({
        hideHome: true,
        home: "/home/user",
        cliDef: gemini,
      });
      const result = buildBwrapArgs(opts);
      Result.assertOk(result);
      const args = result.value;
      for (const reqPath of gemini.rwPaths) {
        const fullPath = `/home/user/${reqPath.path}`;
        const bindIdx = findSequenceIndex(args, ["--bind", fullPath, fullPath]);
        expect(bindIdx).not.toBe(-1);

        if (reqPath.kind === "dir") {
          const dirIdx = findSequenceIndex(args, ["--dir", fullPath]);
          expect(dirIdx).not.toBe(-1);
          expect(dirIdx).toBeLessThan(bindIdx);
        } else {
          const fileIdx = findSequenceIndex(args, ["--ro-bind", "/dev/null", fullPath]);
          expect(fileIdx).not.toBe(-1);
          expect(fileIdx).toBeLessThan(bindIdx);
        }
      }
    });

    test("all mountpoints have creation ops before binds under hide-home (crush)", () => {
      const crush = findCli("crush");
      const opts = makeOpts({
        hideHome: true,
        home: "/home/user",
        cliDef: crush,
      });
      const result = buildBwrapArgs(opts);
      Result.assertOk(result);
      const args = result.value;
      for (const reqPath of crush.rwPaths) {
        const fullPath = `/home/user/${reqPath.path}`;
        const bindIdx = findSequenceIndex(args, ["--bind", fullPath, fullPath]);
        expect(bindIdx).not.toBe(-1);

        if (reqPath.kind === "dir") {
          const dirIdx = findSequenceIndex(args, ["--dir", fullPath]);
          expect(dirIdx).not.toBe(-1);
          expect(dirIdx).toBeLessThan(bindIdx);
        } else {
          const fileIdx = findSequenceIndex(args, ["--ro-bind", "/dev/null", fullPath]);
          expect(fileIdx).not.toBe(-1);
          expect(fileIdx).toBeLessThan(bindIdx);
        }
      }
    });
  });

  describe("hide paths (overlays)", () => {
    test("includes ro-bind for each hide path", () => {
      const opts = makeOpts({
        hidePaths: ["/secret/dir", "/another/secret"],
      });
      const result = buildBwrapArgs(opts);
      Result.assertOk(result);
      const args = result.value;
      // Each hide path should have an ro-bind to an empty dir
      let foundSecret = false;
      let foundAnother = false;
      for (let i = 0; i < args.length - 2; i++) {
        if (args[i] === "--ro-bind" && args[i + 2] === "/secret/dir") {
          foundSecret = true;
        }
        if (args[i] === "--ro-bind" && args[i + 2] === "/another/secret") {
          foundAnother = true;
        }
      }
      expect(foundSecret).toBe(true);
      expect(foundAnother).toBe(true);
    });

    test("hide overlays come after RW binds (cwd only)", () => {
      const opts = makeOpts({
        cwd: "/home/user/project",
        hidePaths: ["/home/user/project/secrets"],
      });
      const result = buildBwrapArgs(opts);
      Result.assertOk(result);
      const args = result.value;

      // Find cwd bind
      let cwdBindIdx = -1;
      for (let i = 0; i < args.length - 2; i++) {
        if (
          args[i] === "--bind" &&
          args[i + 1] === "/home/user/project" &&
          args[i + 2] === "/home/user/project"
        ) {
          cwdBindIdx = i;
          break;
        }
      }

      // Find hide overlay
      let hideIdx = -1;
      for (let i = 0; i < args.length - 2; i++) {
        if (
          args[i] === "--ro-bind" &&
          args[i + 2] === "/home/user/project/secrets"
        ) {
          hideIdx = i;
          break;
        }
      }

      expect(cwdBindIdx).not.toBe(-1);
      expect(hideIdx).not.toBe(-1);
      // Hide must come after cwd bind so it "wins"
      expect(hideIdx).toBeGreaterThan(cwdBindIdx);
    });

    test("hide overlays come after ALL RW binds (cwd + tool config paths)", () => {
      const opts = makeOpts({
        cwd: "/home/user/project",
        home: "/home/user",
        cliDef: findCli("cc"),
        hidePaths: ["/home/user/project/secrets", "/home/user/.claude/secrets"],
      });
      const result = buildBwrapArgs(opts);
      Result.assertOk(result);
      const args = result.value;

      // Find ALL --bind operations (RW binds)
      const allBindIndices: number[] = [];
      for (let i = 0; i < args.length - 2; i++) {
        if (args[i] === "--bind") {
          allBindIndices.push(i);
        }
      }

      // Find the index of the LAST --bind operation
      const lastBindIdx = Math.max(...allBindIndices);
      expect(lastBindIdx).toBeGreaterThan(-1);

      // Find ALL hide overlays (--ro-bind for hidden paths)
      const hideOverlayIndices: number[] = [];
      for (const hidePath of opts.hidePaths) {
        for (let i = 0; i < args.length - 2; i++) {
          if (args[i] === "--ro-bind" && args[i + 2] === hidePath) {
            hideOverlayIndices.push(i);
            break;
          }
        }
      }

      // ALL hide overlays must come AFTER the last RW bind
      for (const hideIdx of hideOverlayIndices) {
        expect(hideIdx).toBeGreaterThan(lastBindIdx);
      }
    });

    test("hide overlays come after tool config binds when hiding inside config dir", () => {
      // Scenario: hiding a subdirectory inside .claude
      const opts = makeOpts({
        cwd: "/home/user/project",
        home: "/home/user",
        cliDef: findCli("cc"),
        hidePaths: ["/home/user/.claude/internal-cache"],
      });
      const result = buildBwrapArgs(opts);
      Result.assertOk(result);
      const args = result.value;

      // Find the --bind for .claude directory
      const claudeBindIdx = findSequenceIndex(args, [
        "--bind",
        "/home/user/.claude",
        "/home/user/.claude",
      ]);

      // Find the hide overlay
      let hideIdx = -1;
      for (let i = 0; i < args.length - 2; i++) {
        if (
          args[i] === "--ro-bind" &&
          args[i + 2] === "/home/user/.claude/internal-cache"
        ) {
          hideIdx = i;
          break;
        }
      }

      expect(claudeBindIdx).not.toBe(-1);
      expect(hideIdx).not.toBe(-1);
      // Hide must come after the config bind so it masks the subdirectory
      expect(hideIdx).toBeGreaterThan(claudeBindIdx);
    });

    test("multiple hide paths all come after last RW bind", () => {
      const opts = makeOpts({
        cwd: "/home/user/project",
        home: "/home/user",
        cliDef: findCli("cc"),
        hidePaths: [
          "/home/user/project/secrets",
          "/home/user/project/.env",
          "/home/user/.claude/credentials",
        ],
      });
      const result = buildBwrapArgs(opts);
      Result.assertOk(result);
      const args = result.value;

      // Find the last --bind index
      let lastBindIdx = -1;
      for (let i = 0; i < args.length - 2; i++) {
        if (args[i] === "--bind") {
          lastBindIdx = i;
        }
      }
      expect(lastBindIdx).not.toBe(-1);

      // Find all hide overlay indices
      for (const hidePath of opts.hidePaths) {
        let hideIdx = -1;
        for (let i = 0; i < args.length - 2; i++) {
          if (args[i] === "--ro-bind" && args[i + 2] === hidePath) {
            hideIdx = i;
            break;
          }
        }
        expect(hideIdx).not.toBe(-1);
        expect(hideIdx).toBeGreaterThan(lastBindIdx);
      }
    });
  });

  describe("tool execution", () => {
    test("includes tool path after --", () => {
      const opts = makeOpts({
        toolPath: "/usr/local/bin/claude",
        toolArgs: ["--help"],
      });
      const result = buildBwrapArgs(opts);
      Result.assertOk(result);
      const args = result.value;
      const dashDashIdx = args.indexOf("--");
      expect(dashDashIdx).not.toBe(-1);
      expect(args[dashDashIdx + 1]).toBe("/usr/local/bin/claude");
    });

    test("includes tool args after tool path", () => {
      const opts = makeOpts({
        toolPath: "/usr/bin/claude",
        toolArgs: ["--dangerously-skip-permissions", "--version"],
      });
      const result = buildBwrapArgs(opts);
      Result.assertOk(result);
      const args = result.value;
      const dashDashIdx = args.indexOf("--");
      expect(args[dashDashIdx + 1]).toBe("/usr/bin/claude");
      expect(args[dashDashIdx + 2]).toBe("--dangerously-skip-permissions");
      expect(args[dashDashIdx + 3]).toBe("--version");
    });
  });

  describe("mount ordering invariants", () => {
    test("ro-bind / / comes early", () => {
      const result = buildBwrapArgs(makeOpts());
      Result.assertOk(result);
      const args = result.value;
      // Find ro-bind / /
      let roBind = -1;
      for (let i = 0; i < args.length - 2; i++) {
        if (
          args[i] === "--ro-bind" &&
          args[i + 1] === "/" &&
          args[i + 2] === "/"
        ) {
          roBind = i;
          break;
        }
      }
      expect(roBind).not.toBe(-1);
      // Should be near the beginning (after --die-with-parent typically)
      expect(roBind).toBeLessThan(10);
    });

    test("--dev and --proc come after ro-bind /", () => {
      const result = buildBwrapArgs(makeOpts());
      Result.assertOk(result);
      const args = result.value;

      let roBindRoot = -1;
      for (let i = 0; i < args.length - 2; i++) {
        if (args[i] === "--ro-bind" && args[i + 1] === "/" && args[i + 2] === "/") {
          roBindRoot = i;
          break;
        }
      }

      const devIdx = args.indexOf("--dev");
      const procIdx = args.indexOf("--proc");

      expect(roBindRoot).not.toBe(-1);
      expect(devIdx).toBeGreaterThan(roBindRoot);
      expect(procIdx).toBeGreaterThan(roBindRoot);
    });

    test("argv is deterministic for same inputs", () => {
      const opts = makeOpts({
        hidePaths: ["/path/a", "/path/b"],
        hideHome: true,
      });
      const result1 = buildBwrapArgs(opts);
      const result2 = buildBwrapArgs(opts);

      Result.assertOk(result1);
      Result.assertOk(result2);
      expect(result1.value).toEqual(result2.value);
    });
  });
});

describe("buildBwrapCommand", () => {
  test("returns cmd as 'bwrap'", () => {
    const result = buildBwrapCommand(makeOpts());
    Result.assertOk(result);
    expect(result.value.cmd).toBe("bwrap");
  });

  test("returns args from buildBwrapArgs", () => {
    const opts = makeOpts();
    const argsResult = buildBwrapArgs(opts);
    const cmdResult = buildBwrapCommand(opts);

    Result.assertOk(argsResult);
    Result.assertOk(cmdResult);
    expect(cmdResult.value.args).toEqual(argsResult.value);
  });

  test("output is JSON serializable", () => {
    const result = buildBwrapCommand(makeOpts());
    Result.assertOk(result);
    const json = JSON.stringify(result.value);
    const parsed = JSON.parse(json);
    expect(parsed.cmd).toBe("bwrap");
    expect(Array.isArray(parsed.args)).toBe(true);
  });
});
