import { describe, expect, test } from "bun:test";
import { Result } from "typescript-result";
import { parseConfig } from "../../src/config/config";
import { parseOverrides } from "../../src/config/overrides";
import { buildBwrapArgs } from "../../src/sandbox/bwrap";
import { buildSandboxProfile } from "../../src/sandbox/sandboxExec";
import type { SandboxOptions } from "../../src/sandbox/types";

const base = "hideHomeAlways = false\nhide = []\n";


function hostileKeyConfig(): string {
  return `${base}
[tools."line\\n\\"rule"]
name = "hostile"
cliCmd = "hostile"
`;
}

describe("config injection boundaries", () => {
  test("rejects an override control character before profile construction", () => {
    const parsed = parseOverrides(
      'overrides = [{ target = "line\\u007frule" }]\n',
      "/tmp/project/.aegis.toml"
    );
    let profile = "";
    if (parsed.ok) {
      profile = buildSandboxProfile({
        cwd: "/tmp/project",
        home: "/tmp/home",
        cliDef: {
          name: "probe",
          cliCmd: "probe",
          subCommand: "probe",
          rwPaths: [],
        },
        toolPath: "/usr/bin/true",
        toolChain: [{ kind: "file", path: "/usr/bin/true" }],
        toolArgs: [],
        hideHome: false,
        hidePaths: [],
        allowRead: [],
        extraWritable: [],
        emptyDir: "/tmp/empty",
        homeEntries: [],
        cwdOverrides: [],
        projectOverrides: parsed.value.map((entry) => ({
          target: entry.target,
          source: "/dev/null",
          kind: "file" as const,
        })),
        tmpPaths: ["/tmp"],
      });
    }

    Result.assertError(parsed);
    expect(parsed.error.message).toContain("control characters");
    expect(profile).toBe("");
    for (const line of profile.split("\n")) {
      expect(line).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/);
    }
  });

  test("rejects newline and quote tool keys before any policy builder runs", () => {
    // Backend-agnostic: the key never survives parseConfig, so neither the
    // Seatbelt profile nor the bwrap argv is ever reached with it.
    const result = parseConfig(hostileKeyConfig(), "/tmp/hostile-tool-key.toml");
    Result.assertError(result);
    expect(result.error.message).toContain("Invalid tool key");
  });

  test("rejects a newline/quote rwPath before it can reach a policy builder", () => {
    // sbplEscape handles \\ and " but NOT control characters, so a newline here
    // would be interpolated raw into an SBPL string literal. The fix belongs at
    // the boundary, not the emitter: no tool config directory contains one.
    const result = parseConfig(
      `${base}
[tools.ok]
name = "hostile path probe"
cliCmd = "probe"
rwDirs = ["line\\n\\"rule"]
`,
      "/tmp/hostile-rwpath.toml"
    );
    Result.assertError(result);
    expect(result.error.message).toContain("Invalid rwPath");
    expect(result.error.message).toContain("control characters and quotes");
  });

  test("rejects a newline/quote cliCmd, which reaches the profile via toolPath", () => {
    // main.ts derives toolPath from cliCmd, and sandboxExec emits it as a
    // (literal "…"). Same boundary, different route in.
    const result = parseConfig(
      `${base}
[tools.ok]
name = "hostile cmd probe"
cliCmd = "pro\\nbe"
`,
      "/tmp/hostile-clicmd.toml"
    );
    Result.assertError(result);
    expect(result.error.message).toContain("control characters and quotes");
  });

  test("an ordinary rwPath still builds a profile containing no raw control characters", () => {
    const parsed = parseConfig(
      `${base}
[tools.ok]
name = "probe"
cliCmd = "probe"
rwDirs = [".probe"]
`,
      "/tmp/ok.toml"
    );
    Result.assertOk(parsed);

    const opts: SandboxOptions = {
      cwd: "/tmp/project",
      home: "/tmp/home",
      cliDef: parsed.value.tools[0]!,
      toolPath: "/usr/bin/true",
      toolChain: [{ kind: "file", path: "/usr/bin/true" }],
      toolArgs: [],
      hideHome: true,
      hidePaths: [],
      allowRead: [],
      extraWritable: [],
      emptyDir: "/tmp/empty",
      homeEntries: [],
      cwdOverrides: [],
      projectOverrides: [],
      tmpPaths: ["/tmp"],
    };

    const profile = buildSandboxProfile(opts);
    expect(profile).toContain('(subpath "/tmp/home/.probe")');
    // Every line of the profile is a complete s-expression; a raw control
    // character inside a literal would mean a value escaped its quoting.
    for (const line of profile.split("\n")) {
      expect(line).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/);
    }
    const bwrap = buildBwrapArgs(opts);
    Result.assertOk(bwrap);
    expect(bwrap.value).toContain("/tmp/home/.probe");
  });
});
