/**
 * Unit tests for path resolution and validation.
 * Tests absolute path resolution and directory validation.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Result } from "typescript-result";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveAbsolutePath,
  assertDirectory,
  assertExists,
  resolveAndValidateHidePath,
} from "../../src/fs/paths";

describe("resolveAbsolutePath", () => {
  test("returns absolute path unchanged", () => {
    const result = resolveAbsolutePath("/absolute/path", "/some/cwd");
    Result.assertOk(result);
    expect(result.value).toBe("/absolute/path");
  });

  test("resolves relative path against cwd", () => {
    const result = resolveAbsolutePath("relative/path", "/some/cwd");
    Result.assertOk(result);
    expect(result.value).toBe("/some/cwd/relative/path");
  });

  test("resolves . as cwd", () => {
    const result = resolveAbsolutePath(".", "/some/cwd");
    Result.assertOk(result);
    expect(result.value).toBe("/some/cwd");
  });

  test("resolves .. correctly", () => {
    const result = resolveAbsolutePath("../sibling", "/parent/child");
    Result.assertOk(result);
    expect(result.value).toBe("/parent/sibling");
  });

  test("normalizes path with multiple slashes", () => {
    const result = resolveAbsolutePath("/path//with///multiple////slashes", "/cwd");
    Result.assertOk(result);
    expect(result.value).not.toContain("//");
  });

  test("normalizes path with trailing slash", () => {
    const result = resolveAbsolutePath("/path/with/trailing/", "/cwd");
    Result.assertOk(result);
    expect(result.value).not.toMatch(/\/$/);
  });

  test("handles ~ expansion (tilde) - expands to HOME", () => {
    // Tilde MUST expand to $HOME because bwrap requires absolute paths
    const testHome = "/home/testuser";
    const result = resolveAbsolutePath("~/Documents", "/cwd", testHome);
    Result.assertOk(result);
    expect(result.value).toBe(`${testHome}/Documents`);
  });

  test("handles ~ alone - expands to HOME", () => {
    const testHome = "/home/testuser";
    const result = resolveAbsolutePath("~", "/cwd", testHome);
    Result.assertOk(result);
    expect(result.value).toBe(testHome);
  });

  test("handles ~/ with trailing slash - expands to HOME", () => {
    const testHome = "/home/testuser";
    const result = resolveAbsolutePath("~/", "/cwd", testHome);
    Result.assertOk(result);
    // Should normalize to just HOME without trailing slash
    expect(result.value).toBe(testHome);
  });

  test("handles ~/.config/app nested path", () => {
    const testHome = "/home/testuser";
    const result = resolveAbsolutePath("~/.config/app", "/cwd", testHome);
    Result.assertOk(result);
    expect(result.value).toBe(`${testHome}/.config/app`);
  });

  test("handles deeply nested ~/a/b/c path", () => {
    const testHome = "/home/testuser";
    const result = resolveAbsolutePath("~/a/b/c", "/cwd", testHome);
    Result.assertOk(result);
    expect(result.value).toBe(`${testHome}/a/b/c`);
  });

  test("handles empty relative path", () => {
    const result = resolveAbsolutePath("", "/some/cwd");
    Result.assertOk(result);
    expect(result.value).toBe("/some/cwd");
  });
});

describe("assertDirectory", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "aegis-paths-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("succeeds for existing directory", async () => {
    const dir = join(tempDir, "testdir");
    await mkdir(dir);

    const result = assertDirectory(dir);
    Result.assertOk(result);
  });

  test("fails for non-existent path", () => {
    const result = assertDirectory(join(tempDir, "nonexistent"));
    Result.assertError(result);
    expect(result.error.message).toContain("nonexistent");
  });

  test("fails for file (not directory)", async () => {
    const filePath = join(tempDir, "file.txt");
    await writeFile(filePath, "content");

    const result = assertDirectory(filePath);
    Result.assertError(result);
    expect(result.error.message.toLowerCase()).toContain("directory");
  });

  test("succeeds for nested directory", async () => {
    const nested = join(tempDir, "a", "b", "c");
    await mkdir(nested, { recursive: true });

    const result = assertDirectory(nested);
    Result.assertOk(result);
  });

  test("error message includes path", async () => {
    const badPath = join(tempDir, "does-not-exist");
    const result = assertDirectory(badPath);
    Result.assertError(result);
    expect(result.error.message).toContain(badPath);
  });
});

describe("assertExists", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "aegis-paths-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("succeeds for existing directory", async () => {
    const dir = join(tempDir, "testdir");
    await mkdir(dir);

    const result = assertExists(dir);
    Result.assertOk(result);
  });

  test("succeeds for existing file", async () => {
    const filePath = join(tempDir, "file.txt");
    await writeFile(filePath, "content");

    const result = assertExists(filePath);
    Result.assertOk(result);
  });

  test("fails for non-existent path", () => {
    const result = assertExists(join(tempDir, "nonexistent"));
    Result.assertError(result);
  });

  test("error message includes path", () => {
    const badPath = join(tempDir, "missing");
    const result = assertExists(badPath);
    Result.assertError(result);
    expect(result.error.message).toContain(badPath);
  });
});

describe("resolveAndValidateHidePath", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "aegis-paths-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("resolves and validates absolute path to existing directory", async () => {
    const dir = join(tempDir, "hideme");
    await mkdir(dir);

    const result = resolveAndValidateHidePath(dir, "/some/cwd");
    Result.assertOk(result);
    expect(result.value).toBe(dir);
  });

  test("resolves relative path and validates", async () => {
    const dir = join(tempDir, "relative-hide");
    await mkdir(dir);

    const result = resolveAndValidateHidePath("relative-hide", tempDir);
    Result.assertOk(result);
    expect(result.value).toBe(dir);
  });

  test("fails for non-existent path", () => {
    const result = resolveAndValidateHidePath("nonexistent", tempDir);
    Result.assertError(result);
  });

  test("fails for file (not directory)", async () => {
    const filePath = join(tempDir, "notadir.txt");
    await writeFile(filePath, "content");

    const result = resolveAndValidateHidePath(filePath, tempDir);
    Result.assertError(result);
  });

  test("resolves complex relative path", async () => {
    const parentDir = join(tempDir, "parent");
    const childDir = join(parentDir, "child");
    const siblingDir = join(tempDir, "sibling");
    await mkdir(childDir, { recursive: true });
    await mkdir(siblingDir);

    // From child, go up and into sibling
    const result = resolveAndValidateHidePath("../../sibling", childDir);
    Result.assertOk(result);
    expect(result.value).toBe(siblingDir);
  });

  test("error message is helpful for invalid path", async () => {
    const filePath = join(tempDir, "iamafile");
    await writeFile(filePath, "");

    const result = resolveAndValidateHidePath(filePath, tempDir);
    Result.assertError(result);
    // Should mention the path and that it's not a directory
    expect(result.error.message).toContain(filePath);
  });
});
