/**
 * The tool catalog — inert recipes, not runtime defaults.
 *
 * Config files own their tool definitions. These recipes feed the generated
 * template, explicit setup commands, and migration script. Runtime config
 * parsing never consults the catalog: if a tool is absent from config, it does
 * not exist.
 */
import type { CliDef, RwPath } from "../types";

/** A catalog rwPath, optionally restricted to one platform. */
interface RecipeRwPath extends RwPath {
  /** Emitted only on this platform when set. */
  onlyOn?: NodeJS.Platform;
}

export interface ToolRecipe {
  name: string;
  cliCmd: string;
  subCommand: string;
  yoloArg?: string;
  rwPaths: RecipeRwPath[];
}

export const TOOL_CATALOG: ToolRecipe[] = [
  {
    name: "claude code",
    cliCmd: "claude",
    subCommand: "cc",
    yoloArg: "--dangerously-skip-permissions",
    rwPaths: [
      { kind: "dir", path: ".claude" },
      { kind: "file", path: ".claude.json" },
      // macOS keeps the OAuth tokens in the login keychain, not in
      // ~/.claude/.credentials.json. Without write access the CLI still
      // reads the current token fine, so a session starts up normally — but
      // the refresh a few hours later cannot persist the rotated refresh
      // token. The old one is already spent server-side, so the next
      // non-sandboxed run fails to refresh and presents as a spurious
      // logout. What this grant costs depends on the mode: in blocklist mode
      // it adds only the write, since the profile's (allow default) already
      // permits the read. Under --hide-home or homeAccess = "allowlist" it
      // does more than that — the rwPath allow is emitted after the broad
      // home deny and carries file-read*, so it re-exposes the login keychain
      // for READ through the mask as well as for write. That is unavoidable
      // here: the CLI must read the token it refreshes, so a write-only grant
      // would not work. Gated on darwin because the directory
      // does not exist elsewhere and bwrap's rwPath binds would otherwise
      // have ensureHostPathsExist create an empty one under a Linux $HOME.
      { kind: "dir", path: "Library/Keychains", onlyOn: "darwin" },
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

/** Apply the platform gate, dropping rwPaths restricted to another platform. */
export function resolveRwPaths(
  recipe: ToolRecipe,
  platform: NodeJS.Platform = process.platform
): RwPath[] {
  const paths = recipe.rwPaths
    .filter((rwPath) => rwPath.onlyOn === undefined || rwPath.onlyOn === platform)
    .map(({ kind, path }) => ({ kind, path }));
  // Match the config loader's structural guarantee: bwrap needs directory
  // mountpoints in place before it prepares files nested beneath them.
  return [
    ...paths.filter((rwPath) => rwPath.kind === "dir"),
    ...paths.filter((rwPath) => rwPath.kind === "file"),
  ];
}

/** Materialize a recipe into the runtime CliDef shape. */
export function toCliDef(
  recipe: ToolRecipe,
  platform?: NodeJS.Platform
): CliDef {
  return {
    name: recipe.name,
    cliCmd: recipe.cliCmd,
    subCommand: recipe.subCommand,
    ...(recipe.yoloArg === undefined ? {} : { yoloArg: recipe.yoloArg }),
    rwPaths: resolveRwPaths(recipe, platform),
  };
}

/** Materialize all six catalog recipes as CliDefs for a target platform. */
export function defaultCliDefs(
  platform: NodeJS.Platform = process.platform
): CliDef[] {
  return TOOL_CATALOG.map((recipe) => toCliDef(recipe, platform));
}

/** Quote a string as a TOML basic string. */
export function tomlString(value: string): string {
  let escaped = '"';
  for (const char of value) {
    switch (char) {
      case '"':
        escaped += '\\"';
        break;
      case "\\":
        escaped += "\\\\";
        break;
      case "\n":
        escaped += "\\n";
        break;
      case "\r":
        escaped += "\\r";
        break;
      case "\t":
        escaped += "\\t";
        break;
      case "\b":
        escaped += "\\b";
        break;
      case "\f":
        escaped += "\\f";
        break;
      default: {
        const codePoint = char.codePointAt(0)!;
        escaped +=
          codePoint < 0x20 || codePoint === 0x7f
            ? `\\u${codePoint.toString(16).padStart(4, "0")}`
            : char;
      }
    }
  }
  return escaped + '"';
}

/**
 * Quote a TOML table key. A bare key may only contain [A-Za-z0-9_-]: a dot is
 * legal in a bare key but *nests* (`[tools.my.tool]` parses as
 * `{my: {tool: …}}`, not a tool named "my.tool"), and a space or quote is
 * either a syntax error or a way out of the key entirely. `tools add --as`
 * takes this name from the command line, so the emitter cannot assume the
 * caller already checked it.
 */
function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key);
}

/**
 * Render a recipe as a `[tools.<subCommand>]` TOML block.
 * Shared by the config template, `aegis tools add`, and the migration script —
 * three call sites, one rule — so the emitted set can never drift from the
 * catalog, and the platform gate has a single home.
 */
export function renderToolTable(
  recipe: ToolRecipe,
  platform: NodeJS.Platform = process.platform
): string {
  const rwPaths = resolveRwPaths(recipe, platform);
  const rwDirs = rwPaths.filter((rwPath) => rwPath.kind === "dir");
  const rwFiles = rwPaths.filter((rwPath) => rwPath.kind === "file");
  const lines = [
    `[tools.${tomlKey(recipe.subCommand)}]`,
    `name = ${tomlString(recipe.name)}`,
    `cliCmd = ${tomlString(recipe.cliCmd)}`,
  ];

  if (recipe.yoloArg !== undefined) {
    lines.push(`yoloArg = ${tomlString(recipe.yoloArg)}`);
  }

  // bwrap needs parent directories to exist before nested file mountpoints are
  // created, so directory policy must always precede file policy.
  if (rwDirs.length > 0) {
    lines.push(
      `rwDirs = [${rwDirs.map((rwPath) => tomlString(rwPath.path)).join(", ")}]`
    );
  }
  if (rwFiles.length > 0) {
    lines.push(
      `rwFiles = [${rwFiles.map((rwPath) => tomlString(rwPath.path)).join(", ")}]`
    );
  }

  return lines.join("\n") + "\n";
}
