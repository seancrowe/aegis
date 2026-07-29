/**
 * Unit tests for argument normalization and YOLO flag handling.
 * Tests that YOLO flags are properly deduplicated and aegis flags are filtered.
 */
import { describe, test, expect } from "bun:test";
import {
  dedupeFlag,
  normalizeToolArgs,
  filterAegisFlags,
  getCliDef,
} from "../../src/tools/tool";
import { defaultCliDefs } from "../../src/tools/catalog";
import type { CliDef } from "../../src/types";

// Build lookup from defaults (replaces 6 individual imports)
const defaults = defaultCliDefs();
const findCli = (sub: string): CliDef => {
  const c = defaults.find(c => c.subCommand === sub);
  if (!c) throw new Error(`No default CLI with subCommand "${sub}"`);
  return c;
};

describe("dedupeFlag", () => {
  test("adds flag if not present", () => {
    const args = ["--version"];
    const result = dedupeFlag(args, "--yolo");
    expect(result).toEqual(["--yolo", "--version"]);
  });

  test("keeps single flag unchanged (moves to front)", () => {
    const args = ["--other", "--yolo", "--version"];
    const result = dedupeFlag(args, "--yolo");
    expect(result).toEqual(["--yolo", "--other", "--version"]);
  });

  test("removes duplicate flags and keeps one at front", () => {
    const args = ["--yolo", "--version", "--yolo"];
    const result = dedupeFlag(args, "--yolo");
    expect(result).toEqual(["--yolo", "--version"]);
  });

  test("handles multiple duplicates", () => {
    const args = ["--yolo", "--yolo", "--yolo", "--other"];
    const result = dedupeFlag(args, "--yolo");
    expect(result).toEqual(["--yolo", "--other"]);
  });

  test("handles empty args", () => {
    const args: string[] = [];
    const result = dedupeFlag(args, "--yolo");
    expect(result).toEqual(["--yolo"]);
  });

  test("handles flag at end", () => {
    const args = ["--first", "--second", "--yolo"];
    const result = dedupeFlag(args, "--yolo");
    expect(result).toEqual(["--yolo", "--first", "--second"]);
  });

  test("preserves order of non-flag arguments", () => {
    const args = ["arg1", "--yolo", "arg2", "--other", "--yolo", "arg3"];
    const result = dedupeFlag(args, "--yolo");
    expect(result).toEqual(["--yolo", "arg1", "arg2", "--other", "arg3"]);
  });
});

describe("normalizeToolArgs", () => {
  describe("claude code", () => {
    const cli = findCli("claude");

    test("injects YOLO flag when not present", () => {
      const args = ["--version"];
      const result = normalizeToolArgs(args, cli);
      expect(result).toEqual(["--dangerously-skip-permissions", "--version"]);
    });

    test("dedupes YOLO flag when present once", () => {
      const args = ["--dangerously-skip-permissions", "--version"];
      const result = normalizeToolArgs(args, cli);
      expect(result).toEqual(["--dangerously-skip-permissions", "--version"]);
    });

    test("dedupes YOLO flag when present multiple times", () => {
      const args = [
        "--dangerously-skip-permissions",
        "--version",
        "--dangerously-skip-permissions",
      ];
      const result = normalizeToolArgs(args, cli);
      expect(result).toEqual(["--dangerously-skip-permissions", "--version"]);
    });

    test("handles empty args", () => {
      const args: string[] = [];
      const result = normalizeToolArgs(args, cli);
      expect(result).toEqual(["--dangerously-skip-permissions"]);
    });
  });

  describe("codex", () => {
    const cli = findCli("codex");

    test("injects YOLO flag when not present", () => {
      const args = ["--version"];
      const result = normalizeToolArgs(args, cli);
      expect(result).toEqual([
        "--dangerously-bypass-approvals-and-sandbox",
        "--version",
      ]);
    });

    test("dedupes YOLO flag when present", () => {
      const args = [
        "--dangerously-bypass-approvals-and-sandbox",
        "--help",
        "--dangerously-bypass-approvals-and-sandbox",
      ];
      const result = normalizeToolArgs(args, cli);
      expect(result).toEqual([
        "--dangerously-bypass-approvals-and-sandbox",
        "--help",
      ]);
    });
  });

  describe("gemini", () => {
    const cli = findCli("gemini");

    test("injects YOLO flag when not present", () => {
      const args = ["--version"];
      const result = normalizeToolArgs(args, cli);
      expect(result).toEqual(["--yolo", "--version"]);
    });

    test("dedupes YOLO flag when present", () => {
      const args = ["--yolo", "--help", "--yolo"];
      const result = normalizeToolArgs(args, cli);
      expect(result).toEqual(["--yolo", "--help"]);
    });
  });

  describe("crush", () => {
    const cli = findCli("crush");

    test("injects YOLO flag when not present", () => {
      const args = ["--version"];
      const result = normalizeToolArgs(args, cli);
      expect(result).toEqual(["--yolo", "--version"]);
    });

    test("dedupes YOLO flag when present", () => {
      const args = ["--yolo", "--help", "--yolo"];
      const result = normalizeToolArgs(args, cli);
      expect(result).toEqual(["--yolo", "--help"]);
    });
  });

  describe("auggie", () => {
    const cli = findCli("auggie");

    test("does not inject a YOLO flag", () => {
      const args = ["--version"];
      const result = normalizeToolArgs(args, cli);
      expect(result).toEqual(["--version"]);
    });
  });

  describe("opencode", () => {
    const cli = findCli("opencode");

    test("does not inject a YOLO flag", () => {
      const args = ["--version"];
      const result = normalizeToolArgs(args, cli);
      expect(result).toEqual(["--version"]);
    });
  });
});

describe("filterAegisFlags", () => {
  test("removes --hide-home flag", () => {
    const args = ["--hide-home", "--version"];
    const result = filterAegisFlags(args);
    expect(result).toEqual(["--version"]);
  });

  test("removes --hide flag with value", () => {
    const args = ["--hide", "/path/to/hide", "--version"];
    const result = filterAegisFlags(args);
    expect(result).toEqual(["--version"]);
  });

  test("removes multiple --hide flags", () => {
    const args = [
      "--hide",
      "/path1",
      "--version",
      "--hide",
      "/path2",
      "--hide",
      "/path3",
    ];
    const result = filterAegisFlags(args);
    expect(result).toEqual(["--version"]);
  });

  test("removes --dry-run flag", () => {
    const args = ["--dry-run", "--version"];
    const result = filterAegisFlags(args);
    expect(result).toEqual(["--version"]);
  });

  test("preserves all non-aegis flags", () => {
    const args = [
      "--dangerously-skip-permissions",
      "--version",
      "--some-other-flag",
    ];
    const result = filterAegisFlags(args);
    expect(result).toEqual([
      "--dangerously-skip-permissions",
      "--version",
      "--some-other-flag",
    ]);
  });

  test("handles args with = syntax", () => {
    const args = ["--hide=/path/to/hide", "--version"];
    const result = filterAegisFlags(args);
    expect(result).toEqual(["--version"]);
  });

  test("handles empty args", () => {
    const args: string[] = [];
    const result = filterAegisFlags(args);
    expect(result).toEqual([]);
  });

  test("handles only aegis flags", () => {
    const args = ["--hide-home", "--hide", "/path", "--dry-run"];
    const result = filterAegisFlags(args);
    expect(result).toEqual([]);
  });

  test("removes --writable flag with value", () => {
    const args = ["--writable", "/extra/path", "--version"];
    const result = filterAegisFlags(args);
    expect(result).toEqual(["--version"]);
  });

  test("removes -w short flag with value", () => {
    const args = ["-w", "/extra/path", "--version"];
    const result = filterAegisFlags(args);
    expect(result).toEqual(["--version"]);
  });

  test("removes multiple --writable flags", () => {
    const args = [
      "--writable",
      "/path1",
      "--version",
      "-w",
      "/path2",
      "--writable",
      "/path3",
    ];
    const result = filterAegisFlags(args);
    expect(result).toEqual(["--version"]);
  });

  test("removes --writable= syntax", () => {
    const args = ["--writable=/extra/path", "--version"];
    const result = filterAegisFlags(args);
    expect(result).toEqual(["--version"]);
  });
});

describe("getCliDef", () => {
  test("returns claude code CLI def", () => {
    const cli = getCliDef("claude", defaults);
    expect(cli).toBeDefined();
    expect(cli!.subCommand).toBe("claude");
    expect(cli!.cliCmd).toBe("claude");
    expect(cli!.yoloArg).toBe("--dangerously-skip-permissions");
    expect(cli!.rwPaths).toContainEqual({ kind: "dir", path: ".claude" });
    expect(cli!.rwPaths).toContainEqual({ kind: "file", path: ".claude.json" });
  });

  test("returns codex CLI def", () => {
    const cli = getCliDef("codex", defaults);
    expect(cli).toBeDefined();
    expect(cli!.subCommand).toBe("codex");
    expect(cli!.cliCmd).toBe("codex");
    expect(cli!.yoloArg).toBe("--dangerously-bypass-approvals-and-sandbox");
    expect(cli!.rwPaths).toContainEqual({ kind: "dir", path: ".codex" });
  });

  test("returns gemini CLI def", () => {
    const cli = getCliDef("gemini", defaults);
    expect(cli).toBeDefined();
    expect(cli!.subCommand).toBe("gemini");
    expect(cli!.cliCmd).toBe("gemini");
    expect(cli!.yoloArg).toBe("--yolo");
    expect(cli!.rwPaths).toContainEqual({ kind: "dir", path: ".gemini" });
  });

  test("returns auggie CLI def", () => {
    const cli = getCliDef("auggie", defaults);
    expect(cli).toBeDefined();
    expect(cli!.subCommand).toBe("auggie");
    expect(cli!.cliCmd).toBe("augment");
    expect(cli!.yoloArg).toBeUndefined();
    expect(cli!.rwPaths).toContainEqual({ kind: "dir", path: ".augment" });
    expect(cli!.rwPaths).toContainEqual({ kind: "file", path: ".augment/settings.json" });
  });

  test("returns opencode CLI def", () => {
    const cli = getCliDef("opencode", defaults);
    expect(cli).toBeDefined();
    expect(cli!.subCommand).toBe("opencode");
    expect(cli!.cliCmd).toBe("opencode");
    expect(cli!.yoloArg).toBeUndefined();
    expect(cli!.rwPaths).toContainEqual({ kind: "dir", path: ".config/opencode" });
    expect(cli!.rwPaths).toContainEqual({ kind: "file", path: ".config/opencode/opencode.json" });
    expect(cli!.rwPaths).toContainEqual({ kind: "dir", path: ".local/share/opencode" });
    expect(cli!.rwPaths).toContainEqual({ kind: "file", path: ".local/share/opencode/auth.json" });
  });

  test("returns crush CLI def", () => {
    const cli = getCliDef("crush", defaults);
    expect(cli).toBeDefined();
    expect(cli!.subCommand).toBe("crush");
    expect(cli!.cliCmd).toBe("crush");
    expect(cli!.yoloArg).toBe("--yolo");
    expect(cli!.rwPaths).toContainEqual({ kind: "dir", path: ".config/crush" });
    expect(cli!.rwPaths).toContainEqual({ kind: "file", path: ".config/crush/crush.json" });
  });
});

describe("CLI defs", () => {
  test("claude code CLI def has correct structure", () => {
    const cli = findCli("claude");
    expect(cli.name).toBe("claude code");
    expect(cli.cliCmd).toBe("claude");
    expect(cli.yoloArg).toBe("--dangerously-skip-permissions");
    expect(cli.rwPaths.length).toBeGreaterThan(0);
  });

  test("codex CLI def has correct structure", () => {
    const cli = findCli("codex");
    expect(cli.name).toBe("codex");
    expect(cli.cliCmd).toBe("codex");
    expect(cli.yoloArg).toBe("--dangerously-bypass-approvals-and-sandbox");
    expect(cli.rwPaths.length).toBeGreaterThan(0);
  });

  test("gemini CLI def has correct structure", () => {
    const cli = findCli("gemini");
    expect(cli.name).toBe("gemini");
    expect(cli.cliCmd).toBe("gemini");
    expect(cli.yoloArg).toBe("--yolo");
    expect(cli.rwPaths.length).toBeGreaterThan(0);
  });

  test("auggie CLI def has correct structure", () => {
    const cli = findCli("auggie");
    expect(cli.name).toBe("augment");
    expect(cli.cliCmd).toBe("augment");
    expect(cli.yoloArg).toBeUndefined();
    expect(cli.rwPaths.length).toBeGreaterThan(0);
  });

  test("opencode CLI def has correct structure", () => {
    const cli = findCli("opencode");
    expect(cli.name).toBe("opencode");
    expect(cli.cliCmd).toBe("opencode");
    expect(cli.yoloArg).toBeUndefined();
    expect(cli.rwPaths.length).toBeGreaterThan(0);
  });

  test("crush CLI def has correct structure", () => {
    const cli = findCli("crush");
    expect(cli.name).toBe("crush");
    expect(cli.cliCmd).toBe("crush");
    expect(cli.yoloArg).toBe("--yolo");
    expect(cli.rwPaths.length).toBeGreaterThan(0);
  });
});
