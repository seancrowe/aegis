/**
 * Unit tests for configuration management.
 * Tests config parsing, validation, and persistence.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Result } from "typescript-result";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultConfig,
  defaultCliDefs,
  defaultHidePaths,
  expandHidePaths,
  serializeConfig,
  parseConfig,
  loadConfig,
  validateHidePaths,
  getConfigPath,
  type AegisConfig,
} from "../../src/config/config";

describe("defaultConfig", () => {
  test("returns expected default values", () => {
    const config = defaultConfig();
    expect(config.hideHomeAlways).toBe(false);
    expect(config.hide).toEqual(defaultHidePaths());
    expect(config.hide.length).toBeGreaterThan(0);
    expect(config.cwdOverrides).toEqual([]);
    expect(config.clis).toEqual(defaultCliDefs());
    expect(config.clis.length).toBe(6);
  });

  test("returns a new object each time", () => {
    const config1 = defaultConfig();
    const config2 = defaultConfig();
    expect(config1).not.toBe(config2);
    expect(config1).toEqual(config2);
  });
});

describe("defaultCliDefs", () => {
  test("returns 6 built-in CLIs", () => {
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

describe("serializeConfig", () => {
  test("serializes default config to valid JSON", () => {
    const config = defaultConfig();
    const json = serializeConfig(config);
    const parsed = JSON.parse(json);
    expect(parsed.hideHomeAlways).toBe(false);
    expect(parsed.hide).toEqual(defaultHidePaths());
  });

  test("serializes custom config correctly", () => {
    const config: AegisConfig = {
      hideHomeAlways: true,
      hide: ["/path/one", "/path/two"],
      cwdOverrides: [],
      clis: defaultCliDefs(),
    };
    const json = serializeConfig(config);
    const parsed = JSON.parse(json);
    expect(parsed.hideHomeAlways).toBe(true);
    expect(parsed.hide).toEqual(["/path/one", "/path/two"]);
  });

  test("produces formatted JSON (pretty-printed)", () => {
    const config = defaultConfig();
    const json = serializeConfig(config);
    expect(json).toContain("\n");
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

describe("parseConfig", () => {
  test("parses valid config JSON", () => {
    const json = JSON.stringify({
      hideHomeAlways: true,
      hide: ["/path/one"],
    });
    const result = parseConfig(json);
    Result.assertOk(result);
    expect(result.value.hideHomeAlways).toBe(true);
    expect(result.value.hide).toEqual(["/path/one"]);
  });

  test("parses empty hide array", () => {
    const json = JSON.stringify({
      hideHomeAlways: false,
      hide: [],
    });
    const result = parseConfig(json);
    Result.assertOk(result);
    expect(result.value.hide).toEqual([]);
  });

  test("fails on invalid JSON", () => {
    const result = parseConfig("not valid json");
    Result.assertError(result);
  });

  test("fails on missing hideHomeAlways", () => {
    const json = JSON.stringify({ hide: [] });
    const result = parseConfig(json);
    Result.assertError(result);
  });

  test("fails on missing hide", () => {
    const json = JSON.stringify({ hideHomeAlways: false });
    const result = parseConfig(json);
    Result.assertError(result);
  });

  test("fails on wrong type for hideHomeAlways", () => {
    const json = JSON.stringify({
      hideHomeAlways: "yes",
      hide: [],
    });
    const result = parseConfig(json);
    Result.assertError(result);
  });

  test("fails on wrong type for hide", () => {
    const json = JSON.stringify({
      hideHomeAlways: false,
      hide: "not an array",
    });
    const result = parseConfig(json);
    Result.assertError(result);
  });

  test("fails on hide array with non-string elements", () => {
    const json = JSON.stringify({
      hideHomeAlways: false,
      hide: ["/valid", 123, "/also-valid"],
    });
    const result = parseConfig(json);
    Result.assertError(result);
  });

  test("error message includes field name for missing field", () => {
    const json = JSON.stringify({ hideHomeAlways: false });
    const result = parseConfig(json);
    Result.assertError(result);
    expect(result.error.message.toLowerCase()).toContain("hide");
  });

  test("allows extra fields (forward compatibility)", () => {
    const json = JSON.stringify({
      hideHomeAlways: false,
      hide: [],
      futureField: "some value",
    });
    const result = parseConfig(json);
    Result.assertOk(result);
  });
});

describe("parseConfig - clis validation", () => {
  test("parses valid config with clis", () => {
    const json = JSON.stringify({
      hideHomeAlways: false, hide: [],
      clis: [{ name: "test", cliCmd: "test", subCommand: "t", rwPaths: [] }],
    });
    const result = parseConfig(json);
    Result.assertOk(result);
  });

  test("fills defaultCliDefs when clis is missing (backward compat)", () => {
    const json = JSON.stringify({ hideHomeAlways: false, hide: [] });
    const result = parseConfig(json);
    Result.assertOk(result);
    expect(result.value.clis).toEqual(defaultCliDefs());
  });

  test("fails on clis entry missing cliCmd", () => {
    const json = JSON.stringify({
      hideHomeAlways: false, hide: [],
      clis: [{ name: "test", subCommand: "t", rwPaths: [] }],
    });
    const result = parseConfig(json);
    Result.assertError(result);
  });

  test("fails on duplicate subCommand values", () => {
    const json = JSON.stringify({
      hideHomeAlways: false, hide: [],
      clis: [
        { name: "a", cliCmd: "a", subCommand: "dupe", rwPaths: [] },
        { name: "b", cliCmd: "b", subCommand: "dupe", rwPaths: [] },
      ],
    });
    const result = parseConfig(json);
    Result.assertError(result);
  });

  test("fails on rwPaths entry with invalid kind", () => {
    const json = JSON.stringify({
      hideHomeAlways: false, hide: [],
      clis: [{ name: "t", cliCmd: "t", subCommand: "t",
               rwPaths: [{ kind: "symlink", path: ".foo" }] }],
    });
    const result = parseConfig(json);
    Result.assertError(result);
  });

  test("fails on non-string yoloArg (number)", () => {
    const json = JSON.stringify({
      hideHomeAlways: false, hide: [],
      clis: [{ name: "t", cliCmd: "t", subCommand: "t", rwPaths: [], yoloArg: 123 }],
    });
    const result = parseConfig(json);
    Result.assertError(result);
    expect(result.error.message).toContain("yoloArg");
  });

  test("fails on non-string yoloArg (boolean)", () => {
    const json = JSON.stringify({
      hideHomeAlways: false, hide: [],
      clis: [{ name: "t", cliCmd: "t", subCommand: "t", rwPaths: [], yoloArg: true }],
    });
    const result = parseConfig(json);
    Result.assertError(result);
  });

  test("accepts valid string yoloArg", () => {
    const json = JSON.stringify({
      hideHomeAlways: false, hide: [],
      clis: [{ name: "t", cliCmd: "t", subCommand: "t", rwPaths: [], yoloArg: "--yolo" }],
    });
    const result = parseConfig(json);
    Result.assertOk(result);
    expect(result.value.clis[0]!.yoloArg).toBe("--yolo");
  });
});

describe("parseConfig - cwdOverrides", () => {
  test("defaults to empty array when cwdOverrides is absent", () => {
    const json = JSON.stringify({ hideHomeAlways: false, hide: [] });
    const result = parseConfig(json);
    Result.assertOk(result);
    expect(result.value.cwdOverrides).toEqual([]);
  });

  test("parses valid cwdOverrides", () => {
    const json = JSON.stringify({
      hideHomeAlways: false,
      hide: [],
      cwdOverrides: [
        { target: ".env" },
        { target: ".npmrc", override: "~/.config/aegis/sandbox-npmrc" },
      ],
    });
    const result = parseConfig(json);
    Result.assertOk(result);
    expect(result.value.cwdOverrides.length).toBe(2);
    expect(result.value.cwdOverrides[0]).toEqual({ target: ".env" });
    expect(result.value.cwdOverrides[1]).toEqual({
      target: ".npmrc",
      override: "~/.config/aegis/sandbox-npmrc",
    });
  });

  test("accepts empty cwdOverrides array", () => {
    const json = JSON.stringify({
      hideHomeAlways: false,
      hide: [],
      cwdOverrides: [],
    });
    const result = parseConfig(json);
    Result.assertOk(result);
    expect(result.value.cwdOverrides).toEqual([]);
  });

  test("fails on non-array cwdOverrides", () => {
    const json = JSON.stringify({
      hideHomeAlways: false,
      hide: [],
      cwdOverrides: "not an array",
    });
    const result = parseConfig(json);
    Result.assertError(result);
  });

  test("fails on cwdOverrides entry with empty target", () => {
    const json = JSON.stringify({
      hideHomeAlways: false,
      hide: [],
      cwdOverrides: [{ target: "" }],
    });
    const result = parseConfig(json);
    Result.assertError(result);
  });

  test("fails on cwdOverrides entry with non-string override", () => {
    const json = JSON.stringify({
      hideHomeAlways: false,
      hide: [],
      cwdOverrides: [{ target: ".env", override: 42 }],
    });
    const result = parseConfig(json);
    Result.assertError(result);
  });

  test("accepts string shorthand in cwdOverrides", () => {
    const json = JSON.stringify({
      hideHomeAlways: false,
      hide: [],
      cwdOverrides: [".env", ".secrets"],
    });
    const result = parseConfig(json);
    Result.assertOk(result);
    expect(result.value.cwdOverrides).toEqual([
      { target: ".env" },
      { target: ".secrets" },
    ]);
  });

  test("accepts mixed strings and objects in cwdOverrides", () => {
    const json = JSON.stringify({
      hideHomeAlways: false,
      hide: [],
      cwdOverrides: [
        ".env",
        { target: ".npmrc", override: "~/.sandbox-npmrc" },
      ],
    });
    const result = parseConfig(json);
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
    const configPath = join(configDir, "config.json");
    const customConfig: AegisConfig = {
      hideHomeAlways: true,
      hide: ["/some/path"],
      cwdOverrides: [],
      clis: defaultCliDefs(),
    };
    await writeFile(configPath, JSON.stringify(customConfig));

    const result = await loadConfig();
    Result.assertOk(result);
    expect(result.value.hideHomeAlways).toBe(true);
    expect(result.value.hide).toEqual(["/some/path"]);
  });

  test("fails on invalid config file content", async () => {
    const configDir = join(tempDir, "aegis");
    await mkdir(configDir, { recursive: true });
    const configPath = join(configDir, "config.json");
    await writeFile(configPath, "not valid json");

    const result = await loadConfig();
    Result.assertError(result);
  });

  test("fails on config with missing required fields", async () => {
    const configDir = join(tempDir, "aegis");
    await mkdir(configDir, { recursive: true });
    const configPath = join(configDir, "config.json");
    await writeFile(configPath, JSON.stringify({ hideHomeAlways: true }));

    const result = await loadConfig();
    Result.assertError(result);
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
    expect(configPath).toContain("config.json");
  });

  test("uses default config location when XDG_CONFIG_HOME not set", () => {
    delete process.env.XDG_CONFIG_HOME;
    const configPath = getConfigPath();
    expect(configPath).toContain(".config");
    expect(configPath).toContain("aegis");
    expect(configPath).toContain("config.json");
  });

  test("does not include -bun suffix", () => {
    const configPath = getConfigPath();
    expect(configPath).not.toContain("-bun");
  });
});
