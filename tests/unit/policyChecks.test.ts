import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkHideConflicts,
  findShadowedGrants,
} from "../../src/config/policyChecks";

describe("policy hide checks", () => {
  let tempDir: string;
  let cwd: string;
  let toolConfig: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "aegis-policy-checks-"));
    cwd = join(tempDir, "project", "src");
    toolConfig = join(tempDir, "home", ".claude");
    await mkdir(cwd, { recursive: true });
    await mkdir(toolConfig, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("rejects a hide exactly equal to cwd with the exact message", () => {
    const result = checkHideConflicts([cwd], cwd, [], "claude");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe(
        `aegis: hide path "${cwd}" covers the working directory "${cwd}"; ` +
          "the sandbox would start in an empty, unwritable directory. " +
          "Remove the hide or run from another directory."
      );
    }
  });

  test("rejects a cwd beneath a hide", () => {
    const result = checkHideConflicts(
      [join(tempDir, "project")],
      cwd,
      [],
      "claude"
    );
    expect(result.ok).toBe(false);
  });

  test("allows a hide beneath cwd", () => {
    const result = checkHideConflicts(
      [join(cwd, "secrets")],
      cwd,
      [],
      "claude"
    );
    expect(result.ok).toBe(true);
  });

  test("rejects a hide exactly equal to an rwPath with the exact message", () => {
    const result = checkHideConflicts(
      [toolConfig],
      cwd,
      [{ path: toolConfig, kind: "dir" }],
      "claude"
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe(
        `aegis: hide path "${toolConfig}" covers tool config path ` +
          `"${toolConfig}" for "claude"; the tool could not read its own ` +
          "config. Hide a subpath instead."
      );
    }
  });

  test("rejects a hide that is an ancestor of an rwPath", () => {
    const result = checkHideConflicts(
      [join(tempDir, "home")],
      cwd,
      [{ path: toolConfig, kind: "dir" }],
      "claude"
    );
    expect(result.ok).toBe(false);
  });

  test("allows a hide beneath an rwPath", () => {
    const result = checkHideConflicts(
      [join(toolConfig, "projects", "other-client")],
      cwd,
      [{ path: toolConfig, kind: "dir" }],
      "claude"
    );
    expect(result.ok).toBe(true);
  });

  test("rejects a symlinked hide covering the real cwd", async () => {
    const realProject = join(tempDir, "real-project");
    const linkedProject = join(tempDir, "linked-project");
    await mkdir(realProject);
    await symlink(realProject, linkedProject);

    const result = checkHideConflicts(
      [linkedProject],
      realProject,
      [],
      "claude"
    );
    expect(result.ok).toBe(false);
  });
});

describe("findShadowedGrants", () => {
  test("reports descendants while respecting component boundaries", () => {
    expect(
      findShadowedGrants(
        ["/home/test/.aws", "/home/test/.cargo-old"],
        [
          {
            label: "allowRead",
            path: "/home/test/.aws/cli/cache",
          },
          {
            label: "extraWritable",
            path: "/home/test/.cargo/registry",
          },
        ]
      )
    ).toEqual([
      {
        label: "allowRead",
        path: "/home/test/.aws/cli/cache",
        hide: "/home/test/.aws",
      },
    ]);
  });
});
