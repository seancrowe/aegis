/**
 * Unit tests for the macOS sandbox-exec (SBPL) profile builder.
 * Pure functions — these run on every platform.
 */
import { describe, test, expect } from "bun:test";
import {
  buildSandboxProfile,
  buildSandboxExecCommand,
  sbplEscape,
} from "../../src/sandbox/sandboxExec";
import type { SandboxOptions } from "../../src/sandbox/types";
import { defaultCliDefs } from "../../src/config/config";
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
    toolArgs: ["--version"],
    hideHome: false,
    hidePaths: [],
    extraWritable: [],
    emptyDir: "",
    homeEntries: [],
    cwdOverrides: [],
    projectOverrides: [],
    tmpPaths: [],
    ...overrides,
  };
}

/** Find the line index containing a substring, or -1. */
function lineWith(profile: string, needle: string): number {
  return profile.split("\n").findIndex((l) => l.includes(needle));
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
    expect(lineWith(p, "(allow default)")).toBeGreaterThanOrEqual(0);
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
    const p = buildSandboxProfile(makeOpts({ extraWritable: [] }));
    // Only cwd + the two claude rwPaths are writable subpaths.
    const allows = p
      .split("\n")
      .filter((l) => l.startsWith("(allow file-read* file-write* (subpath"));
    expect(allows.length).toBe(3);
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
    expect(allow).toBeGreaterThanOrEqual(0);
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
});

describe("buildSandboxProfile — hide-home", () => {
  test("denies read under $HOME and re-allows tool config after", () => {
    const p = buildSandboxProfile(makeOpts({ hideHome: true }));
    const denyHome = lineWith(p, '(deny file-read* (subpath "/Users/user"))');
    const allowClaude = lineWith(p, '(subpath "/Users/user/.claude")');
    expect(denyHome).toBeGreaterThanOrEqual(0);
    // re-allow must come AFTER the home deny (last-match-wins)
    expect(allowClaude).toBeGreaterThan(denyHome);
  });

  test("omits the home deny when hideHome is false", () => {
    const p = buildSandboxProfile(makeOpts({ hideHome: false }));
    expect(p).not.toContain('(deny file-read* (subpath "/Users/user"))');
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
