/**
 * Unit tests for path resolution and validation.
 * Tests absolute path resolution and directory validation.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Result } from "typescript-result";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { symlink } from "node:fs/promises";
import { realpathSync } from "node:fs";
import {
  resolveAbsolutePath,
  assertDirectory,
  assertExists,
  resolveAndValidateHidePath,
  resolveExecChain,
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
    const siblingDir = join(tempDir, "sibling");
    const nestedDir = join(tempDir, "nested");
    await mkdir(nestedDir);
    await mkdir(siblingDir);

    const result = resolveAndValidateHidePath("nested/../sibling", tempDir);
    Result.assertOk(result);
    expect(result.value).toBe(siblingDir);
  });

  test("rejects control characters before probing an existing directory", async () => {
    const dir = await mkdtemp(join(tempDir, "line\nbreak-"));
    expect(dir).toContain("\n");

    const result = resolveAndValidateHidePath(dir, tempDir);
    Result.assertError(result);
    expect(result.error.message).toContain("control characters");
    expect(result.error.message).not.toContain("Path does not exist");
  });

  test("rejects raw home traversal before resolving it", () => {
    const result = resolveAndValidateHidePath("~/../..", tempDir);
    Result.assertError(result);
    expect(result.error.message).toContain(
      "traversal outside $HOME is not allowed"
    );
    expect(result.error.message).not.toContain("Path does not exist");
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

describe("resolveExecChain", () => {
  let tempDir: string;

  beforeEach(async () => {
    // realpath the base: on macOS the temp dir sits under /var, itself a
    // symlink to /private/var, which the resolver would correctly report as
    // a hop and drown out the layout each test is actually asserting on.
    tempDir = realpathSync(await mkdtemp(join(tmpdir(), "aegis-chain-")));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("a plain file resolves to itself", async () => {
    const file = join(tempDir, "tool");
    await writeFile(file, "");

    expect(resolveExecChain(file)).toEqual([{ kind: "file", path: file }]);
  });

  test("one hop keeps the launcher and the file behind it", async () => {
    // Mirrors claude: ~/.local/bin/claude -> ~/.local/share/claude/versions/<v>
    const real = join(tempDir, "share/claude/versions/1.0.0/claude");
    const launcher = join(tempDir, "bin/claude");
    await mkdir(join(tempDir, "share/claude/versions/1.0.0"), { recursive: true });
    await mkdir(join(tempDir, "bin"), { recursive: true });
    await writeFile(real, "");
    await symlink(real, launcher);

    expect(resolveExecChain(launcher)).toEqual([
      { kind: "symlink", path: launcher, target: real },
      { kind: "file", path: real },
    ]);
  });

  test("captures a symlinked directory component mid-path", async () => {
    // Mirrors codex, whose chain runs through a "current" directory symlink.
    // realpath() collapses this hop away, but it still has to exist inside
    // the sandbox for the path to resolve.
    const release = join(tempDir, "releases/0.1.0");
    const current = join(tempDir, "current");
    const launcher = join(tempDir, "bin/codex");
    await mkdir(join(release, "bin"), { recursive: true });
    await mkdir(join(tempDir, "bin"), { recursive: true });
    await writeFile(join(release, "bin/codex"), "");
    await symlink(release, current);
    await symlink(join(current, "bin/codex"), launcher);

    expect(resolveExecChain(launcher)).toEqual([
      { kind: "symlink", path: launcher, target: join(current, "bin/codex") },
      { kind: "symlink", path: current, target: release },
      { kind: "file", path: join(release, "bin/codex") },
    ]);
  });

  test("preserves relative link targets verbatim", async () => {
    // The raw target is what gets recreated inside the sandbox, so a relative
    // link must stay relative — rewriting it to an absolute path would point
    // outside the layout the tool was installed with.
    const real = join(tempDir, "tool-1.0");
    const launcher = join(tempDir, "tool");
    await writeFile(real, "");
    await symlink("tool-1.0", launcher);

    expect(resolveExecChain(launcher)).toEqual([
      { kind: "symlink", path: launcher, target: "tool-1.0" },
      { kind: "file", path: real },
    ]);
  });

  test("returns what resolved so far when the target is missing", async () => {
    const launcher = join(tempDir, "dangling");
    await symlink(join(tempDir, "nope"), launcher);

    expect(resolveExecChain(launcher)).toEqual([
      { kind: "symlink", path: launcher, target: join(tempDir, "nope") },
    ]);
  });

  test("terminates on a symlink cycle", async () => {
    const a = join(tempDir, "a");
    const b = join(tempDir, "b");
    await symlink(b, a);
    await symlink(a, b);

    const chain = resolveExecChain(a);
    expect(chain.every((e) => e.kind === "symlink")).toBe(true);
    expect(chain.length).toBeLessThanOrEqual(2);
  });

  test("a nonexistent path yields no entries", () => {
    expect(resolveExecChain(join(tempDir, "absent"))).toEqual([]);
  });
});
