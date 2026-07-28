import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "bun";
import { loadConfig } from "../../src/config/config";
import { runInit } from "../../src/tools/metaCommands";

const AEGIS_PATH = resolve(import.meta.dir, "../../src/main.ts");

async function runAegis(
  args: string[],
  env: Record<string, string>,
  stdin: "ignore" | "pipe" = "ignore"
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn({
    cmd: [process.execPath, "run", AEGIS_PATH, ...args],
    env: { ...process.env, ...env },
    stdin,
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

function minimalConfig(extra = ""): string {
  return `# keep this comment
hideHomeAlways = false
hide = []

[tools]
${extra}`;
}

function configWithoutTools(): string {
  return "hideHomeAlways = false\nhide = []\n";
}

describe("meta commands", () => {
  let tempDir: string;
  let configHome: string;
  let configDir: string;
  let configPath: string;
  let home: string;
  let env: Record<string, string>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "aegis-meta-"));
    configHome = join(tempDir, "config");
    configDir = join(configHome, "aegis");
    configPath = join(configDir, "config.toml");
    home = join(tempDir, "home");
    await mkdir(home, { recursive: true });
    env = { HOME: home, XDG_CONFIG_HOME: configHome };
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("tools schema succeeds without a config and does not create one", async () => {
    const result = await runAegis(["tools", "schema"], env);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("Config schema (TOML)");
    expect(result.stdout).toContain("Worked example:");
    expect(result.stdout).toContain("ADD to their global lists");
    expect(result.stdout).toContain("including per-tool hide");
    expect(await Bun.file(configPath).exists()).toBe(false);
  });

  test("tools schema succeeds with a deliberately broken config", async () => {
    await mkdir(configDir, { recursive: true });
    await writeFile(configPath, "hideHomeAlways = [\n");

    const result = await runAegis(["tools", "schema"], env);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("[tools.<key>]");
    expect(result.stderr).toBe("");
  });

  test("a tool invocation with no configured tools prints setup guidance", async () => {
    await mkdir(configDir, { recursive: true });
    await writeFile(configPath, configWithoutTools());

    const result = await runAegis(["anything"], env);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(`No tools configured in ${configPath}.`);
    expect(result.stderr).toContain("aegis init");
    expect(result.stderr).toContain("aegis tools add claude");
  });

  test("a bare invocation with no configured tools prints guidance successfully", async () => {
    await mkdir(configDir, { recursive: true });
    await writeFile(configPath, configWithoutTools());

    const result = await runAegis([], env);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(`No tools configured in ${configPath}.`);
  });

  test("--help succeeds with no configured tools", async () => {
    await mkdir(configDir, { recursive: true });
    await writeFile(configPath, configWithoutTools());

    const result = await runAegis(["--help"], env);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("Usage: aegis");
    expect(result.stdout).toContain(`No tools configured in ${configPath}.`);
  });

  test("tools list succeeds with a zero-tool config", async () => {
    await mkdir(configDir, { recursive: true });
    await writeFile(configPath, configWithoutTools());

    const result = await runAegis(["tools", "list"], env);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("cc (claude) — claude code [not configured]");
    expect(result.stdout).toContain(`Config: ${configPath}`);
  });

  test("tools schema succeeds with a zero-tool config", async () => {
    await mkdir(configDir, { recursive: true });
    await writeFile(configPath, configWithoutTools());

    const result = await runAegis(["tools", "schema"], env);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("Config schema (TOML)");
  });

  test("tools list prints the catalog and parse error for broken config", async () => {
    await mkdir(configDir, { recursive: true });
    await writeFile(configPath, "hideHomeAlways = [\n");

    const result = await runAegis(["tools", "list"], env);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("Tool catalog:");
    expect(result.stdout).toContain("cc (claude)");
    expect(result.stderr).toContain(configPath);
    expect(result.stderr).toMatch(/:\d+:\d+:/);
  });

  test("tools add refuses an unparseable config without changing a byte", async () => {
    await mkdir(configDir, { recursive: true });
    const broken = "# byte exact\nhideHomeAlways = [\n";
    await writeFile(configPath, broken);

    const result = await runAegis(["tools", "add", "claude"], env);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/:\d+:\d+:/);
    expect(await readFile(configPath, "utf-8")).toBe(broken);
  });

  test("a second tools add refuses the duplicate and preserves the file", async () => {
    await mkdir(configDir, { recursive: true });
    await writeFile(configPath, minimalConfig());
    const first = await runAegis(["tools", "add", "claude"], env);
    expect(first.exitCode, first.stderr).toBe(0);
    const afterFirst = await readFile(configPath, "utf-8");

    const second = await runAegis(["tools", "add", "claude"], env);

    expect(second.exitCode).not.toBe(0);
    expect(second.stderr).toContain('Tool key "cc" is already configured');
    expect(await readFile(configPath, "utf-8")).toBe(afterFirst);
  });

  test("tools add preserves comments, prints the real key, and loads the tool", async () => {
    await mkdir(configDir, { recursive: true });
    const original = minimalConfig("# another comment\n");
    await writeFile(configPath, original);

    const result = await runAegis(["tools", "add", "claude"], env);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("Added [tools.cc]");
    const appended = await readFile(configPath, "utf-8");
    expect(appended.startsWith(original)).toBe(true);
    expect(appended).toContain("# keep this comment");
    expect(appended).toContain("# another comment");

    const oldXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = configHome;
    try {
      const loaded = await loadConfig();
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.value.tools.map((tool) => tool.subCommand)).toContain("cc");
      }
    } finally {
      if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = oldXdg;
    }
  });

  test("tools add pins a resolved executable path", async () => {
    await mkdir(configDir, { recursive: true });
    await writeFile(configPath, minimalConfig());
    const binDir = join(tempDir, "bin");
    const claudePath = join(binDir, "claude");
    await mkdir(binDir, { recursive: true });
    await writeFile(claudePath, "#!/bin/sh\nexit 0\n");
    await chmod(claudePath, 0o755);

    const result = await runAegis(
      ["tools", "add", "claude"],
      { ...env, PATH: binDir }
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const parsed = Bun.TOML.parse(await readFile(configPath, "utf-8")) as {
      tools: { cc: { cliCmd: string } };
    };
    expect(parsed.tools.cc.cliCmd).toBe(claudePath);
  });

  test("tools add preserves a symlinked config and updates its target", async () => {
    const dotfilesDir = join(tempDir, "dotfiles");
    const targetPath = join(dotfilesDir, "aegis.toml");
    await mkdir(configDir, { recursive: true });
    await mkdir(dotfilesDir, { recursive: true });
    await writeFile(targetPath, minimalConfig());
    await symlink(targetPath, configPath);

    const result = await runAegis(["tools", "add", "claude"], env);

    expect(result.exitCode, result.stderr).toBe(0);
    expect((await lstat(configPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(targetPath, "utf-8")).toContain("[tools.cc]");
  });

  test("tools add supports aliases and validates extra writable paths", async () => {
    await mkdir(configDir, { recursive: true });
    await writeFile(configPath, minimalConfig());

    const result = await runAegis(
      [
        "tools",
        "add",
        "claude",
        "--as",
        "turtle",
        "--rw-path",
        ".claude-work",
      ],
      env
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("Added [tools.turtle]");
    const content = await readFile(configPath, "utf-8");
    expect(content).toContain("[tools.turtle]");
    expect(content).toContain(".claude-work");
  });

  test("tools add rejects reserved and invalid aliases before writing", async () => {
    await mkdir(configDir, { recursive: true });
    const original = minimalConfig();
    await writeFile(configPath, original);

    for (const alias of ["init", "bad key"]) {
      const result = await runAegis(
        ["tools", "add", "claude", "--as", alias],
        env
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Invalid tool key");
      expect(await readFile(configPath, "utf-8")).toBe(original);
    }
  });

  test("tools add never writes an alias that parseConfig would reject", async () => {
    await mkdir(configDir, { recursive: true });
    const original = minimalConfig();
    await writeFile(configPath, original);

    const result = await runAegis(
      ["tools", "add", "claude", "--as", "../escape"],
      env
    );

    expect(result.exitCode).not.toBe(0);
    expect(await readFile(configPath, "utf-8")).toBe(original);
    const loaded = await runAegis(["tools", "list"], env);
    expect(loaded.exitCode, loaded.stderr).toBe(0);
  });

  test("init --yes is non-interactive and prints absolute matched paths", async () => {
    await mkdir(configDir, { recursive: true });
    await writeFile(configPath, minimalConfig());
    const binDir = join(tempDir, "bin");
    const claudePath = join(binDir, "claude");
    await mkdir(binDir, { recursive: true });
    await writeFile(claudePath, "#!/bin/sh\nexit 0\n");
    await chmod(claudePath, 0o755);

    const result = await runAegis(
      ["init", "--yes"],
      { ...env, PATH: binDir },
      "ignore"
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(claudePath);
    expect(result.stdout).toContain("Added [tools.cc]");
    const parsed = Bun.TOML.parse(await readFile(configPath, "utf-8")) as {
      tools: { cc: { cliCmd: string } };
    };
    expect(parsed.tools.cc.cliCmd).toBe(claudePath);
    expect(result.stdout).toContain(parsed.tools.cc.cliCmd);
  });

  test("init duplicate detection uses the config reread after confirmation", async () => {
    await mkdir(configDir, { recursive: true });
    await writeFile(configPath, minimalConfig());
    const previousConfigHome = process.env.XDG_CONFIG_HOME;
    const previousHome = process.env.HOME;
    process.env.XDG_CONFIG_HOME = configHome;
    process.env.HOME = home;
    const editedDuringPrompt =
      minimalConfig() +
      '\n[tools.cc]\nname = "edited externally"\ncliCmd = "claude"\n';

    try {
      const result = await runInit({ all: true }, async () => {
        await writeFile(configPath, editedDuringPrompt);
        return true;
      });

      expect(result).toBe(1);
      expect(await readFile(configPath, "utf-8")).toBe(editedDuringPrompt);
    } finally {
      if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousConfigHome;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  test("tools list flags a stale absolute cliCmd", async () => {
    const stale = join(tempDir, "removed", "claude");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      configPath,
      minimalConfig(
        `[tools.cc]\nname = "claude code"\ncliCmd = ${JSON.stringify(stale)}\n`
      )
    );

    const result = await runAegis(["tools", "list"], env);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(`cc: cliCmd not found: ${stale}`);
  });

  test("init without flags and without a TTY reports proposals instead of hanging", async () => {
    await mkdir(configDir, { recursive: true });
    await writeFile(configPath, minimalConfig());
    const binDir = join(tempDir, "bin");
    const claudePath = join(binDir, "claude");
    await mkdir(binDir, { recursive: true });
    await writeFile(claudePath, "#!/bin/sh\nexit 0\n");
    await chmod(claudePath, 0o755);

    const result = await runAegis(
      ["init"],
      { ...env, PATH: binDir },
      "ignore"
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("Would add tools:");
    expect(result.stdout).toContain(claudePath);
    expect(result.stderr).toContain("No interactive terminal detected");
    expect(await readFile(configPath, "utf-8")).toBe(minimalConfig());
  }, 5_000);

  test("a BOM'd config still reports its tools as configured", async () => {
    // parseConfig strips the BOM, so anything else that inspects the same file
    // must too. Reading the raw bytes makes Bun return {} and every configured
    // tool look absent — which would send `tools add` after a table that is
    // already there.
    await mkdir(configDir, { recursive: true });
    await writeFile(
      configPath,
      "﻿" +
        minimalConfig() +
        '\n[tools.cc]\nname = "claude code"\ncliCmd = "claude"\nrwDirs = [".claude"]\n'
    );

    const list = await runAegis(["tools", "list"], env);
    expect(list.exitCode, list.stderr).toBe(0);
    expect(list.stdout).toContain("cc (claude) — claude code [configured]");

    const before = await readFile(configPath, "utf-8");
    const add = await runAegis(["tools", "add", "claude"], env);
    expect(add.exitCode).not.toBe(0);
    expect(add.stderr).toContain('Tool key "cc" is already configured');
    expect(await readFile(configPath, "utf-8")).toBe(before);
  });

  test("--rw-path is refused when adding several tools", async () => {
    // One writable path silently applied to every named tool is a policy
    // change wearing a convenience's clothes.
    await mkdir(configDir, { recursive: true });
    await writeFile(configPath, minimalConfig());

    const result = await runAegis(
      ["tools", "add", "codex", "gemini", "--rw-path", ".shared"],
      env
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(
      "--rw-path may only be used when adding one tool"
    );
    expect(await readFile(configPath, "utf-8")).toBe(minimalConfig());
  });

  test("bare `aegis tools` prints usage rather than an unknown-command error", async () => {
    await mkdir(configDir, { recursive: true });
    await writeFile(configPath, minimalConfig());

    const result = await runAegis(["tools"], env);
    expect(`${result.stdout}${result.stderr}`).toContain("Usage: aegis tools");
  });
});
