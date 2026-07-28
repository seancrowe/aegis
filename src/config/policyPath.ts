import { Result } from "typescript-result";
import { isAbsolute, join, normalize } from "node:path";

/** Expand a user-facing path spelling and normalize the result. */
export function expandUserPath(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return normalize(join(home, path.slice(2)));
  return normalize(path);
}

/**
 * Reject control characters, including DEL, before a value reaches a sandbox
 * policy. SBPL escaping handles quotes and backslashes, but a raw control
 * character can split or corrupt a generated profile line.
 */
export function rejectControlChars(
  value: string,
  label: string
): Result<string, Error> {
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) {
      return Result.error(
        new Error(
          `Invalid ${label}: control characters are not allowed, got ` +
            JSON.stringify(value)
        )
      );
    }
  }
  return Result.ok(value);
}

/**
 * Whether a `~/`-relative remainder resolves to $HOME itself or escapes above
 * it. Judge the remainder rather than the whole spelling: expansion computes
 * normalize(join(home, rem)), and normalize(spelling) disagrees with that in
 * two ways that both defeated earlier versions of this check —
 * normalize("./") is "./" rather than ".", and normalize() clamps leading ".."
 * at root while join() does not, because $HOME supplies the depth.
 */
function escapesOrIsHome(rem: string): boolean {
  const n = normalize(rem);
  // join() re-anchors an absolute remainder under $HOME, but normalize() has
  // already clamped its leading ".." at root. Counting the clamped form
  // understates the escape ("~//../../etc" -> "/etc"), so refuse the shape.
  if (n.startsWith("/")) return true;
  let depth = 0;
  for (const part of n.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      depth--;
      // A remainder that leaves home even transiently is refused, matching
      // validateRwPath's outright ban on ".." components.
      if (depth < 0) return true;
    } else {
      depth++;
    }
  }
  return depth === 0; // resolves to $HOME itself
}

/**
 * Validate a sandbox policy path. Callers whose paths are intentionally
 * cwd-relative (override targets and sources) may allow relative spellings
 * without weakening the shared control-character and home/root checks.
 */
export function validatePolicyPath(
  path: string,
  label: string,
  options: { allowRelative?: boolean } = {}
): Result<string, Error> {
  const safe = rejectControlChars(path, `${label} path`);
  if (!safe.ok) return Result.error(safe.error);

  let reason: string | undefined;
  if (path === "~") {
    reason = "home/root shorthand is not allowed";
  } else if (path.startsWith("~/")) {
    const rem = path.slice(2);
    if (escapesOrIsHome(rem)) {
      const normalizedSpelling = normalize(path);
      reason = normalizedSpelling === "~" || normalizedSpelling === "~/"
        ? "home/root shorthand is not allowed"
        : "traversal outside $HOME is not allowed - use an absolute path";
    }
  } else if (!isAbsolute(path)) {
    const normalized = normalize(path);
    if (
      !options.allowRelative ||
      normalized === ".." ||
      normalized.startsWith("../")
    ) {
      reason = "traversal outside $HOME is not allowed - use an absolute path";
    }
  } else if ((normalize(path).replace(/\/+$/, "") || "/") === "/") {
    reason = "home/root shorthand is not allowed";
  }

  if (reason === undefined) return Result.ok(path);
  return Result.error(
    new Error(
      `Invalid ${label} path: ${reason}, got ${JSON.stringify(path)}`
    )
  );
}
