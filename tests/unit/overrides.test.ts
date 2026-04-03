/**
 * Unit tests for CWD-relative bind overrides.
 * Tests validation, parsing, loading, path resolution, and override resolution.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Result } from "typescript-result";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateOverrideEntries,
  parseOverrides,
  loadProjectOverrides,
  resolvePath,
  resolveOverrides,
  type OverrideEntry,
} from "../../src/config/overrides";

// ── validateOverrideEntries ──

describe("validateOverrideEntries", () => {
  test("accepts empty array", () => {
    const result = validateOverrideEntries([]);
    Result.assertOk(result);
    expect(result.value).toEqual([]);
  });

  test("accepts valid entry with target only", () => {
    const result = validateOverrideEntries([{ target: ".env" }]);
    Result.assertOk(result);
    expect(result.value).toEqual([{ target: ".env" }]);
  });

  test("accepts valid entry with target and override", () => {
    const result = validateOverrideEntries([
      { target: ".env", override: ".env.sandbox" },
    ]);
    Result.assertOk(result);
    expect(result.value).toEqual([
      { target: ".env", override: ".env.sandbox" },
    ]);
  });

  test("accepts multiple entries", () => {
    const result = validateOverrideEntries([
      { target: ".env" },
      { target: "secrets/", override: "sandbox-secrets/" },
    ]);
    Result.assertOk(result);
    expect(result.value.length).toBe(2);
  });

  test("rejects non-array input", () => {
    Result.assertError(validateOverrideEntries("not an array"));
    Result.assertError(validateOverrideEntries({}));
    Result.assertError(validateOverrideEntries(null));
    Result.assertError(validateOverrideEntries(42));
  });

  test("rejects entry that is not an object", () => {
    Result.assertError(validateOverrideEntries(["string"]));
    Result.assertError(validateOverrideEntries([42]));
    Result.assertError(validateOverrideEntries([null]));
    Result.assertError(validateOverrideEntries([[]]));
  });

  test("rejects entry with missing target", () => {
    const result = validateOverrideEntries([{ override: "foo" }]);
    Result.assertError(result);
    expect(result.error.message).toContain("target");
  });

  test("rejects entry with empty target", () => {
    const result = validateOverrideEntries([{ target: "" }]);
    Result.assertError(result);
    expect(result.error.message).toContain("target");
  });

  test("rejects entry with non-string target", () => {
    const result = validateOverrideEntries([{ target: 123 }]);
    Result.assertError(result);
  });

  test("rejects entry with empty override", () => {
    const result = validateOverrideEntries([{ target: ".env", override: "" }]);
    Result.assertError(result);
    expect(result.error.message).toContain("override");
  });

  test("rejects entry with non-string override", () => {
    const result = validateOverrideEntries([{ target: ".env", override: 123 }]);
    Result.assertError(result);
  });

  test("does not include override key when absent", () => {
    const result = validateOverrideEntries([{ target: ".env" }]);
    Result.assertOk(result);
    expect("override" in result.value[0]!).toBe(false);
  });

  test("ignores extra fields on entries", () => {
    const result = validateOverrideEntries([
      { target: ".env", extra: "ignored" },
    ]);
    Result.assertOk(result);
    expect(result.value[0]!).toEqual({ target: ".env" });
  });
});

// ── parseOverrides ──

describe("parseOverrides", () => {
  test("parses valid JSON array", () => {
    const result = parseOverrides('[{"target": ".env"}]');
    Result.assertOk(result);
    expect(result.value).toEqual([{ target: ".env" }]);
  });

  test("parses empty array", () => {
    const result = parseOverrides("[]");
    Result.assertOk(result);
    expect(result.value).toEqual([]);
  });

  test("rejects invalid JSON", () => {
    const result = parseOverrides("not json");
    Result.assertError(result);
    expect(result.error.message).toContain("Invalid JSON");
  });

  test("rejects JSON object (not array)", () => {
    const result = parseOverrides('{"target": ".env"}');
    Result.assertError(result);
  });

  test("rejects JSON with invalid entry", () => {
    const result = parseOverrides('[{"target": ""}]');
    Result.assertError(result);
  });
});

// ── loadProjectOverrides ──

describe("loadProjectOverrides", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "aegis-override-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("returns null when .aegis.json does not exist", async () => {
    const result = await loadProjectOverrides(tempDir);
    Result.assertOk(result);
    expect(result.value).toBeNull();
  });

  test("loads valid .aegis.json", async () => {
    await writeFile(
      join(tempDir, ".aegis.json"),
      JSON.stringify([{ target: ".env" }])
    );
    const result = await loadProjectOverrides(tempDir);
    Result.assertOk(result);
    expect(result.value).toEqual([{ target: ".env" }]);
  });

  test("returns error on malformed .aegis.json", async () => {
    await writeFile(join(tempDir, ".aegis.json"), "bad json{{{");
    const result = await loadProjectOverrides(tempDir);
    Result.assertError(result);
  });

  test("returns error on invalid structure", async () => {
    await writeFile(
      join(tempDir, ".aegis.json"),
      JSON.stringify({ target: ".env" }) // object, not array
    );
    const result = await loadProjectOverrides(tempDir);
    Result.assertError(result);
  });
});

// ── resolvePath ──

describe("resolvePath", () => {
  const cwd = "/home/user/project";
  const home = "/home/user";

  test("expands bare ~ to home", () => {
    expect(resolvePath("~", cwd, home)).toBe("/home/user");
  });

  test("expands ~/... to home subpath", () => {
    expect(resolvePath("~/.config/aegis", cwd, home)).toBe(
      "/home/user/.config/aegis"
    );
  });

  test("resolves relative path against cwd", () => {
    expect(resolvePath(".env", cwd, home)).toBe("/home/user/project/.env");
  });

  test("resolves parent traversal against cwd", () => {
    expect(resolvePath("../sibling/.env", cwd, home)).toBe(
      "/home/user/sibling/.env"
    );
  });

  test("passes absolute path through unchanged", () => {
    expect(resolvePath("/etc/hosts", cwd, home)).toBe("/etc/hosts");
  });
});

// ── resolveOverrides ──

describe("resolveOverrides", () => {
  let tempDir: string;
  let emptyDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "aegis-resolve-test-"));
    emptyDir = join(tempDir, "empty");
    await mkdir(emptyDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("returns empty array for empty entries", () => {
    const result = resolveOverrides([], tempDir, "/home/user", emptyDir);
    expect(result).toEqual([]);
  });

  test("nullifies existing file with /dev/null", async () => {
    const envFile = join(tempDir, ".env");
    await writeFile(envFile, "SECRET=foo");

    const result = resolveOverrides(
      [{ target: ".env" }],
      tempDir,
      "/home/user",
      emptyDir
    );
    expect(result).toEqual([
      { target: envFile, source: "/dev/null", kind: "file" },
    ]);
  });

  test("nullifies existing directory with emptyDir", async () => {
    const secretsDir = join(tempDir, "secrets");
    await mkdir(secretsDir);

    const result = resolveOverrides(
      [{ target: "secrets" }],
      tempDir,
      "/home/user",
      emptyDir
    );
    expect(result).toEqual([
      { target: secretsDir, source: emptyDir, kind: "dir" },
    ]);
  });

  test("replaces file with override file", async () => {
    const envFile = join(tempDir, ".env");
    const sandboxFile = join(tempDir, ".env.sandbox");
    await writeFile(envFile, "SECRET=foo");
    await writeFile(sandboxFile, "SECRET=bar");

    const result = resolveOverrides(
      [{ target: ".env", override: ".env.sandbox" }],
      tempDir,
      "/home/user",
      emptyDir
    );
    expect(result).toEqual([
      { target: envFile, source: sandboxFile, kind: "file" },
    ]);
  });

  test("replaces directory with override directory", async () => {
    const targetDir = join(tempDir, "creds");
    const overrideDir = join(tempDir, "sandbox-creds");
    await mkdir(targetDir);
    await mkdir(overrideDir);

    const result = resolveOverrides(
      [{ target: "creds", override: "sandbox-creds" }],
      tempDir,
      "/home/user",
      emptyDir
    );
    expect(result).toEqual([
      { target: targetDir, source: overrideDir, kind: "dir" },
    ]);
  });

  test("skips entry when target does not exist", () => {
    const result = resolveOverrides(
      [{ target: "nonexistent" }],
      tempDir,
      "/home/user",
      emptyDir
    );
    expect(result).toEqual([]);
  });

  test("skips entry when override does not exist", async () => {
    const envFile = join(tempDir, ".env");
    await writeFile(envFile, "SECRET=foo");

    const result = resolveOverrides(
      [{ target: ".env", override: "missing-file" }],
      tempDir,
      "/home/user",
      emptyDir
    );
    expect(result).toEqual([]);
  });

  test("skips and warns on file/dir type mismatch", async () => {
    const envFile = join(tempDir, ".env");
    const overrideDir = join(tempDir, "override-dir");
    await writeFile(envFile, "SECRET=foo");
    await mkdir(overrideDir);

    // Capture stderr
    const origWrite = process.stderr.write;
    let stderrOutput = "";
    process.stderr.write = ((chunk: string) => {
      stderrOutput += chunk;
      return true;
    }) as typeof process.stderr.write;

    const result = resolveOverrides(
      [{ target: ".env", override: "override-dir" }],
      tempDir,
      "/home/user",
      emptyDir
    );

    process.stderr.write = origWrite;

    expect(result).toEqual([]);
    expect(stderrOutput).toContain("type mismatch");
    expect(stderrOutput).toContain(".env");
  });

  test("resolves ~ paths in target", async () => {
    const home = tempDir;
    const sshDir = join(home, ".ssh");
    await mkdir(sshDir);

    const result = resolveOverrides(
      [{ target: "~/.ssh" }],
      "/some/cwd",
      home,
      emptyDir
    );
    expect(result).toEqual([
      { target: sshDir, source: emptyDir, kind: "dir" },
    ]);
  });

  test("resolves ~ paths in override", async () => {
    const home = tempDir;
    const targetFile = join(tempDir, "project", ".npmrc");
    const overrideFile = join(home, ".sandbox-npmrc");
    await mkdir(join(tempDir, "project"));
    await writeFile(targetFile, "original");
    await writeFile(overrideFile, "sandbox");

    const result = resolveOverrides(
      [{ target: ".npmrc", override: "~/.sandbox-npmrc" }],
      join(tempDir, "project"),
      home,
      emptyDir
    );
    expect(result).toEqual([
      { target: targetFile, source: overrideFile, kind: "file" },
    ]);
  });

  test("handles multiple entries, skipping invalid ones", async () => {
    const envFile = join(tempDir, ".env");
    const secretsDir = join(tempDir, "secrets");
    await writeFile(envFile, "SECRET=foo");
    await mkdir(secretsDir);
    // "nonexistent" target will be skipped

    const result = resolveOverrides(
      [
        { target: ".env" },
        { target: "nonexistent" },
        { target: "secrets" },
      ],
      tempDir,
      "/home/user",
      emptyDir
    );
    expect(result.length).toBe(2);
    expect(result[0]!.target).toBe(envFile);
    expect(result[1]!.target).toBe(secretsDir);
  });
});
