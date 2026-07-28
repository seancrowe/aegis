/**
 * Layer 3m: native macOS Seatbelt semantic integration tests.
 *
 * Unlike profile-string tests, these execute sandbox-exec and ask the kernel
 * what is readable, writable, and executable.
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { spawn } from "bun";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseLsOutput } from "../utils/semanticOutput";
import { probeSeatbelt } from "../utils/seatbeltGuard";

const AEGIS_PATH = resolve(__dirname, "../../src/main.ts");
const CLAUDE_FIXTURE = resolve(__dirname, "../fixtures/bin-tools/claude");
const FIXTURES_BIN_TOOLS = dirname(CLAUDE_FIXTURE);
const seatbelt = await probeSeatbelt();

if (!seatbelt.available) {
  console.warn(seatbelt.message);
}

interface Fixture {
  root: string;
  home: string;
  unRealpathedHome: string;
  symlinkedCredentials: string;
  project: string;
  outside: string;
  configHome: string;
  homeBin: string;
  tmp: string;
}

let fixture: Fixture;

async function makeFixture(): Promise<Fixture> {
  const rawRoot = await mkdtemp(join(tmpdir(), "aegis-layer3m-"));
  const root = await realpath(rawRoot);
  const rawHome = join(root, "home");
  const project = join(root, "project");
  const outside = join(root, "outside");
  const configHome = join(root, "config");
  const homeBin = join(rawHome, ".local", "bin");
  // The child gets its own $TMPDIR inside the fixture. resolveTmpPaths()
  // (sandboxExec.ts:166) re-allows writes to the whole of $TMPDIR *after* the
  // hide-home deny, and last-match-wins means that allow would otherwise cover
  // this entire fixture — mkdtemp(tmpdir()) puts it under $TMPDIR. Every
  // "writes must fail" assertion here would pass vacuously. Narrowing the
  // child's $TMPDIR to one subdirectory keeps that re-allow real without
  // letting it swallow the paths under test.
  const tmp = join(root, "tmp");
  const credentialStore = join(root, "dotfiles", "credentials");

  // Parents before children: creating `home/.ssh` concurrently with `home`
  // itself races, and the child loses with ENOENT often enough to matter.
  await Promise.all([
    mkdir(rawHome, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(outside, { recursive: true }),
    mkdir(tmp, { recursive: true }),
    mkdir(credentialStore, { recursive: true }),
    mkdir(join(configHome, "aegis"), { recursive: true }),
  ]);

  await Promise.all([
    mkdir(join(rawHome, ".ssh"), { recursive: true }),
    mkdir(join(rawHome, ".aws"), { recursive: true }),
    mkdir(join(rawHome, ".gnupg"), { recursive: true }),
    mkdir(join(rawHome, ".claude"), { recursive: true }),
    mkdir(join(project, "secrets"), { recursive: true }),
  ]);

  await Promise.all([
    writeFile(join(rawHome, ".ssh", "id_test"), "ssh secret\n"),
    writeFile(join(rawHome, ".aws", "credentials"), "aws secret\n"),
    writeFile(join(rawHome, ".gnupg", "private.key"), "gpg secret\n"),
    writeFile(join(rawHome, ".claude", "settings.json"), "{}\n"),
    writeFile(join(rawHome, ".secret-credentials"), "secret\n"),
    writeFile(join(credentialStore, "credentials"), "linked secret\n"),
    writeFile(join(project, "secrets", "api-key.txt"), "project secret\n"),
    writeFile(
      join(configHome, "aegis", "config.toml"),
      `hideHomeAlways = false
hide = []

[tools.cc]
name = "Claude fixture"
cliCmd = "claude"
yoloArg = "--dangerously-skip-permissions"
rwDirs = [".claude"]
`
    ),
  ]);

  const finalTool = join(
    rawHome,
    ".local",
    "share",
    "claude",
    "versions",
    "1",
    "bin",
    "claude"
  );
  await mkdir(dirname(finalTool), { recursive: true });
  await mkdir(homeBin, { recursive: true });
  await copyFile(CLAUDE_FIXTURE, finalTool);
  await chmod(finalTool, 0o755);
  await symlink("versions/1", join(rawHome, ".local", "share", "claude", "current"));
  await symlink("../share/claude/current/bin/claude", join(homeBin, "claude"));
  const unRealpathedHome = join(root, "linked-home");
  await symlink(rawHome, unRealpathedHome, "dir");
  const symlinkedCredentials = join(rawHome, "secrets");
  await symlink(credentialStore, symlinkedCredentials, "dir");

  // mkdtemp(tmpdir()) is normally under /var/folders on macOS, whose kernel
  // path is /private/var/folders. This mirrors resolveTmpPaths(): policy paths
  // must use the canonical path Seatbelt sees after symlink resolution.
  const home = await realpath(rawHome);
  return {
    root,
    home,
    unRealpathedHome,
    symlinkedCredentials,
    project,
    outside,
    configHome,
    homeBin,
    tmp,
  };
}

async function runAegis(
  aegisArgs: string[],
  env: Record<string, string> = {},
  useHomeTool = false,
  home = fixture.home
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const path = useHomeTool
    ? `${fixture.homeBin}:${process.env.PATH}`
    : `${FIXTURES_BIN_TOOLS}:${process.env.PATH}`;
  const proc = spawn({
    cmd: ["bun", "run", AEGIS_PATH, "cc", ...aegisArgs],
    cwd: fixture.project,
    env: {
      ...process.env,
      ...env,
      HOME: home,
      XDG_CONFIG_HOME: fixture.configHome,
      PATH: path,
      // See makeFixture: os.tmpdir() honors TMPDIR, so this scopes aegis's
      // tmp re-allow to a fixture subdirectory instead of all of $TMPDIR.
      TMPDIR: fixture.tmp,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function expectSuccess(result: {
  stdout: string;
  stderr: string;
  exitCode: number;
}): void {
  expect(result, result.stderr).toMatchObject({ exitCode: 0 });
}

describe.skipIf(!seatbelt.available)("Layer 3m: sandbox-exec semantics", () => {
  beforeAll(async () => {
    fixture = await makeFixture();
  });

  afterAll(async () => {
    // beforeAll may have thrown before assigning; without this the real setup
    // failure is buried under a second, meaningless teardown error.
    if (fixture) await rm(fixture.root, { recursive: true, force: true });
  });

  test("--hide-home masks credential directories", async () => {
    const result = await runAegis(["--hide-home"]);
    expectSuccess(result);
    const sections = parseLsOutput(result.stdout);

    for (const label of ["HOME/.ssh", "HOME/.aws", "HOME/.gnupg"]) {
      const section = sections.get(label);
      expect(section).toBeDefined();
      expect(section?.error || section?.entries.length === 0).toBeTruthy();
    }
  });

  test("--hide-home masks credentials when HOME is not realpathed", async () => {
    const result = await runAegis(
      ["--hide-home"],
      {},
      false,
      fixture.unRealpathedHome
    );
    expectSuccess(result);
    const ssh = parseLsOutput(result.stdout).get("HOME/.ssh");

    expect(ssh).toBeDefined();
    expect(ssh?.error || ssh?.entries.length === 0).toBeTruthy();
  });

  test("--hide-home re-allows the tool's own config after the broad deny", async () => {
    const result = await runAegis(["--hide-home"]);
    expectSuccess(result);
    const claude = parseLsOutput(result.stdout).get("HOME/.claude");

    expect(claude?.error).toBeUndefined();
    expect(claude?.entries).toContain("settings.json");
  });

  test("masked home rejects writes while its rwPath accepts them", async () => {
    const result = await runAegis(["--hide-home"], {
      AEGIS_TEST_WRITE_HOME: join(fixture.home, "blocked-write"),
      AEGIS_TEST_WRITE_RW: join(fixture.home, ".claude", "allowed-write"),
    });
    expectSuccess(result);

    expect(result.stdout).toContain("WRITE:HOME=failure");
    expect(result.stdout).toContain("WRITE:RW_PATH=success");
  });

  // The two tests above run with the realpathed fixture home, so they cannot
  // see a written-vs-resolved spelling mismatch. These repeat them against
  // fixture.unRealpathedHome, the shape a real macOS $HOME under /var takes.
  // The hide-home deny is emitted at both spellings; if the rwPath re-allow is
  // emitted only at the written one, the deny wins at the kernel-resolved path
  // and the tool loses its own config directory.
  test("re-allows the tool's own config when HOME is not realpathed", async () => {
    const result = await runAegis(
      ["--hide-home"],
      {},
      false,
      fixture.unRealpathedHome
    );
    expectSuccess(result);
    const claude = parseLsOutput(result.stdout).get("HOME/.claude");

    expect(claude?.error).toBeUndefined();
    expect(claude?.entries).toContain("settings.json");
  });

  test("un-realpathed masked home rejects writes while its rwPath accepts them", async () => {
    const result = await runAegis(
      ["--hide-home"],
      {
        AEGIS_TEST_WRITE_HOME: join(
          fixture.unRealpathedHome,
          "blocked-write"
        ),
        AEGIS_TEST_WRITE_RW: join(
          fixture.unRealpathedHome,
          ".claude",
          "allowed-write"
        ),
      },
      false,
      fixture.unRealpathedHome
    );
    expectSuccess(result);

    expect(result.stdout).toContain("WRITE:HOME=failure");
    expect(result.stdout).toContain("WRITE:RW_PATH=success");
  });

  test("--hide masks a project directory", async () => {
    const result = await runAegis(
      ["--hide", join(fixture.project, "secrets")],
      { AEGIS_TEST_PROJECT_DIR: fixture.project }
    );
    expectSuccess(result);
    const secrets = parseLsOutput(result.stdout).get("PROJECT/secrets");

    expect(secrets).toBeDefined();
    expect(secrets?.error || secrets?.entries.length === 0).toBeTruthy();
  });

  test("--hide masks a symlinked credential directory in $HOME", async () => {
    const result = await runAegis(
      ["--hide", fixture.symlinkedCredentials],
      { AEGIS_TEST_PROJECT_DIR: fixture.home }
    );
    expectSuccess(result);
    const credentials = parseLsOutput(result.stdout).get("PROJECT/secrets");

    expect(credentials).toBeDefined();
    expect(
      credentials?.error || credentials?.entries.length === 0
    ).toBeTruthy();
  });

  test("writes fail outside cwd and succeed inside cwd", async () => {
    const result = await runAegis([], {
      AEGIS_TEST_WRITE_INSIDE: join(fixture.project, "allowed-write"),
      AEGIS_TEST_WRITE_OUTSIDE: join(fixture.outside, "blocked-write"),
    });
    expectSuccess(result);

    expect(result.stdout).toContain("WRITE:INSIDE_CWD=success");
    expect(result.stdout).toContain("WRITE:OUTSIDE_CWD=failure");
  });

  test("$TMPDIR stays writable even under --hide-home", async () => {
    // Not incidental: resolveTmpPaths() re-allows $TMPDIR after the hide-home
    // deny on purpose, so a tool keeps a working temp dir. Asserting it here
    // states the tradeoff plainly — a masked $HOME does NOT mean the tool can
    // persist nothing — and it is why every "writes must fail" test above
    // scopes the child's $TMPDIR away from the paths it checks. If that
    // scoping is ever dropped, those tests start passing vacuously and this
    // one explains why.
    const result = await runAegis(["--hide-home"], {
      AEGIS_TEST_WRITE_HOME: join(fixture.tmp, "tmp-write"),
    });
    expectSuccess(result);
    expect(result.stdout).toContain("WRITE:HOME=success");
  });

  test("a home-installed tool reached through a symlink chain still execs", async () => {
    const result = await runAegis(["--hide-home"], {}, true);
    expectSuccess(result);
    expect(result.stdout).toContain("=== DONE ===");
  });
});
