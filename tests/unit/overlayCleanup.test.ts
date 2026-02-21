/**
 * Unit tests for overlay directory cleanup functions.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, existsSync, readdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createEmptyOverlayDir,
  removeOverlayDir,
  cleanStaleOverlays,
  OVERLAY_PREFIX,
} from "../../src/sandbox/bwrap";

describe("removeOverlayDir", () => {
  test("removes an existing directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "aegis-test-remove-"));
    expect(existsSync(dir)).toBe(true);
    removeOverlayDir(dir);
    expect(existsSync(dir)).toBe(false);
  });

  test("does not throw for non-existent directory", () => {
    expect(() => removeOverlayDir("/tmp/aegis-nonexistent-dir-xyz")).not.toThrow();
  });
});

describe("cleanStaleOverlays", () => {
  const created: string[] = [];

  beforeEach(() => {
    // Create some fake stale overlay dirs
    for (let i = 0; i < 3; i++) {
      const dir = mkdtempSync(join(tmpdir(), OVERLAY_PREFIX));
      created.push(dir);
    }
  });

  afterEach(() => {
    // Safety cleanup in case test failed
    for (const dir of created) {
      try {
        removeOverlayDir(dir);
      } catch {}
    }
    created.length = 0;
  });

  test("removes all aegis-overlay-* directories from tmpdir", () => {
    // Verify they exist first
    for (const dir of created) {
      expect(existsSync(dir)).toBe(true);
    }

    cleanStaleOverlays();

    // All should be gone
    for (const dir of created) {
      expect(existsSync(dir)).toBe(false);
    }
  });

  test("does not remove non-overlay directories", () => {
    const unrelated = mkdtempSync(join(tmpdir(), "aegis-other-"));
    try {
      cleanStaleOverlays();
      expect(existsSync(unrelated)).toBe(true);
    } finally {
      removeOverlayDir(unrelated);
    }
  });

  test("does not throw when tmpdir has no overlay directories", () => {
    cleanStaleOverlays(); // clear any existing
    expect(() => cleanStaleOverlays()).not.toThrow(); // run again on empty
  });
});

describe("createEmptyOverlayDir", () => {
  test("creates a directory with the correct prefix", async () => {
    const dir = await createEmptyOverlayDir();
    try {
      expect(existsSync(dir)).toBe(true);
      expect(dir).toContain(OVERLAY_PREFIX);
    } finally {
      removeOverlayDir(dir);
    }
  });

  test("creates an empty directory", async () => {
    const dir = await createEmptyOverlayDir();
    try {
      const contents = readdirSync(dir);
      expect(contents).toHaveLength(0);
    } finally {
      removeOverlayDir(dir);
    }
  });
});
