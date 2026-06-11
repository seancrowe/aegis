/**
 * Configuration management for aegis.
 */
import { Result } from "typescript-result";
import JSON5 from "json5";
import { existsSync } from "node:fs";
import { mkdir, writeFile, readFile, rename } from "node:fs/promises";
import { join, dirname, normalize } from "node:path";
import { homedir } from "node:os";
import type { CliDef, RwPath } from "../types";
import { assertDirectory } from "../fs/paths";
import type { OverrideEntry } from "./overrides";
import { validateOverrideEntries } from "./overrides";

export interface AegisConfig {
  hideHomeAlways: boolean;
  /** Paths to hide in the sandbox. Supports ~ for home directory. */
  hide: string[];
  /**
   * Extra directories to keep writable inside the sandbox, beyond cwd and tool
   * config. Opt-in escape hatch for tools that write outside the project —
   * build/compiler caches (~/Library/Caches, ~/Library/Developer, ~/.cargo,
   * ~/.npm, ~/go/pkg, …). Supports ~ for home directory. These often live under
   * $HOME and may hold credentials, so nothing is writable here unless you add
   * it. Empty by default.
   */
  extraWritable: string[];
  /** CWD-relative bind overrides applied globally to every project. */
  cwdOverrides: OverrideEntry[];
  clis: CliDef[];
}

/**
 * Expand ~ in a list of user-supplied paths and normalize them. Unlike
 * expandHidePaths this does NOT filter out non-existent paths: a writable
 * allow-rule is still meaningful for a cache dir the tool creates on first use
 * (the macOS Seatbelt backend matches by path prefix regardless of existence).
 */
export function expandUserPaths(paths: string[], home: string): string[] {
  return paths.map((p) => {
    if (p === "~") return home;
    if (p.startsWith("~/")) return normalize(join(home, p.slice(2)));
    return p;
  });
}

/**
 * Return the default hide paths for sensitive directories.
 * Paths starting with ~ are expanded at runtime via expandHidePaths().
 */
export function defaultHidePaths(): string[] {
  return [
    "~/.ssh",
    "~/.gnupg",
    "~/.aws",
    "~/.config/gcloud",
    "~/.azure",
    "~/.kube",
  ];
}

/**
 * Expand ~ in hide paths and filter out non-existent paths.
 * Config-sourced paths are lenient: missing paths are silently skipped.
 */
export function expandHidePaths(paths: string[], home: string): string[] {
  return paths
    .map((p) => {
      if (p === "~") return home;
      if (p.startsWith("~/")) return normalize(join(home, p.slice(2)));
      return p;
    })
    .filter((p) => existsSync(p));
}

/**
 * Return the 6 built-in CLI definitions.
 */
export function defaultCliDefs(): CliDef[] {
  return [
    {
      name: "claude code",
      cliCmd: "claude",
      subCommand: "cc",
      yoloArg: "--dangerously-skip-permissions",
      rwPaths: [
        { kind: "dir", path: ".claude" },
        { kind: "file", path: ".claude.json" },
      ],
    },
    {
      name: "codex",
      cliCmd: "codex",
      subCommand: "codex",
      yoloArg: "--dangerously-bypass-approvals-and-sandbox",
      rwPaths: [{ kind: "dir", path: ".codex" }],
    },
    {
      name: "gemini",
      cliCmd: "gemini",
      subCommand: "gemini",
      yoloArg: "--yolo",
      rwPaths: [{ kind: "dir", path: ".gemini" }],
    },
    {
      name: "augment",
      cliCmd: "augment",
      subCommand: "auggie",
      rwPaths: [
        { kind: "dir", path: ".augment" },
        { kind: "file", path: ".augment/settings.json" },
      ],
    },
    {
      name: "opencode",
      cliCmd: "opencode",
      subCommand: "opencode",
      rwPaths: [
        { kind: "dir", path: ".config/opencode" },
        { kind: "file", path: ".config/opencode/opencode.json" },
        { kind: "dir", path: ".local/share/opencode" },
        { kind: "file", path: ".local/share/opencode/auth.json" },
      ],
    },
    {
      name: "crush",
      cliCmd: "crush",
      subCommand: "crush",
      yoloArg: "--yolo",
      rwPaths: [
        { kind: "dir", path: ".config/crush" },
        { kind: "file", path: ".config/crush/crush.json" },
      ],
    },
  ];
}

/**
 * Get the default configuration.
 */
export function defaultConfig(): AegisConfig {
  return {
    hideHomeAlways: false,
    hide: defaultHidePaths(),
    extraWritable: [],
    cwdOverrides: [],
    clis: defaultCliDefs(),
  };
}

/**
 * Serialize config to JSON string.
 */
export function serializeConfig(config: AegisConfig): string {
  return JSON.stringify(config, null, 2);
}

/**
 * The commented JSON5 template written when no config exists yet. Omits the
 * `clis` and `cwdOverrides` fields — parseConfig backfills them — so the
 * generated file stays short and self-documenting. Parsing this template must
 * yield defaultConfig() exactly; the unit suite asserts that to prevent drift.
 */
export function defaultConfigContent(): string {
  return `{
  // aegis config — JSON5, so // comments and trailing commas are allowed.
  // CLI flags are merged at runtime but never written back here.

  // Replace $HOME with an empty view on every run (same as --hide-home).
  "hideHomeAlways": false,

  // Directories made invisible inside the sandbox. Supports ~.
  "hide": [
    "~/.ssh",
    "~/.gnupg",
    "~/.aws",
    "~/.config/gcloud",
    "~/.azure",
    "~/.kube",
  ],

  // Extra dirs to keep WRITABLE beyond your project + tool config — the
  // escape hatch for build/compiler caches a tool writes outside the project.
  // Uncomment what you use. WARNING: these live under $HOME and some also hold
  // credentials, so prefer the narrowest subpath that fixes your write error.
  "extraWritable": [
    // "~/Library/Developer/Xcode/DerivedData", // Xcode build products
    // "~/Library/Caches/org.swift.swiftpm",    // Swift Package Manager
    // "~/.npm",                                 // npm cache
    // "~/.cargo/registry",                      // Cargo (whole ~/.cargo also holds credentials.toml)
    // "~/.rustup",                              // Rust toolchains
    // "~/go/pkg/mod", "~/Library/Caches/go-build", // Go
    // "~/Library/Caches/pip",                   // pip
    // "~/.gradle/caches",                       // Gradle (gradle.properties holds signing keys)
    // "~/.m2/repository",                       // Maven (settings.xml holds repo passwords)
  ],
}
`;
}

/**
 * Parse and validate config from a JSON5 string. JSON5 is a superset of JSON,
 * so existing plain-JSON configs still parse — but users may now add comments
 * and trailing commas to config.json.
 */
export function parseConfig(json: string): Result<AegisConfig, Error> {
  let raw: unknown;
  try {
    raw = JSON5.parse(json);
  } catch {
    return Result.error(new Error("Invalid JSON5"));
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return Result.error(new Error("Config must be a JSON object"));
  }
  const obj = raw as Record<string, unknown>;

  // Validate hideHomeAlways
  if (typeof obj.hideHomeAlways !== "boolean") {
    return Result.error(new Error("Missing or invalid field: hideHomeAlways"));
  }

  // Validate hide
  if (!Array.isArray(obj.hide)) {
    return Result.error(new Error("Missing or invalid field: hide"));
  }
  for (const item of obj.hide) {
    if (typeof item !== "string") {
      return Result.error(new Error("Invalid entry in hide: expected string"));
    }
  }

  // Validate extraWritable (optional, default to [])
  let extraWritable: string[] = [];
  if (obj.extraWritable !== undefined) {
    if (!Array.isArray(obj.extraWritable)) {
      return Result.error(new Error("Invalid field: extraWritable"));
    }
    for (const item of obj.extraWritable) {
      if (typeof item !== "string") {
        return Result.error(
          new Error("Invalid entry in extraWritable: expected string")
        );
      }
    }
    extraWritable = obj.extraWritable as string[];
  }

  // Validate cwdOverrides (optional, default to [])
  let cwdOverrides: OverrideEntry[] = [];
  if (obj.cwdOverrides !== undefined) {
    const ovResult = validateOverrideEntries(obj.cwdOverrides);
    if (!ovResult.ok) return Result.error(ovResult.error);
    cwdOverrides = ovResult.value;
  }

  // Validate clis (optional, backfill with defaults)
  let clis: CliDef[];
  if (obj.clis === undefined) {
    clis = defaultCliDefs();
  } else {
    if (!Array.isArray(obj.clis)) {
      return Result.error(new Error("Invalid field: clis"));
    }
    const subCommands = new Set<string>();
    clis = [];
    for (const entry of obj.clis) {
      if (typeof entry.name !== "string") return Result.error(new Error("Invalid cli entry: missing name"));
      if (typeof entry.cliCmd !== "string") return Result.error(new Error("Invalid cli entry: missing cliCmd"));
      if (typeof entry.subCommand !== "string") return Result.error(new Error("Invalid cli entry: missing subCommand"));
      if (!Array.isArray(entry.rwPaths)) return Result.error(new Error("Invalid cli entry: missing rwPaths"));

      if (subCommands.has(entry.subCommand)) {
        return Result.error(new Error(`Duplicate subCommand: ${entry.subCommand}`));
      }
      subCommands.add(entry.subCommand);

      const rwPaths: RwPath[] = [];
      for (const rp of entry.rwPaths) {
        if (rp.kind !== "file" && rp.kind !== "dir") {
          return Result.error(new Error(`Invalid rwPath kind: ${rp.kind}`));
        }
        if (typeof rp.path !== "string") {
          return Result.error(new Error("Invalid rwPath: missing path"));
        }
        if (rp.path.startsWith("/") || rp.path.split("/").some((component: string) => component === "..")) {
          return Result.error(new Error(`Invalid rwPath: path must be relative without traversal, got "${rp.path}"`));
        }
        rwPaths.push({ kind: rp.kind, path: rp.path });
      }

      const def: CliDef = {
        name: entry.name,
        cliCmd: entry.cliCmd,
        subCommand: entry.subCommand,
        rwPaths,
      };
      if (entry.yoloArg !== undefined) {
        if (typeof entry.yoloArg !== "string") {
          return Result.error(new Error("Invalid cli entry: yoloArg must be a string"));
        }
        def.yoloArg = entry.yoloArg;
      }
      clis.push(def);
    }
  }

  return Result.ok({
    hideHomeAlways: obj.hideHomeAlways as boolean,
    hide: obj.hide as string[],
    extraWritable,
    cwdOverrides,
    clis,
  });
}

/**
 * Get the config file path.
 *
 * Uses XDG Base Directory semantics on all platforms (including macOS) so the
 * config lives at a single, predictable location: `$XDG_CONFIG_HOME/aegis` when
 * set, otherwise `~/.config/aegis`.
 */
export function getConfigPath(): string {
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(configHome, "aegis", "config.json");
}

/**
 * Load config from disk, creating default if missing.
 */
export async function loadConfig(): Promise<Result<AegisConfig, Error>> {
  const configPath = getConfigPath();

  if (!existsSync(configPath)) {
    const dir = dirname(configPath);
    await mkdir(dir, { recursive: true });
    const defaultCfg = defaultConfig();
    const tmp = join(dir, `.aegis-config-${process.pid}.tmp`);
    await writeFile(tmp, defaultConfigContent(), "utf-8");
    await rename(tmp, configPath);
    return Result.ok(defaultCfg);
  }

  const content = await readFile(configPath, "utf-8");
  return parseConfig(content);
}

/**
 * Validate that all hide paths in config exist and are directories.
 */
export function validateHidePaths(
  paths: string[]
): Result<string[], Error> {
  for (const p of paths) {
    const check = assertDirectory(p);
    if (!check.ok) return Result.error(check.error);
  }
  return Result.ok(paths);
}
