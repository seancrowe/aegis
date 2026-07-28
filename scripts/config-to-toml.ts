#!/usr/bin/env bun
/**
 * Convert an aegis JSON5 config.json to config.toml without modifying either
 * the source file or the user's real config location.
 *
 * Usage:
 *   bun run scripts/config-to-toml.ts <src-config.json> <out-config.toml>
 */
import JSON5 from "json5";
import { readFileSync, writeFileSync } from "node:fs";
import {
  TOOL_CATALOG,
  renderToolTable,
  tomlString,
  type ToolRecipe,
} from "../src/tools/catalog";
import {
  parseConfig,
  validateRwPath,
  validateToolKey,
} from "../src/config/config";
import { validateOverrideEntries } from "../src/config/overrides";
import type { OverrideEntry } from "../src/config/overrides";

const sourcePath = process.argv[2];
const outputPath = process.argv[3];
if (sourcePath === undefined || outputPath === undefined) {
  throw new Error(
    "Usage: bun run scripts/config-to-toml.ts <src-config.json> <out-config.toml>"
  );
}

/** Annotations carried over from the old JSON5 template, keyed by path. */
const NOTES: Record<string, string> = {
  "~/Library/Developer/Xcode/DerivedData": "Xcode build products",
  "~/Library/Caches/org.swift.swiftpm": "Swift Package Manager",
  "~/.npm": "npm cache",
  "~/.cargo/registry": "Cargo (whole ~/.cargo also holds credentials.toml)",
  "~/.rustup": "Rust toolchains",
  "~/go/pkg/mod": "Go module cache",
  "~/Library/Caches/go-build": "Go build cache",
  "~/Library/Caches/pip": "pip",
  "~/.gradle/caches": "Gradle (gradle.properties holds signing keys)",
  "~/.m2/repository": "Maven (settings.xml holds repo passwords)",
};

function tomlArray(key: string, values: string[]): string {
  if (values.length === 0) return `${key} = []`;
  const width = Math.max(...values.map((value) => tomlString(value).length));
  const lines = values.map((value) => {
    const literal = `  ${tomlString(value)},`;
    const note = NOTES[value];
    return note ? `${literal.padEnd(width + 4)} # ${note}` : literal;
  });
  return `${key} = [\n${lines.join("\n")}\n]`;
}

const raw = readFileSync(sourcePath, "utf-8");
const config = JSON5.parse(raw) as Record<string, unknown>;

if (typeof config.hideHomeAlways !== "boolean") {
  throw new Error(
    `${sourcePath}: missing or invalid "hideHomeAlways" (expected boolean)`
  );
}
if (
  !Array.isArray(config.hide) ||
  config.hide.some((value) => typeof value !== "string")
) {
  throw new Error(
    `${sourcePath}: missing or invalid "hide" (expected string array)`
  );
}
// The legacy parser treated extraWritable as optional (default []), so a
// config aegis itself accepted must not be rejected here.
const extraWritable = config.extraWritable ?? [];
if (
  !Array.isArray(extraWritable) ||
  extraWritable.some((value) => typeof value !== "string")
) {
  throw new Error(
    `${sourcePath}: invalid "extraWritable" (expected string array)`
  );
}
const homeAccess = config.homeAccess ?? "blocklist";
if (homeAccess !== "blocklist" && homeAccess !== "allowlist") {
  throw new Error(
    `${sourcePath}: invalid "homeAccess" (expected "blocklist" or "allowlist")`
  );
}
const allowRead = config.allowRead ?? [];
if (
  !Array.isArray(allowRead) ||
  allowRead.some((value) => typeof value !== "string")
) {
  throw new Error(
    `${sourcePath}: invalid "allowRead" (expected string array)`
  );
}

const known = new Set([
  "hideHomeAlways",
  "homeAccess",
  "hide",
  "allowRead",
  "extraWritable",
  "clis",
  "cwdOverrides",
]);
const unknown = Object.keys(config).filter((key) => !known.has(key));
if (unknown.length > 0) {
  console.warn(`! not carried over (unknown keys): ${unknown.join(", ")}`);
}
/**
 * Convert the legacy `clis[]` array into tool recipes.
 *
 * A migration that silently substitutes catalog defaults for a user's own
 * entries drops custom rwPaths, custom yoloArgs, and — worst — tools the user
 * deliberately removed. Every entry is validated against the same rules the
 * TOML loader applies, and anything invalid is a hard error rather than a file
 * aegis will later refuse.
 *
 * The legacy field is `rwPaths`; the TOML spelling is `rwDirs`/`rwFiles`, and
 * `rwPaths` is an explicitly rejected tool key. renderToolTable does that split.
 */
function toolRecipesFromClis(clis: unknown): ToolRecipe[] {
  if (!Array.isArray(clis)) {
    throw new Error(`${sourcePath}: invalid "clis" (expected array)`);
  }
  const seen = new Set<string>();
  return clis.map((raw, index) => {
    const where = `${sourcePath}: clis[${index}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`${where}: expected an object`);
    }
    const entry = raw as Record<string, unknown>;
    for (const field of ["name", "cliCmd", "subCommand"] as const) {
      if (typeof entry[field] !== "string" || entry[field].length === 0) {
        throw new Error(`${where}: missing or invalid "${field}"`);
      }
    }
    const subCommand = entry.subCommand as string;
    const keyResult = validateToolKey(subCommand, sourcePath);
    if (!keyResult.ok) throw keyResult.error;
    if (seen.has(subCommand)) {
      throw new Error(`${where}: duplicate subCommand "${subCommand}"`);
    }
    seen.add(subCommand);

    if (entry.yoloArg !== undefined && typeof entry.yoloArg !== "string") {
      throw new Error(`${where}: "yoloArg" must be a string`);
    }
    if (!Array.isArray(entry.rwPaths)) {
      throw new Error(`${where}: missing or invalid "rwPaths"`);
    }
    const rwPaths: ToolRecipe["rwPaths"] = entry.rwPaths.map((
      rp: unknown,
      rpIndex: number
    ): ToolRecipe["rwPaths"][number] => {
      if (typeof rp !== "object" || rp === null || Array.isArray(rp)) {
        throw new Error(`${where}.rwPaths[${rpIndex}]: expected an object`);
      }
      const { kind, path } = rp as Record<string, unknown>;
      if (kind !== "file" && kind !== "dir") {
        throw new Error(
          `${where}.rwPaths[${rpIndex}]: invalid kind ${JSON.stringify(kind)}`
        );
      }
      if (typeof path !== "string") {
        throw new Error(`${where}.rwPaths[${rpIndex}]: missing "path"`);
      }
      const pathResult = validateRwPath(path, sourcePath);
      if (!pathResult.ok) throw pathResult.error;
      return { kind, path: pathResult.value };
    });

    return {
      name: entry.name as string,
      cliCmd: entry.cliCmd as string,
      subCommand,
      ...(entry.yoloArg === undefined ? {} : { yoloArg: entry.yoloArg }),
      rwPaths,
    };
  });
}

// Absent `clis` means "the user never customized tools" — only then is the
// catalog the right answer.
const usesCatalog = config.clis === undefined;
const recipes = usesCatalog
  ? TOOL_CATALOG
  : toolRecipesFromClis(config.clis);
const toolTables = recipes
  .map((recipe) => renderToolTable(recipe, process.platform))
  .join("\n");

// cwdOverrides are policy. The new schema accepts them, so carry them over;
// writing a complete-looking file that quietly lost a masking rule is the
// failure this whole script exists to avoid.
let cwdOverrides: OverrideEntry[] = [];
if (config.cwdOverrides !== undefined) {
  const ovResult = validateOverrideEntries(config.cwdOverrides);
  if (!ovResult.ok) {
    throw new Error(`${sourcePath}: invalid "cwdOverrides": ${ovResult.error.message}`);
  }
  cwdOverrides = ovResult.value;
}
const cwdOverridesBlock =
  cwdOverrides.length === 0
    ? ""
    : `\n# CWD-relative bind overrides applied to every project.\ncwdOverrides = [\n${cwdOverrides
        .map((entry) => {
          const fields = [`target = ${tomlString(entry.target)}`];
          if (entry.override !== undefined) {
            fields.push(`override = ${tomlString(entry.override)}`);
          }
          return `  { ${fields.join(", ")} },`;
        })
        .join("\n")}\n]\n`;

const hide = config.hide as string[];
const toml = `# aegis config — TOML.
# CLI flags are merged at runtime but never written back here, so the
# comments in this file are safe to edit and will not be clobbered.

# Replace $HOME with an empty view on every run (same as --hide-home).
hideHomeAlways = ${config.hideHomeAlways}

# Choose whether $HOME is readable except for hide entries, or masked wholesale.
homeAccess = ${tomlString(homeAccess)}

# Directories made invisible inside the sandbox. Supports ~.
${tomlArray("hide", hide)}

# Extra paths to keep READABLE when $HOME is masked. Supports ~.
${tomlArray("allowRead", allowRead as string[])}

# Extra dirs to keep WRITABLE beyond your project + tool config — the
# escape hatch for build/compiler caches a tool writes outside the project.
# WARNING: these live under $HOME and some also hold credentials, so prefer
# the narrowest subpath that fixes your write error.
${tomlArray("extraWritable", extraWritable as string[])}
${cwdOverridesBlock}
${toolTables}`;

// Validate before writing: a migration that produces a file aegis rejects
// should fail here, loudly, not later at an unrelated call site.
const validated = parseConfig(toml, outputPath);
if (!validated.ok) {
  throw new Error(
    `${sourcePath}: migration produced a config aegis rejects — ${validated.error.message}`
  );
}

writeFileSync(outputPath, toml, "utf-8");

console.log(`read  ${sourcePath}`);
console.log(`wrote ${outputPath}`);
console.log(
  `      ${hide.length} hide, ${extraWritable.length} extraWritable, ` +
    `${cwdOverrides.length} cwdOverrides, ${recipes.length} tools` +
    `${usesCatalog ? " (from catalog; source had no clis)" : ""}`
);
