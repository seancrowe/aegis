/**
 * Path resolution and validation utilities.
 */
import { resolve, normalize } from "node:path";
import { existsSync, statSync } from "node:fs";
import { Result } from "typescript-result";

/**
 * Resolve a path to an absolute path.
 * If the input is already absolute, normalize it.
 * If relative, resolve against the provided cwd.
 */
export function resolveAbsolutePath(
  input: string,
  cwd: string,
  home?: string
): Result<string, Error> {
  let resolved: string;

  if (input === "~" || input.startsWith("~/")) {
    const h = home ?? require("node:os").homedir();
    resolved = input === "~" ? h : resolve(h, input.slice(2));
  } else if (input.startsWith("/")) {
    resolved = normalize(input);
  } else {
    resolved = resolve(cwd, input);
  }

  resolved = normalize(resolved);

  // Remove trailing slash unless root
  if (resolved.length > 1 && resolved.endsWith("/")) {
    resolved = resolved.slice(0, -1);
  }

  return Result.ok(resolved);
}

/**
 * Assert that a path exists and is a directory.
 */
export function assertDirectory(path: string): Result<void, Error> {
  if (!existsSync(path)) {
    return Result.error(new Error(`Path does not exist: ${path}`));
  }
  if (!statSync(path).isDirectory()) {
    return Result.error(new Error(`Path is not a directory: ${path}`));
  }
  return Result.ok();
}

/**
 * Assert that a path exists (file or directory).
 */
export function assertExists(path: string): Result<void, Error> {
  if (!existsSync(path)) {
    return Result.error(new Error(`Path does not exist: ${path}`));
  }
  return Result.ok();
}

/**
 * Resolve and validate a hide path.
 * Combines resolution to absolute and directory validation.
 */
export function resolveAndValidateHidePath(
  input: string,
  cwd: string
): Result<string, Error> {
  const resolved = resolveAbsolutePath(input, cwd);
  if (!resolved.ok) return resolved;

  const dirCheck = assertDirectory(resolved.value);
  if (!dirCheck.ok) return Result.error(dirCheck.error);

  return resolved;
}
