/**
 * Path resolution and validation utilities.
 */
import { resolve, normalize, isAbsolute, dirname, join } from "node:path";
import { existsSync, statSync, lstatSync, readlinkSync } from "node:fs";
import { Result } from "typescript-result";

/**
 * One step in the resolution of an executable path: either a symlink that has
 * to be recreated inside the sandbox, or the regular file at the end.
 */
export type ExecChainEntry =
  | { kind: "symlink"; path: string; target: string }
  | { kind: "file"; path: string };

/**
 * Walk every hop involved in resolving `input`, the way the kernel does:
 * component by component, restarting whenever a component turns out to be a
 * symlink. Returns each symlink encountered (with its raw, possibly relative
 * target) followed by the regular file it ultimately points at.
 *
 * This exists because masking $HOME does not merely deny access to these
 * paths — bubblewrap's tmpfs removes them from the mount namespace, so exec
 * fails with ENOENT unless each hop is put back. Two real layouts motivate
 * walking components rather than calling realpath:
 *
 *   ~/.local/bin/claude -> ~/.local/share/claude/versions/<v>
 *   ~/.local/bin/codex  -> ~/.codex/packages/standalone/current/bin/codex
 *                       -> ~/.codex/packages/standalone/releases/<v>/bin/codex
 *
 * The second chains through `current`, a symlinked *directory component* in
 * the middle of the path. lstat() on the full path never reports it, and
 * realpath() collapses it away — but inside the sandbox it still has to exist
 * for the path to resolve.
 *
 * Returns whatever was resolved before hitting a missing or unreadable
 * component, so a partially-installed tool degrades to a partial carve-out
 * rather than throwing.
 */
export function resolveExecChain(
  input: string,
  maxSteps: number = 64
): ExecChainEntry[] {
  const entries: ExecChainEntry[] = [];
  const seen = new Set<string>();
  let path = normalize(resolve(input));

  for (let step = 0; step < maxSteps; step++) {
    const parts = path.split("/").filter(Boolean);
    let prefix = "";
    let redirected = false;

    for (let i = 0; i < parts.length; i++) {
      prefix += "/" + parts[i];

      let target: string | undefined;
      try {
        if (lstatSync(prefix).isSymbolicLink()) {
          target = readlinkSync(prefix);
        }
      } catch {
        // Missing or unreadable component — return what resolved so far.
        return entries;
      }
      if (target === undefined) continue;

      // A repeated symlink means a cycle; stop rather than spin to maxSteps.
      if (seen.has(prefix)) return entries;
      seen.add(prefix);
      entries.push({ kind: "symlink", path: prefix, target });

      const resolved = isAbsolute(target)
        ? normalize(target)
        : normalize(join(dirname(prefix), target));
      path = normalize(join(resolved, ...parts.slice(i + 1)));
      redirected = true;
      break;
    }

    if (!redirected) {
      entries.push({ kind: "file", path });
      return entries;
    }
  }

  return entries;
}

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
