/**
 * Unit tests for the macOS sandbox-exec (SBPL) profile builder.
 * Pure functions — these run on every platform.
 */
import { describe, test, expect } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSandboxProfile,
  buildSandboxExecCommand,
  sbplEscape,
} from "../../src/sandbox/sandboxExec";
import type { SandboxOptions } from "../../src/sandbox/types";
import { defaultCliDefs } from "../../src/tools/catalog";
import type { CliDef } from "../../src/types";

const defaults = defaultCliDefs();
const findCli = (sub: string): CliDef =>
  defaults.find((c) => c.subCommand === sub)!;

function makeOpts(overrides: Partial<SandboxOptions> = {}): SandboxOptions {
  return {
    cwd: "/Users/user/project",
    home: "/Users/user",
    cliDef: findCli("cc"),
    toolPath: "/usr/local/bin/claude",
    toolChain: [],
    toolArgs: ["--version"],
    hideHome: false,
    hidePaths: [],
    allowRead: [],
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
 * Find the line index containing a substring. Throws when absent, so that
 * ordering assertions can never pass vacuously against a -1 sentinel.
 */
function lineWith(profile: string, needle: string): number {
  const lines = profile.split("\n");
  const index = lines.findIndex((l) => l.includes(needle));
  if (index === -1) {
    throw new Error(
      `lineWith: no line contains ${JSON.stringify(needle)} ` +
        `(searched ${lines.length} lines)`
    );
  }
  return index;
}

function countLines(profile: string, line: string): number {
  return profile.split("\n").filter((candidate) => candidate === line).length;
}

describe("sbplEscape", () => {
  test("escapes double quotes", () => {
    expect(sbplEscape('a"b')).toBe('a\\"b');
  });

  test("escapes backslashes", () => {
    expect(sbplEscape("a\\b")).toBe("a\\\\b");
  });

  test("leaves spaces and normal chars untouched", () => {
    expect(sbplEscape("/Users/a b/c-d.json")).toBe("/Users/a b/c-d.json");
  });

  test("escapes backslash before quote correctly", () => {
    // \" -> \\\"  (backslash doubled, quote escaped)
    expect(sbplEscape('a\\"b')).toBe('a\\\\\\"b');
  });
});

describe("buildSandboxProfile — read-only root", () => {
  test("declares version, allow-default, then deny-write (read-only root)", () => {
    const p = buildSandboxProfile(makeOpts());
    expect(p.startsWith("(version 1)\n")).toBe(true);
    const denyWrite = lineWith(p, "(deny file-write*)");
    const allowDefault = lineWith(p, "(allow default)");
    expect(denyWrite).toBeGreaterThan(allowDefault);
  });

  test("blocks privilege-escalation binaries", () => {
    const p = buildSandboxProfile(makeOpts());
    expect(p).toContain("(deny process-exec");
    expect(p).toContain("sudo|su|login|doas|pkexec");
  });
});

describe("buildSandboxProfile — device nodes", () => {
  test("re-allows writes to the standard scratch device nodes", () => {
    const p = buildSandboxProfile(makeOpts());
    for (const dev of [
      "/dev/null",
      "/dev/zero",
      "/dev/random",
      "/dev/urandom",
      "/dev/tty",
      "/dev/dtracehelper",
      "/dev/ptmx",
    ]) {
      expect(p).toContain(`(allow file-write* (literal "${dev}"))`);
    }
  });

  test("allows writes to /dev/fd and dynamically-numbered pty slaves", () => {
    const p = buildSandboxProfile(makeOpts());
    expect(p).toContain('(allow file-write* (subpath "/dev/fd"))');
    expect(p).toContain('(allow file-write* (regex #"^/dev/ttys[0-9]+$"))');
  });

  test("device allows come after the global deny-write (last-match-wins)", () => {
    const p = buildSandboxProfile(makeOpts());
    const denyWrite = lineWith(p, "(deny file-write*)");
    const allowNull = lineWith(p, '(allow file-write* (literal "/dev/null"))');
    expect(allowNull).toBeGreaterThan(denyWrite);
  });

  test("does not allow writes to block devices like /dev/disk0", () => {
    const p = buildSandboxProfile(makeOpts());
    expect(p).not.toContain("/dev/disk0");
  });
});

describe("buildSandboxProfile — writable paths", () => {
  test("allows write to cwd", () => {
    const p = buildSandboxProfile(makeOpts({ cwd: "/Users/user/proj" }));
    expect(p).toContain(
      '(allow file-read* file-write* (subpath "/Users/user/proj"))'
    );
  });

  test("allows write to each rwPath under home", () => {
    const p = buildSandboxProfile(makeOpts());
    // claude rwPaths: .claude (dir), .claude.json (file)
    expect(p).toContain('(subpath "/Users/user/.claude")');
    expect(p).toContain('(subpath "/Users/user/.claude.json")');
  });

  test("writable allow rules come after the global deny-write", () => {
    const p = buildSandboxProfile(makeOpts());
    const denyWrite = lineWith(p, "(deny file-write*)");
    const allowCwd = lineWith(p, '(subpath "/Users/user/project")');
    expect(allowCwd).toBeGreaterThan(denyWrite);
  });
});

describe("buildSandboxProfile — extraWritable", () => {
  test("allows read+write for each extra path", () => {
    const p = buildSandboxProfile(
      makeOpts({ extraWritable: ["/Users/user/Library/Caches", "/Users/user/.cargo"] })
    );
    expect(p).toContain(
      '(allow file-read* file-write* (subpath "/Users/user/Library/Caches"))'
    );
    expect(p).toContain(
      '(allow file-read* file-write* (subpath "/Users/user/.cargo"))'
    );
  });

  test("emits nothing extra when empty", () => {
    const opts = makeOpts({ extraWritable: [] });
    const p = buildSandboxProfile(opts);
    // Only cwd + the claude rwPaths are writable subpaths. Derived rather than
    // hardcoded: the rwPath set is platform-dependent (macOS adds the keychain).
    const allows = p
      .split("\n")
      .filter((l) => l.startsWith("(allow file-read* file-write* (subpath"));
    expect(allows.length).toBe(1 + opts.cliDef.rwPaths.length);
    expect(p).not.toContain('(subpath "/")');
  });

  test("extra writable allows precede hide denies (hide wins last-match)", () => {
    const p = buildSandboxProfile(
      makeOpts({
        extraWritable: ["/Users/user/Library/Caches"],
        hidePaths: ["/Users/user/Library/Caches"],
      })
    );
    const allow = lineWith(p, '(allow file-read* file-write* (subpath "/Users/user/Library/Caches"))');
    const deny = lineWith(p, '(deny file-read* file-write* (subpath "/Users/user/Library/Caches"))');
    expect(deny).toBeGreaterThan(allow);
  });
});

describe("buildSandboxProfile — hidden paths", () => {
  test("denies read and write for each hide path", () => {
    const p = buildSandboxProfile(
      makeOpts({ hidePaths: ["/Users/user/.ssh", "/Users/user/.aws"] })
    );
    expect(p).toContain(
      '(deny file-read* file-write* (subpath "/Users/user/.ssh"))'
    );
    expect(p).toContain(
      '(deny file-read* file-write* (subpath "/Users/user/.aws"))'
    );
  });

  test("denies both a symlinked hide path and its resolved target", () => {
    const root = mkdtempSync(join(tmpdir(), "aegis-profile-hide-"));
    try {
      const target = join(root, "dotfiles", "aws");
      const link = join(root, ".aws");
      mkdirSync(target, { recursive: true });
      symlinkSync(target, link, "dir");

      const p = buildSandboxProfile(makeOpts({ hidePaths: [link] }));
      expect(p).toContain(
        `(deny file-read* file-write* (subpath "${link}"))`
      );
      expect(p).toContain(
        `(deny file-read* file-write* (subpath "${realpathSync(target)}"))`
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("emits one deny when a hide path is already canonical", () => {
    const root = mkdtempSync(join(tmpdir(), "aegis-profile-hide-"));
    try {
      const path = realpathSync(root);
      const deny = `(deny file-read* file-write* (subpath "${path}"))`;
      const p = buildSandboxProfile(makeOpts({ hidePaths: [path] }));

      expect(countLines(p, deny)).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps the literal deny when a hide path does not exist", () => {
    const root = mkdtempSync(join(tmpdir(), "aegis-profile-hide-"));
    try {
      const missing = join(root, "removed-credentials");
      expect(() =>
        buildSandboxProfile(makeOpts({ hidePaths: [missing] }))
      ).not.toThrow();
      expect(
        buildSandboxProfile(makeOpts({ hidePaths: [missing] }))
      ).toContain(
        `(deny file-read* file-write* (subpath "${missing}"))`
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("buildSandboxProfile — allowRead", () => {
  test("re-exposes reads without granting writes", () => {
    const readable = "/Users/user/.config/git";
    const p = buildSandboxProfile(
      makeOpts({ hideHome: true, allowRead: [readable] })
    );
    expect(p).toContain(`(allow file-read* (subpath "${readable}"))`);
    expect(p).not.toContain(
      `(allow file-read* file-write* (subpath "${readable}"))`
    );
    expect(p).not.toContain(`(allow file-write* (subpath "${readable}"))`);
  });

  test("explicit hide and override denies follow the read allow", () => {
    const readable = "/Users/user/.config/git";
    const p = buildSandboxProfile(
      makeOpts({
        hideHome: true,
        allowRead: [readable],
        hidePaths: [readable],
        projectOverrides: [
          { target: readable, source: "/dev/null", kind: "dir" },
        ],
      })
    );
    const allow = lineWith(p, `(allow file-read* (subpath "${readable}"))`);
    const denyLines = p
      .split("\n")
      .map((line, index) => ({ line, index }))
      .filter(({ line }) =>
        line.includes(`(deny file-read* file-write* (subpath "${readable}"))`)
      );
    expect(denyLines.length).toBe(2);
    expect(denyLines.every(({ index }) => index > allow)).toBe(true);
  });

  test("uses the same read-only rule path without home masking", () => {
    const readable = "/Users/user/Library/Fonts";
    const p = buildSandboxProfile(
      makeOpts({ hideHome: false, allowRead: [readable] })
    );
    expect(p).toContain(`(allow file-read* (subpath "${readable}"))`);
  });
});

describe("buildSandboxProfile — hide-home", () => {
  test("denies both reads and writes under $HOME", () => {
    const p = buildSandboxProfile(makeOpts({ hideHome: true }));
    expect(p).toContain(
      '(deny file-read* file-write* (subpath "/Users/user"))'
    );
  });

  test("denies both an un-realpathed home spelling and its canonical path", () => {
    const root = mkdtempSync(join(tmpdir(), "aegis-profile-home-"));
    try {
      const realHome = join(root, "real-home");
      const linkedHome = join(root, "linked-home");
      mkdirSync(realHome);
      symlinkSync(realHome, linkedHome, "dir");

      const p = buildSandboxProfile(
        makeOpts({ home: linkedHome, hideHome: true })
      );
      expect(p).toContain(
        `(deny file-read* file-write* (subpath "${linkedHome}"))`
      );
      expect(p).toContain(
        `(deny file-read* file-write* (subpath "${realpathSync(realHome)}"))`
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("re-allows rwPaths at every spelling the home deny uses", () => {
    // Seatbelt matches the kernel-resolved path. Denying a symlinked $HOME at
    // both spellings while re-allowing only the written one locks the tool out
    // of its own config directory: the deny matches, the allow does not.
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "aegis-profile-rw-"))
    );
    try {
      const realHome = join(root, "real-home");
      const linkedHome = join(root, "linked-home");
      mkdirSync(realHome);
      symlinkSync(realHome, linkedHome, "dir");

      const p = buildSandboxProfile(
        makeOpts({ home: linkedHome, hideHome: true })
      );

      for (const spelling of [linkedHome, realpathSync(realHome)]) {
        const deny = lineWith(
          p,
          `(deny file-read* file-write* (subpath "${spelling}"))`
        );
        const allow = lineWith(
          p,
          `(allow file-read* file-write* (subpath "${join(
            spelling,
            ".claude"
          )}"))`
        );
        expect(allow).toBeGreaterThan(deny);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Regression test for a failure the profile-shape assertions above CANNOT
  // catch, found only by running the Layer 3m kernel suite: denying a symlinked
  // $HOME covers the link node itself, so readlink() fails and every path
  // beneath resolves to ENOTDIR — the rwPath allows above are correct but are
  // never reached. Metadata on the link node restores traversal without
  // exposing the masked contents. If this carve-out is dropped, Layer 3m goes
  // red on macOS while every unit test here still passes, so pin it here too.
  test("allows metadata on a symlinked $HOME so its rwPaths stay reachable", () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "aegis-profile-link-"))
    );
    try {
      const realHome = join(root, "real-home");
      const linkedHome = join(root, "linked-home");
      mkdirSync(realHome);
      symlinkSync(realHome, linkedHome, "dir");

      const p = buildSandboxProfile(
        makeOpts({ home: linkedHome, hideHome: true })
      );

      const deny = lineWith(
        p,
        `(deny file-read* file-write* (subpath "${linkedHome}"))`
      );
      const traverse = lineWith(
        p,
        `(allow file-read-metadata (literal "${linkedHome}"))`
      );
      // Must follow the deny to survive last-match-wins, and must be metadata
      // only — a file-read* here would unmask the directory it guards.
      expect(traverse).toBeGreaterThan(deny);
      expect(p).not.toContain(`(allow file-read* (literal "${linkedHome}"))`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an un-symlinked $HOME needs no metadata carve-out", () => {
    const p = buildSandboxProfile(makeOpts({ hideHome: true }));
    expect(p).not.toContain("(allow file-read-metadata (literal");
  });

  test("re-allows rwPaths, cwd, extraWritable, and tmpPaths after the home deny", () => {
    const p = buildSandboxProfile(
      makeOpts({
        hideHome: true,
        extraWritable: ["/Users/user/Library/Caches"],
        tmpPaths: ["/private/tmp"],
      })
    );
    const denyHome = lineWith(
      p,
      '(deny file-read* file-write* (subpath "/Users/user"))'
    );
    const allowRwPath = lineWith(
      p,
      '(allow file-read* file-write* (subpath "/Users/user/.claude"))'
    );
    const allowCwd = lineWith(
      p,
      '(allow file-read* file-write* (subpath "/Users/user/project"))'
    );
    const allowExtraWritable = lineWith(
      p,
      '(allow file-read* file-write* (subpath "/Users/user/Library/Caches"))'
    );
    const allowTmpPath = lineWith(
      p,
      '(allow file-write* (subpath "/private/tmp"))'
    );

    for (const allow of [
      allowRwPath,
      allowCwd,
      allowExtraWritable,
      allowTmpPath,
    ]) {
      expect(allow).toBeGreaterThan(denyHome);
    }
  });

  // Pins the mode-dependent claim in the Library/Keychains comment in
  // src/tools/catalog.ts: under a masked home this rwPath is emitted AFTER the
  // home deny and carries file-read*, so it re-exposes the login keychain for
  // read, not just write. The point is not to prove today's behavior correct —
  // it is that if the rwPath emit ever moves above the deny, this goes red and
  // the comment (and the README threat-model line) become detectably stale
  // rather than silently wrong.
  test("re-exposes the cc Library/Keychains rwPath for read after the home deny", () => {
    // Pin the platform: the rwPath is darwin-gated in the catalog, and this
    // assertion is about the SBPL builder, which runs the same everywhere.
    const cliDef = defaultCliDefs("darwin").find((c) => c.subCommand === "cc")!;
    const p = buildSandboxProfile(makeOpts({ hideHome: true, cliDef }));
    const denyHome = lineWith(
      p,
      '(deny file-read* file-write* (subpath "/Users/user"))'
    );
    const allowKeychains = lineWith(
      p,
      '(allow file-read* file-write* (subpath "/Users/user/Library/Keychains"))'
    );

    expect(allowKeychains).toBeGreaterThan(denyHome);
  });

  test("does not re-allow $HOME itself for a registered tool", () => {
    const opts = makeOpts({ hideHome: true });
    const p = buildSandboxProfile(opts);
    expect(p).not.toContain(
      `(allow file-read* file-write* (subpath "${opts.home}"))`
    );
  });

  test("omits the home deny when hideHome is false", () => {
    const p = buildSandboxProfile(makeOpts({ hideHome: false }));
    expect(p).not.toContain(
      '(deny file-read* file-write* (subpath "/Users/user"))'
    );
  });
});

describe("buildSandboxProfile — overrides (masking)", () => {
  test("denies masked override targets", () => {
    const p = buildSandboxProfile(
      makeOpts({
        projectOverrides: [
          { target: "/Users/user/project/.env", source: "/dev/null", kind: "file" },
        ],
      })
    );
    expect(p).toContain(
      '(deny file-read* file-write* (subpath "/Users/user/project/.env"))'
    );
  });

  test("denies both a symlinked override target and its resolved target", () => {
    const root = mkdtempSync(join(tmpdir(), "aegis-profile-override-"));
    try {
      const target = join(root, "dotfiles", "env");
      const link = join(root, ".env");
      mkdirSync(target, { recursive: true });
      symlinkSync(target, link, "dir");

      const p = buildSandboxProfile(
        makeOpts({
          cwdOverrides: [{ target: link, source: "/dev/null", kind: "dir" }],
        })
      );
      expect(p).toContain(
        `(deny file-read* file-write* (subpath "${link}"))`
      );
      expect(p).toContain(
        `(deny file-read* file-write* (subpath "${realpathSync(target)}"))`
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resolved denies stay after allows and before the tool carve-out", () => {
    const root = mkdtempSync(join(tmpdir(), "aegis-profile-order-"));
    try {
      const target = join(root, "dotfiles", "aws");
      const link = join(root, ".aws");
      mkdirSync(target, { recursive: true });
      symlinkSync(target, link, "dir");

      const p = buildSandboxProfile(
        makeOpts({ hidePaths: [link], extraWritable: [target] })
      );
      const allow = lineWith(
        p,
        `(allow file-read* file-write* (subpath "${target}"))`
      );
      const deny = lineWith(
        p,
        `(deny file-read* file-write* (subpath "${realpathSync(target)}"))`
      );
      const carveOut = lineWith(
        p,
        `(allow file-read* process-exec (literal "/usr/local/bin/claude"))`
      );

      expect(deny).toBeGreaterThan(allow);
      expect(carveOut).toBeGreaterThan(deny);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("buildSandboxProfile — tool binary carve-out", () => {
  test("allows read+exec of the tool path as the last rule", () => {
    const p = buildSandboxProfile(
      makeOpts({ toolPath: "/opt/homebrew/bin/claude", hideHome: true })
    );
    const lines = p.trimEnd().split("\n");
    expect(lines[lines.length - 1]).toBe(
      '(allow file-read* process-exec (literal "/opt/homebrew/bin/claude"))'
    );
  });

  // A tool reached through symlinks needs every hop allowed: Seatbelt
  // resolves the whole path at exec time, so permitting only the launcher
  // leaves the file behind it denied under a masked $HOME.
  const chain = [
    {
      kind: "symlink" as const,
      path: "/Users/user/.local/bin/claude",
      target: "/Users/user/.local/share/claude/versions/1.0.0",
    },
    {
      kind: "file" as const,
      path: "/Users/user/.local/share/claude/versions/1.0.0",
    },
  ];

  test("allows every hop of the chain under a hidden home", () => {
    const p = buildSandboxProfile(
      makeOpts({
        toolPath: "/Users/user/.local/bin/claude",
        toolChain: chain,
        hideHome: true,
      })
    );
    expect(p).toContain(
      '(allow file-read* process-exec (literal "/Users/user/.local/share/claude/versions/1.0.0"))'
    );
  });

  test("emits no extra hops when nothing is masked", () => {
    const p = buildSandboxProfile(
      makeOpts({
        toolPath: "/Users/user/.local/bin/claude",
        toolChain: chain,
        hideHome: false,
      })
    );
    // Already readable under (allow default) — a redundant allow rule would
    // only widen the profile.
    expect(p).not.toContain("versions/1.0.0");
  });

  test("covers hops hidden by an explicit --hide rather than hide-home", () => {
    const p = buildSandboxProfile(
      makeOpts({
        toolPath: "/Users/user/.local/bin/claude",
        toolChain: chain,
        hideHome: false,
        hidePaths: ["/Users/user/.local/share"],
      })
    );
    expect(p).toContain(
      '(allow file-read* process-exec (literal "/Users/user/.local/share/claude/versions/1.0.0"))'
    );
  });

  test("recognizes a resolved chain hop behind a symlinked mask", () => {
    const root = mkdtempSync(join(tmpdir(), "aegis-profile-chain-"));
    try {
      const realMask = join(root, "real-mask");
      const linkedMask = join(root, "linked-mask");
      mkdirSync(join(realMask, "bin"), { recursive: true });
      const resolvedTool = join(realpathSync(realMask), "bin", "tool");
      symlinkSync(realMask, linkedMask, "dir");

      const p = buildSandboxProfile(
        makeOpts({
          toolPath: "/outside/launcher",
          toolChain: [{ kind: "file", path: resolvedTool }],
          hidePaths: [linkedMask],
        })
      );
      expect(p).toContain(
        `(allow file-read* process-exec (literal "${resolvedTool}"))`
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("buildSandboxExecCommand", () => {
  test("emits sandbox-exec -p <profile> -- tool args", () => {
    const result = buildSandboxExecCommand(
      makeOpts({ toolPath: "/usr/local/bin/claude", toolArgs: ["--help"] })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { cmd, args } = result.value;
    expect(cmd).toBe("sandbox-exec");
    expect(args[0]).toBe("-p");
    expect(args[1]).toContain("(version 1)"); // the profile
    expect(args[2]).toBe("--");
    expect(args[3]).toBe("/usr/local/bin/claude");
    expect(args[4]).toBe("--help");
  });
});
