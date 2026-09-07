import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectBlock } from "../../src/config/config";
import {
  isWithinDir,
  matchProjectBlocks,
  normalizeProjectDir,
} from "../../src/config/projects";

function block(key: string, marker = key): ProjectBlock {
  return {
    key,
    hide: [marker],
    allowRead: [],
    extraWritable: [],
    hideHomeAlways: false,
  };
}

describe("normalizeProjectDir", () => {
  const home = "/Users/test";

  test("expands home paths and removes trailing slashes", () => {
    expect(normalizeProjectDir("~/Dev/app/", home)).toBe(
      "/Users/test/Dev/app"
    );
    expect(normalizeProjectDir("~/Dev/app//", home)).toBe(
      "/Users/test/Dev/app"
    );
  });

  test("preserves root", () => {
    expect(normalizeProjectDir("/", home)).toBe("/");
  });

  test("passes an absolute path through unchanged", () => {
    expect(normalizeProjectDir("/opt/projects/app", home)).toBe(
      "/opt/projects/app"
    );
  });
});

describe("isWithinDir", () => {
  test("matches the directory itself and descendants", () => {
    expect(isWithinDir("/Users/test/Dev/app", "/Users/test/Dev/app")).toBe(
      true
    );
    expect(
      isWithinDir("/Users/test/Dev/app", "/Users/test/Dev/app/src")
    ).toBe(true);
    expect(
      isWithinDir("/Users/test/Dev/app", "/Users/test/Dev/app/src/lib")
    ).toBe(true);
  });

  test("uses component boundaries", () => {
    expect(
      isWithinDir("/Users/test/Dev/app", "/Users/test/Dev/app-fork")
    ).toBe(false);
  });

  test("root contains every absolute path", () => {
    expect(isWithinDir("/", "/Users/test/Dev/app")).toBe(true);
  });
});

describe("matchProjectBlocks", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "aegis-projects-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("matches cwd exactly equal to the key", async () => {
    const app = join(tempDir, "app");
    await mkdir(app);
    const project = block(app);

    expect(matchProjectBlocks([project], app, tempDir).matched).toEqual([
      { block: project, dir: app },
    ]);
  });

  test("matches a sub-subfolder", async () => {
    const app = join(tempDir, "app");
    const cwd = join(app, "src", "lib");
    await mkdir(cwd, { recursive: true });

    expect(matchProjectBlocks([block(app)], cwd, tempDir).matched).toHaveLength(
      1
    );
  });

  test("does not match a sibling directory", async () => {
    const app = join(tempDir, "app");
    const sibling = join(tempDir, "app-fork");
    await mkdir(app);
    await mkdir(sibling);

    expect(matchProjectBlocks([block(app)], sibling, tempDir).matched).toEqual(
      []
    );
  });

  test("matches a key with a trailing slash", async () => {
    const app = join(tempDir, "app");
    await mkdir(app);

    expect(
      matchProjectBlocks([block(`${app}/`)], app, tempDir).matched
    ).toHaveLength(1);
  });

  test("matches a symlink key when cwd uses the real path", async () => {
    const real = join(tempDir, "real");
    const link = join(tempDir, "link");
    await mkdir(real);
    await symlink(real, link);
    const project = block(link);

    expect(
      matchProjectBlocks([project], realpathSync(real), tempDir).matched
    ).toEqual([{ block: project, dir: realpathSync(real) }]);
  });

  test("reports a nonexistent key as missing without matching", () => {
    const missing = block(join(tempDir, "missing"));
    const result = matchProjectBlocks([missing], tempDir, tempDir);

    expect(result.matched).toEqual([]);
    expect(result.missing).toEqual([missing]);
  });

  test("orders nested matches outermost first regardless of declaration order", async () => {
    const dev = join(tempDir, "Dev");
    const app = join(dev, "app");
    const cwd = join(app, "pkg");
    await mkdir(cwd, { recursive: true });
    const outer = block("~/Dev", "outer");
    const inner = block("~/Dev/app", "inner");

    for (const blocks of [
      [outer, inner],
      [inner, outer],
    ]) {
      expect(
        matchProjectBlocks(blocks, cwd, tempDir).matched.map(
          (match) => match.block
        )
      ).toEqual([outer, inner]);
    }
  });

  test("keeps declaration order for equal-length keys", async () => {
    const app = join(tempDir, "app");
    await mkdir(app);
    const first = block(app, "first");
    const second = block(app, "second");

    expect(
      matchProjectBlocks([second, first], app, tempDir).matched.map(
        (match) => match.block
      )
    ).toEqual([second, first]);
  });

  if (process.platform === "darwin") {
    test("matches a tmpdir key against its kernel-resolved cwd", async () => {
      const projectDir = join(tempDir, "project");
      const cwd = join(projectDir, "src");
      await mkdir(cwd, { recursive: true });

      expect(
        matchProjectBlocks(
          [block(projectDir)],
          join(realpathSync(tmpdir()), projectDir.slice(tmpdir().length + 1), "src"),
          tempDir
        ).matched
      ).toHaveLength(1);
    });
  }
});
