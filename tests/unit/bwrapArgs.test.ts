/**
 * Unit tests for bubblewrap argument building.
 * Tests the pure function that generates bwrap argv from options.
 */
import { describe, test, expect } from "bun:test";
import { tmpdir } from "node:os";
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
    toolChain: [],
    toolArgs: ["--version"],
    hideHome: false,
    hidePaths: [],
    extraWritable: [],
    emptyDir: "",
    homeEntries: [],
    cwdOverrides: [],
    projectOverrides: [],
    tmpPaths: [],
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
  describe("extraWritable", () => {
    test("RW-binds an existing extra path", () => {
      // tmpdir() exists on every host; use it as a stand-in for a cache dir.
      const real = tmpdir();
      const result = buildBwrapArgs(makeOpts({ extraWritable: [real] }));
      Result.assertOk(result);
      expect(containsSequence(result.value, ["--bind", real, real])).toBe(true);
    });

    test("skips a non-existent extra path (no bwrap bind error)", () => {
      const missing = "/no/such/cache/dir-xyz";
      const result = buildBwrapArgs(makeOpts({ extraWritable: [missing] }));
      Result.assertOk(result);
      expect(result.value).not.toContain(missing);
    });

    test("extra binds come before hide overlays", () => {
      const real = tmpdir();
      const result = buildBwrapArgs(
        makeOpts({ extraWritable: [real], hidePaths: ["/home/user/.ssh"], emptyDir: "/tmp/empty" })
      );
      Result.assertOk(result);
      const bindIdx = findSequenceIndex(result.value, ["--bind", real, real]);
      const hideIdx = findSequenceIndex(result.value, ["--ro-bind", "/tmp/empty", "/home/user/.ssh"]);
      expect(bindIdx).toBeGreaterThanOrEqual(0);
      expect(hideIdx).toBeGreaterThan(bindIdx);
    });
  });

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

    test("includes --bind $HOME $HOME without hide-home", () => {
      const result = buildBwrapArgs(makeOpts({ hideHome: false }));
      Result.assertOk(result);
      expect(containsSequence(result.value, ["--bind", "/home/user", "/home/user"])).toBe(true);
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
    test("includes RW bind for claude dir but not file rwPaths", () => {
      const opts = makeOpts({
        cliDef: findCli("cc"),
        home: "/home/user",
      });
      const result = buildBwrapArgs(opts);
      Result.assertOk(result);
      // Should bind .claude directory (dir rwPath)
      expect(
        containsSequence(result.value, [
          "--bind",
          "/home/user/.claude",
          "/home/user/.claude",
        ])
      ).toBe(true);
      // Should NOT individually bind .claude.json (file rwPath, direct child)
      // — it stays writable as part of --bind $HOME to enable atomic writes
      expect(
        containsSequence(result.value, [
          "--bind",
          "/home/user/.claude.json",
          "/home/user/.claude.json",
        ])
      ).toBe(false);
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

  describe("non-hideHome with homeEntries", () => {
    test("includes --bind $HOME $HOME without hide-home", () => {
      const result = buildBwrapArgs(makeOpts({
        hideHome: false,
        homeEntries: [".bashrc", ".config"],
      }));
      Result.assertOk(result);
      expect(containsSequence(result.value, ["--bind", "/home/user", "/home/user"])).toBe(true);
    });

    test("includes --ro-bind for each homeEntry", () => {
      const result = buildBwrapArgs(makeOpts({
        hideHome: false,
        homeEntries: [".bashrc", ".config", ".gitconfig"],
      }));
      Result.assertOk(result);
      const args = result.value;
      expect(containsSequence(args, ["--ro-bind", "/home/user/.bashrc", "/home/user/.bashrc"])).toBe(true);
      expect(containsSequence(args, ["--ro-bind", "/home/user/.config", "/home/user/.config"])).toBe(true);
      expect(containsSequence(args, ["--ro-bind", "/home/user/.gitconfig", "/home/user/.gitconfig"])).toBe(true);
    });

    test("ro-binds come after --bind $HOME and before RW binds", () => {
      const result = buildBwrapArgs(makeOpts({
        hideHome: false,
        homeEntries: [".bashrc", ".claude", ".claude.json"],
      }));
      Result.assertOk(result);
      const args = result.value;

      const bindHomeIdx = findSequenceIndex(args, ["--bind", "/home/user", "/home/user"]);
      const roBashrcIdx = findSequenceIndex(args, ["--ro-bind", "/home/user/.bashrc", "/home/user/.bashrc"]);
      const rwClaudeIdx = findSequenceIndex(args, ["--bind", "/home/user/.claude", "/home/user/.claude"]);

      expect(bindHomeIdx).not.toBe(-1);
      expect(roBashrcIdx).not.toBe(-1);
      expect(rwClaudeIdx).not.toBe(-1);
      expect(roBashrcIdx).toBeGreaterThan(bindHomeIdx);
      expect(rwClaudeIdx).toBeGreaterThan(roBashrcIdx);
    });

    test("RW binds for dir rwPaths come after ro-binds (override RO with RW)", () => {
      const result = buildBwrapArgs(makeOpts({
        hideHome: false,
        homeEntries: [".claude", ".claude.json", ".npmrc"],
      }));
      Result.assertOk(result);
      const args = result.value;

      // ro-bind for .claude (from homeEntries — dir rwPath is still ro-bound)
      const roClaudeIdx = findSequenceIndex(args, ["--ro-bind", "/home/user/.claude", "/home/user/.claude"]);
      // RW bind for .claude (from rwPaths — dir rwPath gets individual --bind)
      const rwClaudeIdx = findSequenceIndex(args, ["--bind", "/home/user/.claude", "/home/user/.claude"]);

      expect(roClaudeIdx).not.toBe(-1);
      expect(rwClaudeIdx).not.toBe(-1);
      expect(rwClaudeIdx).toBeGreaterThan(roClaudeIdx);

      // .claude.json (file rwPath, direct child) should NOT be individually bound
      expect(containsSequence(args, ["--bind", "/home/user/.claude.json", "/home/user/.claude.json"])).toBe(false);
      // .claude.json should also NOT be ro-bound (excluded from ro-bind overlay)
      expect(containsSequence(args, ["--ro-bind", "/home/user/.claude.json", "/home/user/.claude.json"])).toBe(false);
    });

    test("dir rwPaths in homeEntries are ro-bound then overridden; file rwPaths are neither", () => {
      const result = buildBwrapArgs(makeOpts({
        hideHome: false,
        homeEntries: [".claude", ".claude.json"],
        cliDef: findCli("cc"),
      }));
      Result.assertOk(result);
      const args = result.value;

      // .claude (dir rwPath) should appear as --ro-bind (from homeEntries) then --bind (from rwPaths)
      const roClaudeIdx = findSequenceIndex(args, ["--ro-bind", "/home/user/.claude", "/home/user/.claude"]);
      const rwClaudeIdx = findSequenceIndex(args, ["--bind", "/home/user/.claude", "/home/user/.claude"]);
      expect(roClaudeIdx).not.toBe(-1);
      expect(rwClaudeIdx).not.toBe(-1);
      expect(rwClaudeIdx).toBeGreaterThan(roClaudeIdx);

      // .claude.json (file rwPath, direct child) should NOT appear as --ro-bind or --bind
      // It stays writable as part of --bind $HOME to enable atomic writes
      expect(containsSequence(args, ["--ro-bind", "/home/user/.claude.json", "/home/user/.claude.json"])).toBe(false);
      expect(containsSequence(args, ["--bind", "/home/user/.claude.json", "/home/user/.claude.json"])).toBe(false);
    });

    test("homeEntries are deterministic (sorted order)", () => {
      const entries = [".zshrc", ".bashrc", ".config", ".aws"];
      const result1 = buildBwrapArgs(makeOpts({ hideHome: false, homeEntries: entries }));
      const result2 = buildBwrapArgs(makeOpts({ hideHome: false, homeEntries: entries }));

      Result.assertOk(result1);
      Result.assertOk(result2);
      expect(result1.value).toEqual(result2.value);
    });

    test("empty homeEntries produces no ro-binds for home entries", () => {
      const result = buildBwrapArgs(makeOpts({
        hideHome: false,
        homeEntries: [],
      }));
      Result.assertOk(result);
      const args = result.value;

      // Should have --bind $HOME $HOME
      expect(containsSequence(args, ["--bind", "/home/user", "/home/user"])).toBe(true);

      // Should not have any --ro-bind for home entries (only --ro-bind / / and hide overlays)
      let homeRoBindCount = 0;
      for (let i = 0; i < args.length - 2; i++) {
        if (args[i] === "--ro-bind" && args[i + 1]!.startsWith("/home/user/.")) {
          homeRoBindCount++;
        }
      }
      expect(homeRoBindCount).toBe(0);
    });

    test("hideHome mode does not produce ro-binds for homeEntries", () => {
      const result = buildBwrapArgs(makeOpts({
        hideHome: true,
        homeEntries: [".bashrc", ".config"],
      }));
      Result.assertOk(result);
      const args = result.value;

      // Should NOT have ro-bind for .bashrc (hideHome uses --dir/--ro-bind /dev/null instead)
      expect(containsSequence(args, ["--ro-bind", "/home/user/.bashrc", "/home/user/.bashrc"])).toBe(false);
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

  describe("CWD and project overrides", () => {
    test("cwdOverrides produce --ro-bind args", () => {
      const opts = makeOpts({
        cwdOverrides: [
          { target: "/home/user/project/.env", source: "/dev/null", kind: "file" },
        ],
      });
      const result = buildBwrapArgs(opts);
      Result.assertOk(result);
      const args = result.value;
      expect(containsSequence(args, ["--ro-bind", "/dev/null", "/home/user/project/.env"])).toBe(true);
    });

    test("projectOverrides produce --ro-bind args", () => {
      const opts = makeOpts({
        projectOverrides: [
          { target: "/home/user/project/secrets", source: "/tmp/empty", kind: "dir" },
        ],
      });
      const result = buildBwrapArgs(opts);
      Result.assertOk(result);
      const args = result.value;
      expect(containsSequence(args, ["--ro-bind", "/tmp/empty", "/home/user/project/secrets"])).toBe(true);
    });

    test("projectOverrides come after cwdOverrides (higher precedence)", () => {
      const opts = makeOpts({
        cwdOverrides: [
          { target: "/home/user/project/.env", source: "/dev/null", kind: "file" },
        ],
        projectOverrides: [
          { target: "/home/user/project/.env", source: "/home/user/project/.env.sandbox", kind: "file" },
        ],
      });
      const result = buildBwrapArgs(opts);
      Result.assertOk(result);
      const args = result.value;

      // Find the two --ro-bind entries for .env
      let cwdIdx = -1;
      let projIdx = -1;
      for (let i = 0; i < args.length - 2; i++) {
        if (args[i] === "--ro-bind" && args[i + 2] === "/home/user/project/.env") {
          if (args[i + 1] === "/dev/null") cwdIdx = i;
          if (args[i + 1] === "/home/user/project/.env.sandbox") projIdx = i;
        }
      }
      expect(cwdIdx).not.toBe(-1);
      expect(projIdx).not.toBe(-1);
      expect(projIdx).toBeGreaterThan(cwdIdx);
    });

    test("overrides come after hide overlays", () => {
      const opts = makeOpts({
        hidePaths: ["/home/user/.ssh"],
        emptyDir: "/tmp/aegis-empty",
        cwdOverrides: [
          { target: "/home/user/project/.env", source: "/dev/null", kind: "file" },
        ],
      });
      const result = buildBwrapArgs(opts);
      Result.assertOk(result);
      const args = result.value;

      let hideIdx = -1;
      let overrideIdx = -1;
      for (let i = 0; i < args.length - 2; i++) {
        if (args[i] === "--ro-bind" && args[i + 2] === "/home/user/.ssh") hideIdx = i;
        if (args[i] === "--ro-bind" && args[i + 2] === "/home/user/project/.env") overrideIdx = i;
      }
      expect(hideIdx).not.toBe(-1);
      expect(overrideIdx).not.toBe(-1);
      expect(overrideIdx).toBeGreaterThan(hideIdx);
    });

    test("overrides come before -- (tool execution)", () => {
      const opts = makeOpts({
        projectOverrides: [
          { target: "/home/user/project/.env", source: "/dev/null", kind: "file" },
        ],
      });
      const result = buildBwrapArgs(opts);
      Result.assertOk(result);
      const args = result.value;

      let overrideIdx = -1;
      for (let i = 0; i < args.length - 2; i++) {
        if (args[i] === "--ro-bind" && args[i + 2] === "/home/user/project/.env") {
          overrideIdx = i;
        }
      }
      const dashDashIdx = args.indexOf("--");
      expect(overrideIdx).not.toBe(-1);
      expect(overrideIdx).toBeLessThan(dashDashIdx);
    });

    test("empty override arrays produce no extra args", () => {
      const opts = makeOpts({ cwdOverrides: [], projectOverrides: [] });
      const baseline = makeOpts();
      const result = buildBwrapArgs(opts);
      const baselineResult = buildBwrapArgs(baseline);
      Result.assertOk(result);
      Result.assertOk(baselineResult);
      expect(result.value).toEqual(baselineResult.value);
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

    test("--bind $HOME comes after --ro-bind / / (non-hideHome)", () => {
      const result = buildBwrapArgs(makeOpts({
        homeEntries: [".bashrc"],
      }));
      Result.assertOk(result);
      const args = result.value;

      const roBindRoot = findSequenceIndex(args, ["--ro-bind", "/", "/"]);
      const bindHome = findSequenceIndex(args, ["--bind", "/home/user", "/home/user"]);

      expect(roBindRoot).not.toBe(-1);
      expect(bindHome).not.toBe(-1);
      expect(bindHome).toBeGreaterThan(roBindRoot);
    });

    test("homeEntry ro-binds come after --bind $HOME", () => {
      const result = buildBwrapArgs(makeOpts({
        homeEntries: [".bashrc", ".config"],
      }));
      Result.assertOk(result);
      const args = result.value;

      const bindHome = findSequenceIndex(args, ["--bind", "/home/user", "/home/user"]);
      const roBashrc = findSequenceIndex(args, ["--ro-bind", "/home/user/.bashrc", "/home/user/.bashrc"]);

      expect(bindHome).not.toBe(-1);
      expect(roBashrc).not.toBe(-1);
      expect(roBashrc).toBeGreaterThan(bindHome);
    });

    test("RW binds come after homeEntry ro-binds", () => {
      const result = buildBwrapArgs(makeOpts({
        homeEntries: [".bashrc", ".claude"],
      }));
      Result.assertOk(result);
      const args = result.value;

      // Find the last homeEntry ro-bind (.claude is a dir rwPath, still ro-bound)
      const roClaude = findSequenceIndex(args, ["--ro-bind", "/home/user/.claude", "/home/user/.claude"]);

      // Find the first RW --bind after --bind $HOME
      const bindHome = findSequenceIndex(args, ["--bind", "/home/user", "/home/user"]);
      let firstNonHomeBind = -1;
      for (let i = bindHome + 3; i < args.length - 2; i++) {
        if (args[i] === "--bind") {
          firstNonHomeBind = i;
          break;
        }
      }

      expect(roClaude).not.toBe(-1);
      expect(firstNonHomeBind).not.toBe(-1);
      expect(firstNonHomeBind).toBeGreaterThan(roClaude);
    });

    test("hide overlays come after all RW binds (with homeEntries)", () => {
      const result = buildBwrapArgs(makeOpts({
        homeEntries: [".bashrc", ".claude", ".claude.json"],
        hidePaths: ["/secret"],
        emptyDir: "/tmp/empty",
      }));
      Result.assertOk(result);
      const args = result.value;

      // Find the last --bind
      let lastBind = -1;
      for (let i = 0; i < args.length - 2; i++) {
        if (args[i] === "--bind") {
          lastBind = i;
        }
      }

      // Find the hide overlay
      const hideIdx = findSequenceIndex(args, ["--ro-bind", "/tmp/empty", "/secret"]);

      expect(lastBind).not.toBe(-1);
      expect(hideIdx).not.toBe(-1);
      expect(hideIdx).toBeGreaterThan(lastBind);
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

describe("buildBwrapArgs — tool binary carve-out", () => {
  // Real installers put both the launcher and its target under $HOME.
  // --tmpfs $HOME does not hide those paths so much as delete them, so exec
  // dies with ENOENT unless each hop is restored after the tmpfs.
  const chain = [
    {
      kind: "symlink" as const,
      path: "/home/user/.local/bin/claude",
      target: "/home/user/.local/share/claude/versions/1.0.0",
    },
    {
      kind: "file" as const,
      path: "/home/user/.local/share/claude/versions/1.0.0",
    },
  ];

  test("recreates symlinks and binds the file behind them under hide-home", () => {
    const result = buildBwrapArgs(
      makeOpts({
        toolPath: "/home/user/.local/bin/claude",
        toolChain: chain,
        hideHome: true,
      })
    );
    Result.assertOk(result);

    expect(
      containsSequence(result.value, [
        "--symlink",
        "/home/user/.local/share/claude/versions/1.0.0",
        "/home/user/.local/bin/claude",
      ])
    ).toBe(true);
    expect(
      containsSequence(result.value, [
        "--ro-bind",
        "/home/user/.local/share/claude/versions/1.0.0",
        "/home/user/.local/share/claude/versions/1.0.0",
      ])
    ).toBe(true);
  });

  test("carve-out comes after the tmpfs that would otherwise erase it", () => {
    const result = buildBwrapArgs(
      makeOpts({
        toolPath: "/home/user/.local/bin/claude",
        toolChain: chain,
        hideHome: true,
      })
    );
    Result.assertOk(result);

    const tmpfsHome = result.value.findIndex(
      (a, i) => a === "--tmpfs" && result.value[i + 1] === "/home/user"
    );
    const symlink = result.value.indexOf("--symlink");
    expect(tmpfsHome).toBeGreaterThanOrEqual(0);
    expect(symlink).toBeGreaterThan(tmpfsHome);
  });

  test("emits nothing when the chain is not masked", () => {
    const result = buildBwrapArgs(
      makeOpts({
        toolPath: "/home/user/.local/bin/claude",
        toolChain: chain,
        hideHome: false,
      })
    );
    Result.assertOk(result);
    expect(result.value).not.toContain("--symlink");
  });

  test("covers hops hidden by an explicit --hide rather than hide-home", () => {
    const result = buildBwrapArgs(
      makeOpts({
        toolPath: "/home/user/.local/bin/claude",
        toolChain: chain,
        hideHome: false,
        hidePaths: ["/home/user/.local/share"],
      })
    );
    Result.assertOk(result);
    expect(
      containsSequence(result.value, [
        "--ro-bind",
        "/home/user/.local/share/claude/versions/1.0.0",
        "/home/user/.local/share/claude/versions/1.0.0",
      ])
    ).toBe(true);
  });
});
