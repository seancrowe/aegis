/**
 * CWD-relative bind overrides — shared types, parser, loader, and resolver.
 * Used by both .aegis.toml (per-project) and config.cwdOverrides (global).
 */
import { Result } from "typescript-result";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isTable, parseToml, stripBom } from "./toml";
import {
  expandUserPath,
  validatePolicyPath,
} from "./policyPath";

export interface OverrideEntry {
  target: string;
  override?: string;
}

export interface ResolvedOverride {
  target: string;
  source: string;
  kind: "file" | "dir";
}

/**
 * Validate that a value is an array of OverrideEntry objects.
 */
export function validateOverrideEntries(
  entries: unknown
): Result<OverrideEntry[], Error> {
  if (!Array.isArray(entries)) {
    return Result.error(new Error("Override entries must be an array"));
  }
  const result: OverrideEntry[] = [];
  for (const entry of entries) {
    // String shorthand: "foo" → { target: "foo" }
    if (typeof entry === "string") {
      if (entry.length === 0) {
        return Result.error(
          new Error("Override entry: target must be a non-empty string")
        );
      }
      const targetResult = validatePolicyPath(entry, "override target", {
        allowRelative: true,
      });
      if (!targetResult.ok) return Result.error(targetResult.error);
      result.push({ target: entry });
      continue;
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return Result.error(
        new Error("Override entry must be a string or object")
      );
    }
    const obj = entry as Record<string, unknown>;
    if (typeof obj.target !== "string" || obj.target.length === 0) {
      return Result.error(
        new Error("Override entry: target must be a non-empty string")
      );
    }
    if (
      obj.override !== undefined &&
      (typeof obj.override !== "string" || obj.override.length === 0)
    ) {
      return Result.error(
        new Error("Override entry: override must be a non-empty string")
      );
    }
    const targetResult = validatePolicyPath(
      obj.target,
      "override target",
      { allowRelative: true }
    );
    if (!targetResult.ok) return Result.error(targetResult.error);
    if (typeof obj.override === "string") {
      const overrideResult = validatePolicyPath(
        obj.override,
        "override source",
        { allowRelative: true }
      );
      if (!overrideResult.ok) return Result.error(overrideResult.error);
    }
    const e: OverrideEntry = { target: obj.target };
    if (obj.override !== undefined) e.override = obj.override as string;
    result.push(e);
  }
  return Result.ok(result);
}

function overridesError(
  configPath: string,
  message: string
): Result<never, Error> {
  return Result.error(new Error(`${configPath}: ${message}`));
}

/** Parse and validate a TOML project-overrides document. */
export function parseOverrides(
  toml: string,
  configPath: string = ".aegis.toml"
): Result<OverrideEntry[], Error> {
  // Bun silently treats a BOM-prefixed document as empty, which would drop
  // every masking rule while making the file appear to have loaded normally.
  const content = stripBom(toml);

  const parsed = parseToml(content, configPath);
  if (!parsed.ok) return Result.error(parsed.error);
  const raw = parsed.value;

  if (!isTable(raw)) {
    return overridesError(configPath, "Overrides must be a TOML document");
  }
  const obj = raw as Record<string, unknown>;

  if (Object.keys(obj).length === 0) {
    return overridesError(
      configPath,
      "Overrides contain no recognized top-level keys"
    );
  }
  for (const key of Object.keys(obj)) {
    if (key !== "overrides") {
      return overridesError(configPath, `Unknown top-level key "${key}"`);
    }
  }

  const result = validateOverrideEntries(obj.overrides);
  if (!result.ok) {
    return overridesError(configPath, result.error.message);
  }
  return result;
}

/**
 * Load project overrides from <cwd>/.aegis.toml.
 * Returns null if the file does not exist.
 */
export async function loadProjectOverrides(
  cwd: string
): Promise<Result<OverrideEntry[] | null, Error>> {
  const filePath = join(cwd, ".aegis.toml");
  if (!existsSync(filePath)) return Result.ok(null);
  try {
    const content = await readFile(filePath, "utf-8");
    return parseOverrides(content, filePath);
  } catch (err) {
    return Result.error(
      err instanceof Error ? err : new Error(String(err))
    );
  }
}

/**
 * Reject file-content substitution overrides on backends that can't honor them.
 *
 * A substitution override ({ target, override }) swaps a file for a different
 * one — a bind mount on Linux. macOS Seatbelt can only allow or deny a path,
 * not substitute its contents, so such entries must error rather than silently
 * doing the wrong thing. Masking entries (no `override`) are always fine.
 */
export function assertContentOverridesSupported(
  backend: { bin: string; supportsContentOverride: boolean },
  sources: { label: string; entries: OverrideEntry[] }[]
): Result<void, Error> {
  if (backend.supportsContentOverride) return Result.ok();

  const offending = sources
    .map((s) => ({
      label: s.label,
      subs: s.entries.filter((e) => e.override !== undefined),
    }))
    .filter((s) => s.subs.length > 0);
  if (offending.length === 0) return Result.ok();

  const blocks = offending
    .map(
      (s) =>
        `  ${s.label}:\n` +
        s.subs.map((e) => `    - "${e.target}" -> "${e.override}"`).join("\n")
    )
    .join("\n");

  return Result.error(
    new Error(
      `aegis: file-content override is not supported on the ${backend.bin} backend.\n` +
        `macOS Seatbelt can deny or allow a path, but cannot substitute its contents,\n` +
        `so an override that swaps a file for a different one cannot be honored.\n\n` +
        `Unsupported entries:\n${blocks}\n\n` +
        `Fix one of:\n` +
        `  - Remove the "override" field to MASK the path instead (it becomes inaccessible).\n` +
        `  - Drop these entries from .aegis.toml / config.toml on macOS.\n` +
        `  - Run on Linux (bwrap), where bind-mount substitution is supported.`
    )
  );
}

/**
 * Resolve a raw path (~/..., relative, or absolute) to an absolute path.
 */
export function resolvePath(raw: string, cwd: string, home: string): string {
  if (raw === "~" || raw.startsWith("~/")) {
    return expandUserPath(raw, home);
  }
  return resolve(cwd, raw);
}

/**
 * Resolve override entries into concrete bind-mount instructions.
 * Silently skips entries whose target or override path doesn't exist.
 * Warns to stderr and skips on file/dir type mismatch.
 */
export function resolveOverrides(
  entries: OverrideEntry[],
  cwd: string,
  home: string,
  emptyDir: string
): ResolvedOverride[] {
  const resolved: ResolvedOverride[] = [];
  for (const entry of entries) {
    const targetPath = resolvePath(entry.target, cwd, home);
    if (!existsSync(targetPath)) continue;

    const targetStat = statSync(targetPath);
    const kind = targetStat.isDirectory() ? "dir" : "file";

    if (entry.override !== undefined) {
      const overridePath = resolvePath(entry.override, cwd, home);
      if (!existsSync(overridePath)) continue;
      const overrideStat = statSync(overridePath);
      const overrideKind = overrideStat.isDirectory() ? "dir" : "file";
      if (kind !== overrideKind) {
        process.stderr.write(
          `aegis: override type mismatch for "${entry.target}" ` +
            `(target is ${kind}, override is ${overrideKind}), skipping\n`
        );
        continue;
      }
      resolved.push({ target: targetPath, source: overridePath, kind });
    } else {
      const source = kind === "file" ? "/dev/null" : emptyDir;
      resolved.push({ target: targetPath, source, kind });
    }
  }
  return resolved;
}
