/**
 * Configuration management for aegis.
 */
import { Result } from "typescript-result";
import { existsSync } from "node:fs";
import { mkdir, writeFile, readFile, rename } from "node:fs/promises";
import { join, dirname, normalize } from "node:path";
import type { CliDef, RwPath } from "../types";
import { assertDirectory } from "../fs/paths";
import envPaths from "../util/envPaths";
import type { OverrideEntry } from "./overrides";
import { validateOverrideEntries } from "./overrides";

export interface AegisConfig {
  hideHomeAlways: boolean;
  /** Paths to hide in the sandbox. Supports ~ for home directory. */
  hide: string[];
  /** CWD-relative bind overrides applied globally to every project. */
  cwdOverrides: OverrideEntry[];
  clis: CliDef[];
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
 * Parse and validate config from JSON string.
 */
export function parseConfig(json: string): Result<AegisConfig, Error> {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return Result.error(new Error("Invalid JSON"));
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
    cwdOverrides,
    clis,
  });
}

/**
 * Get the config file path.
 */
export function getConfigPath(): string {
  const paths = envPaths("aegis", { suffix: false });
  return join(paths.config, "config.json");
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
    await writeFile(tmp, serializeConfig(defaultCfg), "utf-8");
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
