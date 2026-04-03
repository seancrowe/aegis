/**
 * CWD-relative bind overrides — shared types, parser, loader, and resolver.
 * Used by both .aegis.json (per-project) and config.cwdOverrides (global).
 */
import { Result } from "typescript-result";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve, normalize } from "node:path";

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
    const e: OverrideEntry = { target: obj.target };
    if (obj.override !== undefined) e.override = obj.override as string;
    result.push(e);
  }
  return Result.ok(result);
}

/**
 * Parse a JSON string into validated OverrideEntry[].
 */
export function parseOverrides(json: string): Result<OverrideEntry[], Error> {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return Result.error(new Error("Invalid JSON in overrides"));
  }
  return validateOverrideEntries(raw);
}

/**
 * Load project overrides from <cwd>/.aegis.json.
 * Returns null if the file does not exist.
 */
export async function loadProjectOverrides(
  cwd: string
): Promise<Result<OverrideEntry[] | null, Error>> {
  const filePath = join(cwd, ".aegis.json");
  if (!existsSync(filePath)) return Result.ok(null);
  try {
    const content = await readFile(filePath, "utf-8");
    return parseOverrides(content);
  } catch (err) {
    return Result.error(
      err instanceof Error ? err : new Error(String(err))
    );
  }
}

/**
 * Resolve a raw path (~/..., relative, or absolute) to an absolute path.
 */
export function resolvePath(raw: string, cwd: string, home: string): string {
  if (raw === "~") return home;
  if (raw.startsWith("~/"))
    return normalize(join(home, raw.slice(2)));
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
