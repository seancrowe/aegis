/**
 * Configuration management for aegis.
 */
import { Result } from "typescript-result";
import { existsSync } from "node:fs";
import { mkdir, writeFile, readFile, rename } from "node:fs/promises";
import { join, dirname, normalize } from "node:path";
import { homedir } from "node:os";
import type { CliDef, RwPath } from "../types";
import { assertDirectory } from "../fs/paths";
import type { OverrideEntry } from "./overrides";
import { validateOverrideEntries } from "./overrides";
import { isTable, parseToml, stripBom } from "./toml";
import {
  expandUserPath,
  rejectControlChars as rejectPolicyControlChars,
  validatePolicyPath as validateSharedPolicyPath,
} from "./policyPath";

export interface ToolSandboxSettings {
  hide?: string[];
  extraWritable?: string[];
  hideHomeAlways?: boolean;
}

export interface ProjectBlock {
  /**
   * Key exactly as written in the table header, e.g. "~/Dev/aegis". Expanded
   * at match time.
   */
  key: string;
  hide: string[];
  allowRead: string[];
  extraWritable: string[];
  hideHomeAlways: boolean;
}

export type ConfiguredCliDef = CliDef & ToolSandboxSettings;

export interface AegisConfig {
  hideHomeAlways: boolean;
  /** Home read policy; blocklist preserves the historical behavior. */
  homeAccess: "blocklist" | "allowlist";
  /** Paths to hide in the sandbox. Supports ~ for home directory. */
  hide: string[];
  /** Extra paths to keep readable when home masking is active. Supports ~. */
  allowRead: string[];
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
  tools: ConfiguredCliDef[];
  projects: ProjectBlock[];
}

/**
 * Expand ~ in a list of user-supplied paths and normalize them. Unlike
 * expandHidePaths this does NOT filter out non-existent paths: a writable
 * allow-rule is still meaningful for a cache dir the tool creates on first use
 * (the macOS Seatbelt backend matches by path prefix regardless of existence).
 */
export function expandUserPaths(paths: string[], home: string): string[] {
  return paths.map((path) => expandUserPath(path, home));
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
    .map((path) => expandUserPath(path, home))
    .filter((p) => existsSync(p));
}

/**
 * Get the default configuration.
 */
export function defaultConfig(): AegisConfig {
  return {
    hideHomeAlways: false,
    homeAccess: "blocklist",
    hide: defaultHidePaths(),
    allowRead: [],
    extraWritable: [],
    cwdOverrides: [],
    // A newly scaffolded file declares no [tools.*] tables, so this in-memory
    // return must describe those bytes exactly. Tools arrive only via
    // `aegis init` or `aegis tools add`; scaffolding them would make
    // `tools add <name>` fail as already-configured on a fresh install.
    tools: [],
    projects: [],
  };
}

/**
 * The commented TOML template written when no config exists yet. It carries
 * policy defaults only — no tool tables — so a fresh config is inert until the
 * user opts a tool in.
 */
export function defaultConfigContent(): string {
  return `# aegis config — TOML.
# CLI flags are merged at runtime but never written back here.

# Replace $HOME with an empty view on every run (same as --hide-home).
hideHomeAlways = false

# Keep today's readable-home-minus-hide model. Use "allowlist" to mask $HOME.
homeAccess = "blocklist"

# Directories made invisible inside the sandbox. Supports ~.
hide = [
  "~/.ssh",
  "~/.gnupg",
  "~/.aws",
  "~/.config/gcloud",
  "~/.azure",
  "~/.kube",
]

# Extra paths to keep READABLE when $HOME is masked. Supports ~. These never
# grant write access and explicit hide/--hide rules still win.
allowRead = []

# Extra dirs to keep WRITABLE beyond your project + tool config — the
# escape hatch for build/compiler caches a tool writes outside the project.
# Uncomment what you use. WARNING: these live under $HOME and some also hold
# credentials, so prefer the narrowest subpath that fixes your write error.
extraWritable = [
  # "~/Library/Developer/Xcode/DerivedData", # Xcode build products
  # "~/Library/Caches/org.swift.swiftpm",    # Swift Package Manager
  # "~/.npm",                                # npm cache
  # "~/.cargo/registry",                     # Cargo (whole ~/.cargo also holds credentials.toml)
  # "~/.rustup",                             # Rust toolchains
  # "~/go/pkg/mod",                          # Go module cache
  # "~/Library/Caches/go-build",             # Go build cache
  # "~/Library/Caches/pip",                  # pip
  # "~/.gradle/caches",                      # Gradle (gradle.properties holds signing keys)
  # "~/.m2/repository",                      # Maven (settings.xml holds repo passwords)
]
#
# Per-project policy lives in this global config and applies to the named
# directory and its descendants. Paths must be absolute or start with ~/.
# [projects."~/Dev/app"]
# hide = ["~/.config/acme-production"]
# allowRead = ["~/.config/git"]
# extraWritable = ["~/.cache/acme-build"]
# hideHomeAlways = true
`;
}

const TOP_LEVEL_KEYS = new Set([
  "hideHomeAlways",
  "homeAccess",
  "hide",
  "allowRead",
  "extraWritable",
  "cwdOverrides",
  "tools",
  "projects",
]);
const TOOL_KEYS = new Set([
  "name",
  "cliCmd",
  "yoloArg",
  "rwDirs",
  "rwFiles",
  "hide",
  "extraWritable",
  "hideHomeAlways",
]);
const PROJECT_KEYS = new Set([
  "hide",
  "allowRead",
  "extraWritable",
  "hideHomeAlways",
]);
const RESERVED_TOOL_KEYS = new Set(["tools", "init", "help"]);

function configError(configPath: string, message: string): Result<never, Error> {
  return Result.error(new Error(`${configPath}: ${message}`));
}

/** Shared so command-line aliases cannot drift from config parsing rules. */
export function validateToolKey(
  toolKey: string,
  configPath: string = getConfigPath()
): Result<string, Error> {
  if (
    toolKey.length === 0 ||
    !/^[A-Za-z0-9._-]+$/.test(toolKey) ||
    toolKey.startsWith("-") ||
    RESERVED_TOOL_KEYS.has(toolKey)
  ) {
    return configError(configPath, `Invalid tool key "${toolKey}"`);
  }
  return Result.ok(toolKey);
}

/**
 * Bun merges repeated tool and project tables when their fields do not collide,
 * so the parsed object cannot tell a valid definition from two accidentally
 * combined definitions. Inspect table headers before parsing while still
 * letting Bun decide TOML syntax.
 *
 * This deliberately scans every line, including lines inside multi-line
 * strings. The schema's values are booleans, paths, display names, or inline
 * tables, so a real config does not need a multi-line string containing a
 * `[tools.x]`-shaped line. In contrast, trying to skip string bodies from this
 * lightweight scan can be fooled by ordinary comments or quoted display names
 * and silently miss a duplicate that Bun then merges.
 *
 * The tradeoff is intentional: a `[tools.…]`-shaped line inside a multi-line
 * string is reported as a duplicate. A check built out of "skip these lines"
 * can only fail silently; over-reporting is a loud error with an obvious fix,
 * while under-reporting silently merges a tool definition. Bias this check
 * toward over-reporting.
 */
function findDuplicateTable(
  toml: string
): { kind: "tools" | "projects"; key: string } | undefined {
  const seen = {
    tools: new Set<string>(),
    projects: new Set<string>(),
  };
  for (const line of toml.split(/\r?\n/)) {
    const match = line.match(/^\s*\[(?!\[)(.*)\]\s*(?:#.*)?$/);
    if (!match) continue;
    try {
      const header = Bun.TOML.parse(`[${match[1]}]\n`) as unknown;
      if (!isTable(header)) continue;
      const topKeys = Object.keys(header);
      if (
        topKeys.length !== 1 ||
        (topKeys[0] !== "tools" && topKeys[0] !== "projects")
      ) {
        continue;
      }
      const kind = topKeys[0];
      const table = header[kind];
      if (!isTable(table)) continue;
      const keys = Object.keys(table);
      if (keys.length !== 1) continue;
      const key = keys[0]!;
      if (!isTable(table[key]) || Object.keys(table[key]).length !== 0) {
        continue;
      }
      if (seen[kind].has(key)) return { kind, key };
      seen[kind].add(key);
    } catch {
      // The full parser below owns syntax diagnostics, including line numbers.
    }
  }
  return undefined;
}

function validateStringArray(
  value: unknown,
  field: string,
  configPath: string,
  required: boolean
): Result<string[], Error> {
  if (value === undefined && !required) return Result.ok([]);
  if (!Array.isArray(value)) {
    return configError(configPath, `Missing or invalid field: ${field}`);
  }
  for (const item of value) {
    if (typeof item !== "string") {
      return configError(
        configPath,
        `Invalid entry in ${field}: expected string`
      );
    }
  }
  return Result.ok(value as string[]);
}

/**
 * Validate a read/write policy path from any source — config fields, per-tool
 * tables, or CLI flags. Rejects anything that would widen the sandbox to all of
 * $HOME or to the filesystem root once expanded, plus relative spellings, which
 * the backends would resolve against the invoking cwd.
 *
 * Absolute spellings that merely sit outside $HOME (including ancestors such as
 * "/Users") are deliberately permitted: naming one is an explicit choice, and
 * it is the documented way to grant access the tilde forms cannot express.
 *
 * Pass `configPath` to prefix the error for a config-sourced value; omit it for
 * CLI-sourced values, where a file prefix would be misleading.
 */
export function validatePolicyPath(
  path: string,
  label: string,
  configPath?: string
): Result<string, Error> {
  const result = validateSharedPolicyPath(path, label);
  if (result.ok || configPath === undefined) return result;
  return configError(configPath, result.error.message);
}

function rejectControlChars(
  value: string,
  label: string,
  configPath?: string
): Result<string, Error> {
  const result = rejectPolicyControlChars(value, label);
  if (result.ok || configPath === undefined) return result;
  return configError(configPath, result.error.message);
}

/**
 * rwPath and cliCmd deliberately keep a stricter boundary than other policy
 * paths: they reject quotes as well as controls. Do not fold this into
 * rejectControlChars. Quotes are legal macOS path characters, and hide,
 * allowRead, and extraWritable are safely escaped by sbplEscape.
 */
function assertPolicySafe(
  value: string,
  label: string,
  configPath: string
): Result<string, Error> {
  const safe = rejectControlChars(value, label, configPath);
  if (!safe.ok || value.includes('"')) {
    return configError(
      configPath,
      `Invalid ${label}: control characters and quotes are not allowed, got ${JSON.stringify(value)}`
    );
  }
  return Result.ok(value);
}

export function validateRwPath(
  path: string,
  configPath: string = getConfigPath()
): Result<string, Error> {
  // rwPaths are joined onto $HOME (main.ts), so anything resolving to "."
  // grants all of $HOME and can undo --hide-home. Judge tilde use on the raw
  // spelling, then store a normalized path for deterministic downstream joins.
  if (path.length === 0) {
    return configError(
      configPath,
      `Invalid rwPath: path must not be empty, got "${path}"`
    );
  }
  if (path === "~" || path.startsWith("~/")) {
    return configError(
      configPath,
      `Invalid rwPath: tilde is not expanded for rwPaths, got "${path}"`
    );
  }
  const safe = assertPolicySafe(path, "rwPath", configPath);
  if (!safe.ok) return Result.error(safe.error);
  const normalized = normalize(path);
  const normalizedPath =
    normalized === "/" ? normalized : normalized.replace(/\/+$/, "");
  if (normalizedPath === ".") {
    return configError(
      configPath,
      `Invalid rwPath: path must not resolve to the home directory, got "${path}"`
    );
  }
  if (normalizedPath.startsWith("/")) {
    return configError(
      configPath,
      `Invalid rwPath: path must be relative, got "${path}"`
    );
  }
  if (normalizedPath.split("/").some((component) => component === "..")) {
    return configError(
      configPath,
      `Invalid rwPath: path must be relative without traversal, got "${path}"`
    );
  }
  return Result.ok(normalizedPath);
}

/** Parse and validate a TOML config document. */
export function parseConfig(
  toml: string,
  configPath: string = getConfigPath()
): Result<AegisConfig, Error> {
  // The empty-document guard below separately prevents a silent empty policy.
  const content = stripBom(toml);
  const duplicate = findDuplicateTable(content);
  if (duplicate !== undefined) {
    if (duplicate.kind === "tools") {
      return configError(
        configPath,
        `Duplicate tool table "${duplicate.key}"; define each [tools.<name>] once`
      );
    }
    return configError(
      configPath,
      `Duplicate project table "${duplicate.key}"; define each [projects."<dir>"] once`
    );
  }

  const parsed = parseToml(content, configPath);
  if (!parsed.ok) return Result.error(parsed.error);
  const raw = parsed.value;

  if (!isTable(raw)) {
    return configError(configPath, "Config must be a TOML document");
  }
  const obj = raw as Record<string, unknown>;

  if (Object.keys(obj).length === 0) {
    return configError(
      configPath,
      "Config contains no recognized top-level keys"
    );
  }
  for (const key of Object.keys(obj)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      return configError(configPath, `Unknown top-level key "${key}"`);
    }
  }

  if (typeof obj.hideHomeAlways !== "boolean") {
    return configError(
      configPath,
      "Missing or invalid field: hideHomeAlways"
    );
  }

  const homeAccess = obj.homeAccess ?? "blocklist";
  if (homeAccess !== "blocklist" && homeAccess !== "allowlist") {
    return configError(
      configPath,
      'Invalid homeAccess: expected "blocklist" or "allowlist"'
    );
  }

  const hideResult = validateStringArray(obj.hide, "hide", configPath, true);
  if (!hideResult.ok) return Result.error(hideResult.error);
  for (const path of hideResult.value) {
    const pathResult = validatePolicyPath(path, "hide", configPath);
    if (!pathResult.ok) return Result.error(pathResult.error);
  }

  const allowReadResult = validateStringArray(
    obj.allowRead,
    "allowRead",
    configPath,
    false
  );
  if (!allowReadResult.ok) return Result.error(allowReadResult.error);
  for (const path of allowReadResult.value) {
    const pathResult = validatePolicyPath(path, "allowRead", configPath);
    if (!pathResult.ok) return Result.error(pathResult.error);
  }

  const extraWritableResult = validateStringArray(
    obj.extraWritable,
    "extraWritable",
    configPath,
    false
  );
  if (!extraWritableResult.ok) {
    return Result.error(extraWritableResult.error);
  }
  for (const path of extraWritableResult.value) {
    const pathResult = validatePolicyPath(
      path,
      "extraWritable",
      configPath
    );
    if (!pathResult.ok) return Result.error(pathResult.error);
  }

  let cwdOverrides: OverrideEntry[] = [];
  if (obj.cwdOverrides !== undefined) {
    const ovResult = validateOverrideEntries(obj.cwdOverrides);
    if (!ovResult.ok) {
      return configError(configPath, ovResult.error.message);
    }
    cwdOverrides = ovResult.value;
  }

  let tools: ConfiguredCliDef[];
  if (obj.tools === undefined) {
    tools = [];
  } else {
    if (Array.isArray(obj.tools)) {
      return configError(
        configPath,
        "Invalid tools migration: use `[tools.<name>]` tables, not `[[tools]]`"
      );
    }
    if (!isTable(obj.tools)) {
      return configError(configPath, "Invalid field: tools must be a table");
    }
    tools = [];
    for (const [subCommand, rawEntry] of Object.entries(obj.tools)) {
      const toolKeyResult = validateToolKey(subCommand, configPath);
      if (!toolKeyResult.ok) return Result.error(toolKeyResult.error);
      if (!isTable(rawEntry)) {
        return configError(
          configPath,
          `Tool "${subCommand}" value must be a table with cliCmd`
        );
      }
      const entry = rawEntry as Record<string, unknown>;
      if (
        entry.cliCmd === undefined &&
        Object.values(entry).some((value) => isTable(value))
      ) {
        return configError(
          configPath,
          `Tool "${subCommand}" value must be a table with cliCmd`
        );
      }
      for (const key of Object.keys(entry)) {
        if (key === "rwPaths") {
          return configError(
            configPath,
            `Unknown key "rwPaths" in tool "${subCommand}"; use rwDirs/rwFiles`
          );
        }
        if (!TOOL_KEYS.has(key)) {
          return configError(
            configPath,
            `Unknown key "${key}" in tool "${subCommand}"`
          );
        }
      }
      if (typeof entry.cliCmd !== "string") {
        return configError(
          configPath,
          `Tool "${subCommand}" value must be a table with cliCmd`
        );
      }
      // cliCmd becomes toolPath and is emitted into the Seatbelt profile as a
      // (literal "…"), so it needs the same boundary as an rwPath.
      const safeCliCmd = assertPolicySafe(
        entry.cliCmd,
        `cliCmd in tool "${subCommand}"`,
        configPath
      );
      if (!safeCliCmd.ok) return Result.error(safeCliCmd.error);
      if (typeof entry.name !== "string") {
        return configError(
          configPath,
          `Invalid tool "${subCommand}": missing name`
        );
      }
      const dirsResult = validateStringArray(
        entry.rwDirs,
        `tools.${subCommand}.rwDirs`,
        configPath,
        false
      );
      if (!dirsResult.ok) return Result.error(dirsResult.error);
      const filesResult = validateStringArray(
        entry.rwFiles,
        `tools.${subCommand}.rwFiles`,
        configPath,
        false
      );
      if (!filesResult.ok) return Result.error(filesResult.error);
      const toolHideResult = validateStringArray(
        entry.hide,
        `tools.${subCommand}.hide`,
        configPath,
        false
      );
      if (!toolHideResult.ok) return Result.error(toolHideResult.error);
      for (const path of toolHideResult.value) {
        const pathResult = validatePolicyPath(
          path,
          `tools.${subCommand}.hide`,
          configPath
        );
        if (!pathResult.ok) return Result.error(pathResult.error);
      }
      const toolExtraWritableResult = validateStringArray(
        entry.extraWritable,
        `tools.${subCommand}.extraWritable`,
        configPath,
        false
      );
      if (!toolExtraWritableResult.ok) {
        return Result.error(toolExtraWritableResult.error);
      }
      for (const path of toolExtraWritableResult.value) {
        const pathResult = validatePolicyPath(
          path,
          `tools.${subCommand}.extraWritable`,
          configPath
        );
        if (!pathResult.ok) return Result.error(pathResult.error);
      }
      if (
        entry.hideHomeAlways !== undefined &&
        typeof entry.hideHomeAlways !== "boolean"
      ) {
        return configError(
          configPath,
          `Invalid tool "${subCommand}": hideHomeAlways must be a boolean`
        );
      }

      // bwrap creates file mountpoints inside their parent directory, so
      // directories must structurally precede files regardless of TOML order.
      const rwPaths: RwPath[] = [];
      for (const [kind, paths] of [
        ["dir", dirsResult.value],
        ["file", filesResult.value],
      ] as const) {
        for (const path of paths) {
          const pathResult = validateRwPath(path, configPath);
          if (!pathResult.ok) return Result.error(pathResult.error);
          rwPaths.push({ kind, path: pathResult.value });
        }
      }

      const def: ConfiguredCliDef = {
        name: entry.name as string,
        cliCmd: entry.cliCmd as string,
        subCommand,
        rwPaths,
      };
      if (entry.hide !== undefined) def.hide = toolHideResult.value;
      if (entry.extraWritable !== undefined) {
        def.extraWritable = toolExtraWritableResult.value;
      }
      if (entry.hideHomeAlways !== undefined) {
        def.hideHomeAlways = entry.hideHomeAlways;
      }
      if (entry.yoloArg !== undefined) {
        if (typeof entry.yoloArg !== "string") {
          return configError(
            configPath,
            `Invalid tool "${subCommand}": yoloArg must be a string`
          );
        }
        def.yoloArg = entry.yoloArg;
      }
      tools.push(def);
    }
  }

  let projects: ProjectBlock[];
  if (obj.projects === undefined) {
    projects = [];
  } else {
    if (!isTable(obj.projects)) {
      return configError(configPath, "Invalid field: projects must be a table");
    }
    projects = [];
    for (const [key, rawEntry] of Object.entries(obj.projects)) {
      // Shape before spelling: an unquoted `[projects.Dev.app]` parses as
      // nested tables, and naming that shape is more useful than reporting
      // "Dev" as a bad path.
      if (
        !isTable(rawEntry) ||
        Object.values(rawEntry).some((value) => isTable(value))
      ) {
        return configError(
          configPath,
          `Project "${key}" must be a table of settings; write the directory as a quoted key, e.g. [projects."~/Dev/app"]`
        );
      }
      const keyResult = validatePolicyPath(key, "projects key", configPath);
      if (!keyResult.ok) return Result.error(keyResult.error);
      const entry = rawEntry as Record<string, unknown>;
      for (const entryKey of Object.keys(entry)) {
        if (!PROJECT_KEYS.has(entryKey)) {
          return configError(
            configPath,
            `Unknown key "${entryKey}" in project "${key}"`
          );
        }
      }

      const validatedPaths: Record<
        "hide" | "allowRead" | "extraWritable",
        string[]
      > = { hide: [], allowRead: [], extraWritable: [] };
      for (const field of ["hide", "allowRead", "extraWritable"] as const) {
        const label = `projects."${key}".${field}`;
        const pathsResult = validateStringArray(
          entry[field],
          label,
          configPath,
          false
        );
        if (!pathsResult.ok) return Result.error(pathsResult.error);
        for (const path of pathsResult.value) {
          const pathResult = validatePolicyPath(path, label, configPath);
          if (!pathResult.ok) return Result.error(pathResult.error);
        }
        validatedPaths[field] = pathsResult.value;
      }
      if (
        entry.hideHomeAlways !== undefined &&
        typeof entry.hideHomeAlways !== "boolean"
      ) {
        return configError(
          configPath,
          `Invalid project "${key}": hideHomeAlways must be a boolean`
        );
      }
      projects.push({
        key,
        hide: validatedPaths.hide,
        allowRead: validatedPaths.allowRead,
        extraWritable: validatedPaths.extraWritable,
        hideHomeAlways: entry.hideHomeAlways ?? false,
      });
    }
  }

  return Result.ok({
    hideHomeAlways: obj.hideHomeAlways as boolean,
    homeAccess,
    hide: hideResult.value,
    allowRead: allowReadResult.value,
    extraWritable: extraWritableResult.value,
    cwdOverrides,
    tools,
    projects,
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
  return join(configHome, "aegis", "config.toml");
}

/**
 * Load config from disk, creating default if missing.
 */
export async function loadConfig(): Promise<Result<AegisConfig, Error>> {
  const configPath = getConfigPath();

  if (!existsSync(configPath)) {
    // A leftover config.json is ignored outright: aegis has only ever read TOML
    // for released users, and a stale JSON file is not a reason to refuse to
    // start. It is left on disk untouched.
    const dir = dirname(configPath);
    await mkdir(dir, { recursive: true });
    const defaultCfg = defaultConfig();
    const tmp = join(dir, `.aegis-config-${process.pid}.tmp`);
    await writeFile(tmp, defaultConfigContent(), "utf-8");
    await rename(tmp, configPath);
    return Result.ok(defaultCfg);
  }

  const content = await readFile(configPath, "utf-8");
  return parseConfig(content, configPath);
}

/**
 * Validate that per-tool hide paths exist and are directories.
 *
 * This serves per-tool hides only — its sole caller resolves `tools.<x>.hide`.
 * CLI `--hide` takes a different route (resolveAndValidateHidePath), so a check
 * added here does not cover it; state any deny-side rule in both places or
 * neither.
 *
 * Deny-side paths get the home/root check even though over-denying is
 * fail-closed: `--hide ~/../..` denies `/` and breaks the tool outright, which
 * is worth an error rather than a baffling sandbox.
 */
export function validateHidePaths(
  paths: string[]
): Result<string[], Error> {
  for (const p of paths) {
    const safe = validatePolicyPath(p, "tool hide");
    if (!safe.ok) return Result.error(safe.error);
    const check = assertDirectory(p);
    if (!check.ok) return Result.error(check.error);
  }
  return Result.ok(paths);
}
