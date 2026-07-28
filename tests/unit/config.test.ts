/**
 * Unit tests for configuration management.
 * Tests config parsing, validation, and persistence.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Result } from "typescript-result";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import {
  defaultConfig,
  defaultHidePaths,
  expandHidePaths,
  expandUserPaths,
  defaultConfigContent,
  parseConfig,
  loadConfig,
  validateHidePaths,
  validatePolicyPath,
  getConfigPath,
} from "../../src/config/config";
import { defaultCliDefs } from "../../src/tools/catalog";

describe("defaultConfig", () => {
  test("returns expected default values", () => {
    const config = defaultConfig();
    expect(config.hideHomeAlways).toBe(false);
    expect(config.homeAccess).toBe("blocklist");
    expect(config.hide).toEqual(defaultHidePaths());
    expect(config.allowRead).toEqual([]);
    expect(config.hide.length).toBeGreaterThan(0);
    expect(config.cwdOverrides).toEqual([]);
    expect(config.tools).toEqual(defaultCliDefs());
    expect(config.tools.length).toBe(6);
  });

  test("returns a new object each time", () => {
    const config1 = defaultConfig();
    const config2 = defaultConfig();
    expect(config1).not.toBe(config2);
    expect(config1).toEqual(config2);
  });
});

describe("defaultConfigContent", () => {
  test("is valid TOML that parses to defaultConfig(), including tools (no drift)", () => {
    const result = parseConfig(defaultConfigContent());
    Result.assertOk(result);
    expect(result.value).toEqual(defaultConfig());
  });

  test("contains explanatory comments", () => {
    expect(defaultConfigContent()).toContain("#");
    expect(defaultConfigContent()).toContain("extraWritable");
    expect(defaultConfigContent()).toContain("[tools.cc]");
  });
});

describe("defaultCliDefs", () => {
  test("materializes all 6 catalog recipes", () => {
    const defs = defaultCliDefs();
    expect(defs.length).toBe(6);
  });

  test("each CLI has required fields", () => {
    for (const cli of defaultCliDefs()) {
      expect(typeof cli.name).toBe("string");
      expect(typeof cli.cliCmd).toBe("string");
      expect(typeof cli.subCommand).toBe("string");
      expect(Array.isArray(cli.rwPaths)).toBe(true);
    }
  });

  test("no duplicate subCommands", () => {
    const subs = defaultCliDefs().map(c => c.subCommand);
    expect(new Set(subs).size).toBe(subs.length);
  });
});

describe("defaultHidePaths", () => {
  test("returns non-empty array of tilde-prefixed paths", () => {
    const paths = defaultHidePaths();
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      expect(p.startsWith("~")).toBe(true);
    }
  });

  test("includes common sensitive directories", () => {
    const paths = defaultHidePaths();
    expect(paths).toContain("~/.ssh");
    expect(paths).toContain("~/.gnupg");
    expect(paths).toContain("~/.aws");
  });
});

describe("expandHidePaths", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "aegis-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("expands ~ to home directory", async () => {
    const sshDir = join(tempDir, ".ssh");
    await mkdir(sshDir);

    const result = expandHidePaths(["~/.ssh"], tempDir);
    expect(result).toEqual([sshDir]);
  });

  test("expands bare ~ to home directory", async () => {
    const result = expandHidePaths(["~"], tempDir);
    expect(result).toEqual([tempDir]);
  });

  test("passes through absolute paths unchanged", async () => {
    const absDir = join(tempDir, "abs");
    await mkdir(absDir);

    const result = expandHidePaths([absDir], tempDir);
    expect(result).toEqual([absDir]);
  });

  test("filters out non-existent paths", () => {
    const result = expandHidePaths(["~/.nonexistent", "/does/not/exist"], tempDir);
    expect(result).toEqual([]);
  });

  test("keeps existing paths and filters non-existent", async () => {
    const sshDir = join(tempDir, ".ssh");
    await mkdir(sshDir);

    const result = expandHidePaths(["~/.ssh", "~/.nonexistent"], tempDir);
    expect(result).toEqual([sshDir]);
  });

  test("handles empty array", () => {
    const result = expandHidePaths([], tempDir);
    expect(result).toEqual([]);
  });
});

describe("expandUserPaths", () => {
  test("expands ~ and ~/ to home", () => {
    expect(expandUserPaths(["~", "~/Library/Caches"], "/Users/u")).toEqual([
      "/Users/u",
      "/Users/u/Library/Caches",
    ]);
  });

  test("passes absolute paths through unchanged", () => {
    expect(expandUserPaths(["/opt/cache"], "/Users/u")).toEqual(["/opt/cache"]);
  });

  test("does NOT filter non-existent paths (unlike expandHidePaths)", () => {
    expect(expandUserPaths(["~/no-such-cache"], "/Users/u")).toEqual([
      "/Users/u/no-such-cache",
    ]);
  });

  test("provides the same ~ expansion used by allowRead", () => {
    expect(expandUserPaths(["~/.config/git"], "/Users/u")).toEqual([
      "/Users/u/.config/git",
    ]);
  });

  test("normalizes non-tilde paths", () => {
    expect(expandUserPaths(["/opt/one/../cache"], "/Users/u")).toEqual([
      "/opt/cache",
    ]);
  });
});

describe("parseConfig", () => {
  const rejectedPolicyPaths = [
    "~",
    "~/",
    "~/.",
    "~/./",
    "~//",
    "~/..",
    "~/../..",
    "~/x/../",
    "~/a/..//",
    "~/../shared",
    "~//../etc",
    "~//../../etc",
    "~///../../../tmp",
    "/",
    "/Users/../..",
    "foo",
    "../../..",
  ];
  const acceptedPolicyPaths = [
    "~/.npm",
    "~/a/../b",
    "~/Library/Caches",
    "~/foo/",
    "/Users/user",
    "/opt/cache",
  ];

  function policyConfig(
    source: "allowRead" | "extraWritable" | "tool",
    path: string
  ): string {
    const value = JSON.stringify(path);
    if (source === "tool") {
      return `hideHomeAlways = false
hide = []
[tools.x]
name = "x"
cliCmd = "x"
extraWritable = [${value}]
`;
    }
    return `hideHomeAlways = false
hide = []
${source} = [${value}]
`;
  }

  test("rejects traversal/root spellings across every config and CLI policy source", () => {
    for (const path of rejectedPolicyPaths) {
      for (const source of ["allowRead", "extraWritable", "tool"] as const) {
        const result = parseConfig(
          policyConfig(source, path),
          "/tmp/policy.toml"
        );
        Result.assertError(result);
        expect(result.error.message).toContain(JSON.stringify(path));
      }

      const cli = validatePolicyPath(path, "writable");
      Result.assertError(cli);
      expect(cli.error.message).toContain(JSON.stringify(path));
      expect(cli.error.message).not.toContain("/tmp/policy.toml");
    }
  });

  test("accepts strict subpaths and deliberate absolute paths across policy sources", () => {
    for (const path of acceptedPolicyPaths) {
      for (const source of ["allowRead", "extraWritable", "tool"] as const) {
        const result = parseConfig(policyConfig(source, path));
        Result.assertOk(result);
      }
      Result.assertOk(validatePolicyPath(path, "writable"));
    }
  });

  test("accepted tilde spellings always expand strictly inside home", () => {
    const home = "/property/home";
    const parts = ["", ".", "..", "a", "b"];
    const separators = ["/", "//"];
    const spellings = new Set<string>(["~", "~/"]);

    function addSpellings(prefix: string[], depth: number): void {
      if (depth === 0) {
        for (const separator of separators) {
          const remainder = prefix.join(separator);
          spellings.add(`~/${remainder}`);
          spellings.add(`~/${remainder}/`);
          spellings.add(`~/${remainder}//`);
        }
        return;
      }
      for (const part of parts) addSpellings([...prefix, part], depth - 1);
    }

    for (let depth = 1; depth <= 4; depth++) addSpellings([], depth);

    let accepted = 0;
    for (const spelling of spellings) {
      const validation = validatePolicyPath(spelling, "property");
      if (!validation.ok) continue;
      accepted++;
      const [expanded] = expandUserPaths([spelling], home);
      expect(expanded!.startsWith(`${home}/`)).toBe(true);
    }

    // Without this the property holds vacuously: a predicate that rejected
    // every spelling would satisfy the loop while testing nothing. Roughly
    // 1700 of these 4100 spellings are legitimate, so the floor is generous
    // enough to survive tightening the rule and strict enough to catch a
    // reject-everything regression.
    expect(accepted).toBeGreaterThan(1000);
  });

  test("uses distinct shorthand and traversal diagnostics", () => {
    for (const path of ["~/a/..", "~//", "/Users/../.."]) {
      const shorthand = validatePolicyPath(path, "writable");
      Result.assertError(shorthand);
      expect(shorthand.error.message).toContain(
        "home/root shorthand is not allowed"
      );
    }
    for (const path of ["~/../shared", "~//../../etc", "../../.."]) {
      const traversal = validatePolicyPath(path, "writable");
      Result.assertError(traversal);
      expect(traversal.error.message).toContain(
        "traversal outside $HOME is not allowed - use an absolute path"
      );
    }
  });

  test("parses valid TOML", () => {
    const result = parseConfig(`
hideHomeAlways = true
hide = ["/path/one"]
`);
    Result.assertOk(result);
    expect(result.value.hideHomeAlways).toBe(true);
    expect(result.value.hide).toEqual(["/path/one"]);
  });

  test("parses empty hide array", () => {
    const result = parseConfig("hideHomeAlways = false\nhide = []\n");
    Result.assertOk(result);
    expect(result.value.hide).toEqual([]);
  });

  test("defaults omitted homeAccess to blocklist without changing old configs", () => {
    const legacy = parseConfig("hideHomeAlways = false\nhide = [\"~/.ssh\"]\n");
    const explicit = parseConfig(
      'hideHomeAlways = false\nhomeAccess = "blocklist"\nhide = ["~/.ssh"]\n'
    );
    Result.assertOk(legacy);
    Result.assertOk(explicit);
    expect(legacy.value).toEqual(explicit.value);
    expect(legacy.value.homeAccess).toBe("blocklist");
  });

  test("parses allowlist homeAccess and allowRead", () => {
    const result = parseConfig(`
hideHomeAlways = false
homeAccess = "allowlist"
hide = []
allowRead = ["~/.config/git", "~/Library/Fonts"]
`);
    Result.assertOk(result);
    expect(result.value.homeAccess).toBe("allowlist");
    expect(result.value.allowRead).toEqual([
      "~/.config/git",
      "~/Library/Fonts",
    ]);
  });

  test("rejects invalid homeAccess and names the valid values", () => {
    const result = parseConfig(
      'hideHomeAlways = false\nhomeAccess = "deny"\nhide = []',
      "/tmp/config.toml"
    );
    Result.assertError(result);
    expect(result.error.message).toContain("homeAccess");
    expect(result.error.message).toContain("blocklist");
    expect(result.error.message).toContain("allowlist");
  });

  test("defaults allowRead to [] and validates its entries", () => {
    const omitted = parseConfig("hideHomeAlways = false\nhide = []");
    Result.assertOk(omitted);
    expect(omitted.value.allowRead).toEqual([]);

    const invalid = parseConfig(
      'hideHomeAlways = false\nhide = []\nallowRead = [42]'
    );
    Result.assertError(invalid);
    expect(invalid.error.message).toContain("allowRead");
  });

  test("rejects home/root shorthand in allowRead and names value and file", () => {
    for (const path of ["~", "~/", "~//", "~/cache/..", "/", "/tmp/.."]) {
      const result = parseConfig(
        `hideHomeAlways = false
hide = []
allowRead = [${JSON.stringify(path)}]
`,
        "/tmp/allow-read.toml"
      );
      Result.assertError(result);
      expect(result.error.message).toContain("/tmp/allow-read.toml");
      expect(result.error.message).toContain(JSON.stringify(path));
    }
  });

  test("allows an explicit absolute home path in allowRead", () => {
    const result = parseConfig(
      'hideHomeAlways = false\nhide = []\nallowRead = ["/Users/user"]'
    );
    Result.assertOk(result);
    expect(result.value.allowRead).toEqual(["/Users/user"]);
  });

  test("surfaces the config path qualified by line and column", () => {
    const result = parseConfig(
      "hideHomeAlways = false\nhide = [\n",
      "/tmp/config.toml"
    );
    Result.assertError(result);
    // Assert aegis's own "<path>:<line>:<column>: " prefix shape, not Bun's
    // wording or exact column, which may change across Bun versions. The
    // \d+ for column plus the required ":<line>:" distinguishes this branch
    // from the bare "<path>: " fallback.
    expect(result.error.message).toMatch(/^\/tmp\/config\.toml:2:\d+: \S/);
  });

  test("fails on missing hideHomeAlways", () => {
    const result = parseConfig("hide = []");
    Result.assertError(result);
  });

  test("fails on missing hide", () => {
    const result = parseConfig("hideHomeAlways = false");
    Result.assertError(result);
  });

  test("fails on wrong type for hideHomeAlways", () => {
    const result = parseConfig('hideHomeAlways = "yes"\nhide = []');
    Result.assertError(result);
  });

  test("fails on wrong type for hide", () => {
    const result = parseConfig(
      'hideHomeAlways = false\nhide = "not an array"'
    );
    Result.assertError(result);
  });

  test("fails on hide array with non-string elements", () => {
    const result = parseConfig(
      'hideHomeAlways = false\nhide = ["/valid", 123]'
    );
    Result.assertError(result);
  });

  test("error message includes field name for missing field", () => {
    const result = parseConfig("hideHomeAlways = false");
    Result.assertError(result);
    expect(result.error.message.toLowerCase()).toContain("hide");
  });

  test("rejects unknown top-level keys and names the key and file", () => {
    const result = parseConfig(
      'hideHomeAlways = false\nhide = []\nhidePaths = []',
      "/tmp/custom.toml"
    );
    Result.assertError(result);
    expect(result.error.message).toContain("hidePaths");
    expect(result.error.message).toContain("/tmp/custom.toml");
  });

  test("accepts TOML comments and trailing array commas", () => {
    const result = parseConfig(`
# line comment
hideHomeAlways = false
hide = [
  "~/.ssh", # trailing comment
]
extraWritable = ["~/.npm",]
`);
    Result.assertOk(result);
    expect(result.value.hide).toEqual(["~/.ssh"]);
    expect(result.value.extraWritable).toEqual(["~/.npm"]);
  });

  test("defaults extraWritable to [] when omitted", () => {
    const result = parseConfig("hideHomeAlways = false\nhide = []");
    Result.assertOk(result);
    expect(result.value.extraWritable).toEqual([]);
  });

  test("parses extraWritable entries", () => {
    const result = parseConfig(`
hideHomeAlways = false
hide = []
extraWritable = ["~/Library/Caches", "/opt/cache"]
`);
    Result.assertOk(result);
    expect(result.value.extraWritable).toEqual(["~/Library/Caches", "/opt/cache"]);
  });

  test("fails when extraWritable is not an array", () => {
    const result = parseConfig(
      'hideHomeAlways = false\nhide = []\nextraWritable = "~/Library/Caches"'
    );
    Result.assertError(result);
  });

  test("fails when extraWritable has non-string elements", () => {
    const result = parseConfig(
      'hideHomeAlways = false\nhide = []\nextraWritable = ["/valid", 42]'
    );
    Result.assertError(result);
  });

  test("rejects home/root shorthand in extraWritable and names value and file", () => {
    for (const path of ["~", "~/", "~//", "~/cache/..", "/", "/tmp/.."]) {
      const result = parseConfig(
        `hideHomeAlways = false
hide = []
extraWritable = [${JSON.stringify(path)}]
`,
        "/tmp/extra-writable.toml"
      );
      Result.assertError(result);
      expect(result.error.message).toContain("/tmp/extra-writable.toml");
      expect(result.error.message).toContain(JSON.stringify(path));
    }
  });

  test("allows an explicit absolute home path in extraWritable", () => {
    const result = parseConfig(
      'hideHomeAlways = false\nhide = []\nextraWritable = ["/Users/user"]'
    );
    Result.assertOk(result);
    expect(result.value.extraWritable).toEqual(["/Users/user"]);
  });

  test("rejects controls in every configurable policy path", () => {
    const base = "hideHomeAlways = false\nhide = []\n";
    const cases = [
      base.replace("hide = []", 'hide = ["bad\\npath"]'),
      `${base}allowRead = ["bad\\tpath"]\n`,
      `${base}extraWritable = ["bad\\u007fpath"]\n`,
      `${base}
[tools.ok]
name = "probe"
cliCmd = "probe"
hide = ["bad\\npath"]
`,
      `${base}
[tools.ok]
name = "probe"
cliCmd = "probe"
extraWritable = ["bad\\tpath"]
`,
    ];

    for (const toml of cases) {
      const result = parseConfig(toml, "/tmp/control-path.toml");
      Result.assertError(result);
      expect(result.error.message).toContain("/tmp/control-path.toml");
      expect(result.error.message).toContain("control characters");
    }
  });

  test("rejects home/root spellings in global and per-tool hide paths", () => {
    for (const path of ["~", "~/../..", "/", "/Users/../.."]) {
      const encoded = JSON.stringify(path);
      const global = parseConfig(
        `hideHomeAlways = false\nhide = [${encoded}]\n`,
        "/tmp/hide-policy.toml"
      );
      Result.assertError(global);
      expect(global.error.message).toContain(encoded);

      const tool = parseConfig(
        `hideHomeAlways = false
hide = []
[tools.ok]
name = "probe"
cliCmd = "probe"
hide = [${encoded}]
`,
        "/tmp/hide-policy.toml"
      );
      Result.assertError(tool);
      expect(tool.error.message).toContain(encoded);
    }
  });

  test("allows quotes in hide, allowRead, and extraWritable paths", () => {
    const quoted = '/tmp/Library/Application Support/My "Stuff"';
    const result = parseConfig(`hideHomeAlways = false
hide = [${JSON.stringify(quoted)}]
allowRead = [${JSON.stringify(quoted)}]
extraWritable = [${JSON.stringify(quoted)}]

[tools.ok]
name = "probe"
cliCmd = "probe"
hide = [${JSON.stringify(quoted)}]
extraWritable = [${JSON.stringify(quoted)}]
`);
    Result.assertOk(result);
    expect(result.value.hide).toEqual([quoted]);
    expect(result.value.allowRead).toEqual([quoted]);
    expect(result.value.extraWritable).toEqual([quoted]);
    expect(result.value.tools[0]!.hide).toEqual([quoted]);
    expect(result.value.tools[0]!.extraWritable).toEqual([quoted]);
  });

  test("strips a leading BOM and parses the document", () => {
    const result = parseConfig("\uFEFFhideHomeAlways = false\nhide = []");
    Result.assertOk(result);
    expect(result.value.hide).toEqual([]);
  });

  test("rejects a genuinely keyless document", () => {
    const result = parseConfig("# comments only\n\n");
    Result.assertError(result);
    expect(result.error.message).toContain("no recognized top-level keys");
  });
});

describe("parseConfig - tools validation", () => {
  const base = "hideHomeAlways = false\nhide = []\n";

  test("yields no tools when the tools table is absent", () => {
    const result = parseConfig(base);
    Result.assertOk(result);
    expect(result.value.tools).toEqual([]);
  });

  test("a present-but-empty tools table yields no tools", () => {
    const result = parseConfig(`${base}\n[tools]\n`);
    Result.assertOk(result);
    expect(result.value.tools).toEqual([]);
  });

  test("table keys become subCommands and document order is preserved", () => {
    const result = parseConfig(`${base}
[tools.zed]
name = "Zed"
cliCmd = "zed"
[tools.alpha]
name = "Alpha"
cliCmd = "alpha"
`);
    Result.assertOk(result);
    expect(result.value.tools.map((tool) => tool.subCommand)).toEqual([
      "zed",
      "alpha",
    ]);
  });

  test("builds rwPaths with dirs before files regardless of field order", () => {
    const result = parseConfig(`${base}
[tools.t]
name = "test"
cliCmd = "test"
rwFiles = [".test/settings.json", ".test.json"]
rwDirs = [".test", ".cache/test"]
`);
    Result.assertOk(result);
    expect(result.value.tools[0]!.rwPaths).toEqual([
      { kind: "dir", path: ".test" },
      { kind: "dir", path: ".cache/test" },
      { kind: "file", path: ".test/settings.json" },
      { kind: "file", path: ".test.json" },
    ]);
  });

  test("rejects rwPaths as an on-disk key with migration guidance", () => {
    const result = parseConfig(`${base}
[tools.t]
name = "test"
cliCmd = "test"
rwPaths = []
`);
    Result.assertError(result);
    expect(result.error.message).toContain("rwPaths");
    expect(result.error.message).toContain("rwDirs/rwFiles");
  });

  test("rejects paths that resolve to home, traverse, or use tilde", () => {
    const invalidPaths = [
      ["", "path must not be empty"],
      [".", "path must not resolve to the home directory"],
      ["./", "path must not resolve to the home directory"],
      [".//", "path must not resolve to the home directory"],
      ["~", "tilde is not expanded for rwPaths"],
      ["~/.ssh", "tilde is not expanded for rwPaths"],
      // Rejected on the raw path: normalize() would collapse this to a plain
      // "foo" and silently accept a value the user wrote as traversal.
      ["~/../foo", "tilde is not expanded for rwPaths"],
      ["a/../..", "path must be relative without traversal"],
    ] as const;

    for (const [path, message] of invalidPaths) {
      const escapedPath = JSON.stringify(path);
      const result = parseConfig(`${base}
[tools.t]
name = "test"
cliCmd = "test"
rwDirs = [${escapedPath}]
`);
      Result.assertError(result);
      expect(result.error.message).toContain(message);
      expect(result.error.message).toContain(`got "${path}"`);
    }
  });

  test("accepts ordinary paths and stores normalized paths", () => {
    const result = parseConfig(`${base}
[tools.t]
name = "test"
cliCmd = "test"
rwDirs = [".claude", ".config/opencode", "./.claude", ".claude/"]
rwFiles = [".claude.json"]
`);
    Result.assertOk(result);
    expect(result.value.tools[0]!.rwPaths.map((rp) => rp.path)).toEqual([
      ".claude",
      ".config/opencode",
      ".claude",
      ".claude",
      ".claude.json",
    ]);
  });

  test("fails on non-string yoloArg", () => {
    const result = parseConfig(`${base}
[tools.t]
name = "test"
cliCmd = "test"
yoloArg = 123
`);
    Result.assertError(result);
    expect(result.error.message).toContain("yoloArg");
  });

  test("accepts valid string yoloArg", () => {
    const result = parseConfig(`${base}
[tools.t]
name = "test"
cliCmd = "test"
yoloArg = "--yolo"
`);
    Result.assertOk(result);
    expect(result.value.tools[0]!.yoloArg).toBe("--yolo");
  });

  test("parses per-tool sandbox settings without inventing defaults", () => {
    const result = parseConfig(`${base}
[tools.t]
name = "test"
cliCmd = "test"
hide = ["~/.kube"]
extraWritable = ["~/.cache/test"]
hideHomeAlways = true
`);
    Result.assertOk(result);
    expect(result.value.tools[0]).toMatchObject({
      hide: ["~/.kube"],
      extraWritable: ["~/.cache/test"],
      hideHomeAlways: true,
    });

    const omitted = parseConfig(`${base}
[tools.plain]
name = "plain"
cliCmd = "plain"
`);
    Result.assertOk(omitted);
    expect(omitted.value.tools[0]).not.toHaveProperty("hide");
    expect(omitted.value.tools[0]).not.toHaveProperty("extraWritable");
    expect(omitted.value.tools[0]).not.toHaveProperty("hideHomeAlways");
  });

  test("rejects invalid per-tool sandbox setting types", () => {
    for (const assignment of [
      'hide = "~/.ssh"',
      'extraWritable = [42]',
      'hideHomeAlways = "yes"',
    ]) {
      const result = parseConfig(`${base}
[tools.t]
name = "test"
cliCmd = "test"
${assignment}
`);
      Result.assertError(result);
    }
  });

  test("rejects home/root shorthand in per-tool extraWritable", () => {
    const result = parseConfig(
      `${base}
[tools.t]
name = "test"
cliCmd = "test"
extraWritable = ["~"]
`,
      "/tmp/tool-extra-writable.toml"
    );
    Result.assertError(result);
    expect(result.error.message).toContain("/tmp/tool-extra-writable.toml");
    expect(result.error.message).toContain("tools.t.extraWritable");
    expect(result.error.message).toContain('"~"');
  });

  test("rejects reserved, leading-dash, empty, and quoted exotic keys", () => {
    const invalidHeaders = [
      "[tools.tools]",
      "[tools.init]",
      "[tools.help]",
      '[tools."--version"]',
      '[tools."a b"]',
      '[tools."a/b"]',
      '[tools."a\\nb"]',
      '[tools.""]',
    ];
    for (const header of invalidHeaders) {
      const result = parseConfig(`${base}
${header}
name = "test"
cliCmd = "test"
`, "/tmp/keys.toml");
      Result.assertError(result);
      expect(result.error.message).toContain("/tmp/keys.toml");
      expect(result.error.message).toContain("tool key");
    }
  });

  test("rejects tools scalar and tools array-of-tables containers", () => {
    const scalar = parseConfig(`${base}tools = 5`);
    Result.assertError(scalar);
    expect(scalar.error.message).toContain("tools must be a table");

    const array = parseConfig(`${base}
[[tools]]
name = "old"
cliCmd = "old"
`);
    Result.assertError(array);
    expect(array.error.message).toContain(
      "use `[tools.<name>]` tables, not `[[tools]]`"
    );
  });

  test("rejects a nested non-tool value with the cliCmd shape message", () => {
    const result = parseConfig(`${base}
[tools.my.tool]
name = "nested"
cliCmd = "nested"
`);
    Result.assertError(result);
    expect(result.error.message).toContain("value must be a table with cliCmd");
  });

  test("rejects an unknown key inside a tool and names key and file", () => {
    const result = parseConfig(`${base}
[tools.t]
name = "test"
cliCmd = "test"
hide = []
extraWritable = []
hideHomeAlways = false
extra_writable = []
`, "/tmp/tool.toml");
    Result.assertError(result);
    expect(result.error.message).toContain("extra_writable");
    expect(result.error.message).toContain("/tmp/tool.toml");
  });

  test("rejects repeated tool tables that Bun would partially merge", () => {
    const result = parseConfig(`${base}
[tools.x]
name = "test"
[tools.x]
cliCmd = "test"
`);
    Result.assertError(result);
    expect(result.error.message).toContain('Duplicate tool table "x"');
  });

  test("rejects a duplicate after a comment containing a triple-quote fence", () => {
    const result = parseConfig(`${base}
# see """ this
[tools.cc]
name = "Claude Code"
[tools.cc]
cliCmd = "claude"
`);
    Result.assertError(result);
    expect(result.error.message).toContain('Duplicate tool table "cc"');
  });

  test("rejects a duplicate after a quoted display name containing a fence", () => {
    const result = parseConfig(`${base}
[tools.cc]
name = "a''' b"
[tools.cc]
cliCmd = "claude"
`);
    Result.assertError(result);
    expect(result.error.message).toContain('Duplicate tool table "cc"');
  });

  test("a duplicate after a multi-line string is still caught", () => {
    const result = parseConfig(`${base}
[tools.x]
name = """
note
"""
cliCmd = "test"
[tools.x]
rwDirs = [".x"]
`);
    Result.assertError(result);
    expect(result.error.message).toContain('Duplicate tool table "x"');
  });
});

describe("parseConfig - cwdOverrides", () => {
  test("defaults to empty array when cwdOverrides is absent", () => {
    const result = parseConfig("hideHomeAlways = false\nhide = []");
    Result.assertOk(result);
    expect(result.value.cwdOverrides).toEqual([]);
  });

  test("parses valid cwdOverrides", () => {
    const result = parseConfig(`
hideHomeAlways = false
hide = []
cwdOverrides = [
  { target = ".env" },
  { target = ".npmrc", override = "~/.config/aegis/sandbox-npmrc" },
]
`);
    Result.assertOk(result);
    expect(result.value.cwdOverrides.length).toBe(2);
    expect(result.value.cwdOverrides[0]).toEqual({ target: ".env" });
    expect(result.value.cwdOverrides[1]).toEqual({
      target: ".npmrc",
      override: "~/.config/aegis/sandbox-npmrc",
    });
  });

  test("accepts empty cwdOverrides array", () => {
    const result = parseConfig(
      "hideHomeAlways = false\nhide = []\ncwdOverrides = []"
    );
    Result.assertOk(result);
    expect(result.value.cwdOverrides).toEqual([]);
  });

  test("fails on non-array cwdOverrides", () => {
    const result = parseConfig(
      'hideHomeAlways = false\nhide = []\ncwdOverrides = "not an array"'
    );
    Result.assertError(result);
  });

  test("fails on cwdOverrides entry with empty target", () => {
    const result = parseConfig(
      'hideHomeAlways = false\nhide = []\ncwdOverrides = [{ target = "" }]'
    );
    Result.assertError(result);
  });

  test("fails on cwdOverrides entry with non-string override", () => {
    const result = parseConfig(
      'hideHomeAlways = false\nhide = []\ncwdOverrides = [{ target = ".env", override = 42 }]'
    );
    Result.assertError(result);
  });

  test("accepts string shorthand in cwdOverrides", () => {
    const result = parseConfig(
      'hideHomeAlways = false\nhide = []\ncwdOverrides = [".env", ".secrets"]'
    );
    Result.assertOk(result);
    expect(result.value.cwdOverrides).toEqual([
      { target: ".env" },
      { target: ".secrets" },
    ]);
  });

  test("accepts mixed strings and objects in cwdOverrides", () => {
    const result = parseConfig(`
hideHomeAlways = false
hide = []
cwdOverrides = [
  ".env",
  { target = ".npmrc", override = "~/.sandbox-npmrc" },
]
`);
    Result.assertOk(result);
    expect(result.value.cwdOverrides.length).toBe(2);
    expect(result.value.cwdOverrides[0]).toEqual({ target: ".env" });
    expect(result.value.cwdOverrides[1]).toEqual({
      target: ".npmrc",
      override: "~/.sandbox-npmrc",
    });
  });
});

describe("validateHidePaths", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "aegis-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("accepts empty array", () => {
    const result = validateHidePaths([]);
    Result.assertOk(result);
    expect(result.value).toEqual([]);
  });

  test("accepts existing directories", async () => {
    const dir1 = join(tempDir, "dir1");
    const dir2 = join(tempDir, "dir2");
    await mkdir(dir1);
    await mkdir(dir2);

    const result = validateHidePaths([dir1, dir2]);
    Result.assertOk(result);
    expect(result.value).toEqual([dir1, dir2]);
  });

  test("CLI --hide validation rejects controls but permits quotes", async () => {
    const controlPath = join(tempDir, "line\nbreak");
    const invalid = validateHidePaths([controlPath]);
    Result.assertError(invalid);
    expect(invalid.error.message).toContain("control characters");

    const quotedPath = join(tempDir, 'My "Stuff"');
    await mkdir(quotedPath);
    const valid = validateHidePaths([quotedPath]);
    Result.assertOk(valid);
    expect(valid.value).toEqual([quotedPath]);
  });

  test("CLI --hide rejects filesystem root", () => {
    const result = validateHidePaths(["/"]);
    Result.assertError(result);
    expect(result.error.message).toContain("home/root shorthand");
  });

  test("fails on non-existent path", () => {
    const nonExistent = join(tempDir, "does-not-exist");
    const result = validateHidePaths([nonExistent]);
    Result.assertError(result);
    expect(result.error.message).toContain(nonExistent);
  });

  test("fails on file (not directory)", async () => {
    const filePath = join(tempDir, "file.txt");
    await writeFile(filePath, "content");

    const result = validateHidePaths([filePath]);
    Result.assertError(result);
    expect(result.error.message).toContain(filePath);
    expect(result.error.message.toLowerCase()).toContain("directory");
  });

  test("fails on first invalid path (fail fast)", async () => {
    const validDir = join(tempDir, "valid");
    const invalidPath = join(tempDir, "invalid");
    const anotherValid = join(tempDir, "another");
    await mkdir(validDir);
    await mkdir(anotherValid);

    const result = validateHidePaths([validDir, invalidPath, anotherValid]);
    Result.assertError(result);
    expect(result.error.message).toContain(invalidPath);
  });

  test("error message clearly identifies the offending path", async () => {
    const badPath = "/definitely/does/not/exist/anywhere";
    const result = validateHidePaths([badPath]);
    Result.assertError(result);
    expect(result.error.message).toContain(badPath);
  });
});

describe("loadConfig", () => {
  let tempDir: string;
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "aegis-config-test-"));
    process.env.XDG_CONFIG_HOME = tempDir;
  });

  afterEach(async () => {
    if (originalXdgConfigHome !== undefined) {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    } else {
      delete process.env.XDG_CONFIG_HOME;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  test("creates default config if file does not exist", async () => {
    const result = await loadConfig();
    Result.assertOk(result);
    expect(result.value).toEqual(defaultConfig());
  });

  test("creates config directory if it does not exist", async () => {
    await loadConfig();
    const configPath = getConfigPath();
    const configContent = await readFile(configPath, "utf-8");
    expect(configContent).toBeTruthy();
  });

  test("loads existing valid config", async () => {
    const configDir = join(tempDir, "aegis");
    await mkdir(configDir, { recursive: true });
    const configPath = join(configDir, "config.toml");
    await writeFile(
      configPath,
      'hideHomeAlways = true\nhide = ["/some/path"]\n'
    );

    const result = await loadConfig();
    Result.assertOk(result);
    expect(result.value.hideHomeAlways).toBe(true);
    expect(result.value.hide).toEqual(["/some/path"]);
  });

  test("fails on invalid config file content", async () => {
    const configDir = join(tempDir, "aegis");
    await mkdir(configDir, { recursive: true });
    const configPath = join(configDir, "config.toml");
    await writeFile(configPath, "not valid toml");

    const result = await loadConfig();
    Result.assertError(result);
    expect(result.error.message).toContain(configPath);
  });

  test("fails on config with missing required fields", async () => {
    const configDir = join(tempDir, "aegis");
    await mkdir(configDir, { recursive: true });
    const configPath = join(configDir, "config.toml");
    await writeFile(configPath, "hideHomeAlways = true");

    const result = await loadConfig();
    Result.assertError(result);
  });

  test("fails loudly when only legacy config.json exists", async () => {
    const configDir = join(tempDir, "aegis");
    await mkdir(configDir, { recursive: true });
    const legacyPath = join(configDir, "config.json");
    await writeFile(legacyPath, '{ hideHomeAlways: false, hide: [] }');

    const result = await loadConfig();
    Result.assertError(result);
    expect(result.error.message).toContain(legacyPath);
    expect(result.error.message).toContain("scripts/config-to-toml.ts");
    // This error is the only instruction an existing install ever gets, and the
    // script takes both paths as arguments — naming it without them sends the
    // user to a usage error.
    expect(result.error.message).toContain(
      `bun run scripts/config-to-toml.ts "${legacyPath}" "${join(configDir, "config.toml")}"`
    );
    // The converter is not in the compiled binary (no scripts/ dir, and json5 is
    // a devDependency), so the message must say where the command can be run at
    // all — otherwise a binary-only install is handed an impossible instruction.
    expect(result.error.message).toContain("source checkout");
  });

  test("does not scaffold a config over a legacy config.json", async () => {
    // Writing the template here would silently discard the user's settings.
    const configDir = join(tempDir, "aegis");
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "config.json"), '{ hideHomeAlways: false, hide: [] }');

    Result.assertError(await loadConfig());
    expect(existsSync(join(configDir, "config.toml"))).toBe(false);
  });
});

describe("getConfigPath", () => {
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

  afterEach(() => {
    if (originalXdgConfigHome !== undefined) {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    } else {
      delete process.env.XDG_CONFIG_HOME;
    }
  });

  test("respects XDG_CONFIG_HOME", () => {
    process.env.XDG_CONFIG_HOME = "/custom/config";
    const configPath = getConfigPath();
    expect(configPath).toContain("/custom/config");
    expect(configPath).toContain("aegis");
    expect(configPath).toEndWith("aegis/config.toml");
  });

  test("uses default config location when XDG_CONFIG_HOME not set", () => {
    delete process.env.XDG_CONFIG_HOME;
    const configPath = getConfigPath();
    expect(configPath).toContain(".config");
    expect(configPath).toContain("aegis");
    expect(configPath).toEndWith("aegis/config.toml");
  });

  test("does not include -bun suffix", () => {
    const configPath = getConfigPath();
    expect(configPath).not.toContain("-bun");
  });
});

describe("config-to-toml migration script", () => {
  test("writes a loadable config with catalog tools and leaves its source unchanged", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aegis-migration-test-"));
    const sourcePath = join(tempDir, "config.json");
    const outputPath = join(tempDir, "config.toml");
    const source = `{
      // JSON5 comments are valid in the legacy config.
      hideHomeAlways: true,
      hide: ["~/.ssh"],
      extraWritable: ["~/.npm"],
    }`;
    await writeFile(sourcePath, source);

    try {
      const proc = spawn({
        cmd: [
          "bun",
          "run",
          join(import.meta.dir, "../../scripts/config-to-toml.ts"),
          sourcePath,
          outputPath,
        ],
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode, `${stdout}\n${stderr}`).toBe(0);

      const output = await readFile(outputPath, "utf-8");
      expect(output).toContain('homeAccess = "blocklist"');
      expect(output).toContain("allowRead = []");
      const result = parseConfig(output, outputPath);
      Result.assertOk(result);
      expect(result.value.hideHomeAlways).toBe(true);
      expect(result.value.homeAccess).toBe("blocklist");
      expect(result.value.allowRead).toEqual([]);
      expect(result.value.hide).toEqual(["~/.ssh"]);
      expect(result.value.extraWritable).toEqual(["~/.npm"]);
      expect(result.value.tools).toEqual(defaultCliDefs(process.platform));
      expect(await readFile(sourcePath, "utf-8")).toBe(source);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  /** Run the migration script on `source`, returning its exit code and output. */
  async function migrate(
    tempDir: string,
    source: string
  ): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    outputPath: string;
  }> {
    const sourcePath = join(tempDir, "config.json");
    const outputPath = join(tempDir, "config.toml");
    await writeFile(sourcePath, source);
    const proc = spawn({
      cmd: [
        "bun",
        "run",
        join(import.meta.dir, "../../scripts/config-to-toml.ts"),
        sourcePath,
        outputPath,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr, outputPath };
  }

  test("carries over customized clis instead of reverting to the catalog", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aegis-migration-clis-"));
    // Two tools only — the other four catalog entries were deliberately
    // removed — plus a custom rwPath and a custom yoloArg.
    const source = `{
      hideHomeAlways: false,
      hide: ["~/.ssh"],
      extraWritable: [],
      clis: [
        {
          name: "claude code",
          cliCmd: "claude",
          subCommand: "cc",
          yoloArg: "--my-own-flag",
          rwPaths: [
            { kind: "dir", path: ".claude" },
            { kind: "dir", path: ".cache/acme" },
            { kind: "file", path: ".claude.json" },
          ],
        },
        {
          name: "codex",
          cliCmd: "codex",
          subCommand: "codex",
          rwPaths: [{ kind: "dir", path: ".codex" }],
        },
      ],
    }`;

    try {
      const { exitCode, stdout, stderr, outputPath } = await migrate(
        tempDir,
        source
      );
      expect(exitCode, `${stdout}\n${stderr}`).toBe(0);

      const output = await readFile(outputPath, "utf-8");
      // The legacy spelling must never reach the TOML file.
      expect(output).not.toContain("rwPaths");
      expect(output).toContain('rwDirs = [".claude", ".cache/acme"]');

      const result = parseConfig(output, outputPath);
      Result.assertOk(result);
      expect(result.value.tools).toEqual([
        {
          name: "claude code",
          cliCmd: "claude",
          subCommand: "cc",
          yoloArg: "--my-own-flag",
          rwPaths: [
            { kind: "dir", path: ".claude" },
            { kind: "dir", path: ".cache/acme" },
            { kind: "file", path: ".claude.json" },
          ],
        },
        {
          name: "codex",
          cliCmd: "codex",
          subCommand: "codex",
          rwPaths: [{ kind: "dir", path: ".codex" }],
        },
      ]);
      // Removed tools stay removed.
      expect(result.value.tools.map((tool) => tool.subCommand)).not.toContain(
        "gemini"
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("migrates a config that omits extraWritable", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aegis-migration-extra-"));
    const source = `{
      hideHomeAlways: true,
      hide: ["~/.aws"],
    }`;

    try {
      const { exitCode, stdout, stderr, outputPath } = await migrate(
        tempDir,
        source
      );
      expect(exitCode, `${stdout}\n${stderr}`).toBe(0);

      const result = parseConfig(await readFile(outputPath, "utf-8"), outputPath);
      Result.assertOk(result);
      expect(result.value.extraWritable).toEqual([]);
      expect(result.value.hide).toEqual(["~/.aws"]);
      expect(result.value.tools).toEqual(defaultCliDefs(process.platform));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("carries over cwdOverrides rather than dropping them", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aegis-migration-overrides-"));
    const source = `{
      hideHomeAlways: false,
      hide: [],
      cwdOverrides: [
        ".env",
        { target: "secrets.txt", override: "fixtures/fake-secrets.txt" },
      ],
    }`;

    try {
      const { exitCode, stdout, stderr, outputPath } = await migrate(
        tempDir,
        source
      );
      expect(exitCode, `${stdout}\n${stderr}`).toBe(0);

      const result = parseConfig(await readFile(outputPath, "utf-8"), outputPath);
      Result.assertOk(result);
      expect(result.value.cwdOverrides).toEqual([
        { target: ".env" },
        { target: "secrets.txt", override: "fixtures/fake-secrets.txt" },
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("fails loudly on a cli entry aegis would reject", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "aegis-migration-bad-"));
    const source = `{
      hideHomeAlways: false,
      hide: [],
      clis: [
        {
          name: "bad",
          cliCmd: "bad",
          subCommand: "bad",
          rwPaths: [{ kind: "dir", path: "../escape" }],
        },
      ],
    }`;

    try {
      const { exitCode, stderr, outputPath } = await migrate(tempDir, source);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("rwPath");
      expect(existsSync(outputPath)).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
