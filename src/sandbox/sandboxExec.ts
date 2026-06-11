/**
 * macOS sandbox-exec (Seatbelt / SBPL) backend.
 *
 * Mirrors the bwrap model as a policy instead of a set of mounts:
 *   --ro-bind / /        -> (allow default) + (deny file-write*)
 *   --bind CWD CWD       -> (allow file-read* file-write* (subpath CWD))
 *   --bind ~/.claude ... -> (allow file-read* file-write* (subpath ...))   [rwPaths]
 *   --ro-bind EMPTY HIDE -> (deny file-read* file-write* (subpath HIDE))   [hidePaths/masks]
 *   --tmpfs $HOME        -> (deny file-read* (subpath $HOME)) + re-allows   [hideHome]
 *
 * Rules are emitted in last-match-wins order so later, more specific rules
 * override earlier broad ones — the declarative analogue of bwrap's mount stack.
 */
import { Result } from "typescript-result";
import { join } from "node:path";
import type { SandboxOptions, SandboxCommand } from "./types";

/**
 * Escape a path for safe interpolation inside an SBPL string literal.
 * SBPL string literals are double-quoted; backslash and double-quote are the
 * only characters that need escaping.
 */
export function sbplEscape(path: string): string {
  return path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Emit a `(subpath "…")` filter line, escaped. */
function subpath(path: string): string {
  return `(subpath "${sbplEscape(path)}")`;
}

/** Emit a `(literal "…")` filter line, escaped. */
function literal(path: string): string {
  return `(literal "${sbplEscape(path)}")`;
}

/**
 * Build the Seatbelt profile (SBPL) for the given options.
 */
export function buildSandboxProfile(opts: SandboxOptions): string {
  const lines: string[] = [];

  // 1. Read-only root: everything readable, nothing writable by default.
  lines.push("(version 1)");
  lines.push("(allow default)");
  lines.push("(deny file-write*)");

  // 2. Block privilege-escalation binaries regardless of mode.
  lines.push(
    '(deny process-exec (regex #"(/|^)(sudo|su|login|doas|pkexec)$"))'
  );

  // 3. hide-home: deny reads under $HOME to emulate an empty tmpfs $HOME.
  //    Writable rwPaths and cwd are re-allowed below (last-match-wins).
  if (opts.hideHome) {
    lines.push(`(deny file-read* ${subpath(opts.home)})`);
  }

  // 4. Writable paths: cwd + tool config (rwPaths). file/dir kind is irrelevant
  //    here — there are no mounts, so the atomic-write concern from bwrap is moot.
  const writable: string[] = [opts.cwd];
  for (const rp of opts.cliDef.rwPaths) {
    writable.push(join(opts.home, rp.path));
  }
  for (const p of writable) {
    lines.push(`(allow file-read* file-write* ${subpath(p)})`);
  }

  // 5. Hidden credential dirs.
  for (const hidePath of opts.hidePaths) {
    lines.push(`(deny file-read* file-write* ${subpath(hidePath)})`);
  }

  // 6. Masking overrides. Substitution overrides (those with a real source
  //    file) are rejected earlier by the backend; only masks reach here, so we
  //    deny the target regardless of `source`.
  for (const ov of [...opts.cwdOverrides, ...opts.projectOverrides]) {
    lines.push(`(deny file-read* file-write* ${subpath(ov.target)})`);
  }

  // 7. Keep the harness binary itself readable/executable even if it lives
  //    under a denied subtree (e.g. a hidden $HOME).
  lines.push(`(allow file-read* process-exec ${literal(opts.toolPath)})`);

  return lines.join("\n") + "\n";
}

/**
 * Build the full sandbox-exec command. The profile is passed inline via -p,
 * so it appears verbatim in --dry-run output and needs no temp file.
 */
export function buildSandboxExecCommand(
  opts: SandboxOptions
): Result<SandboxCommand, Error> {
  const profile = buildSandboxProfile(opts);
  return Result.ok({
    cmd: "sandbox-exec",
    args: ["-p", profile, "--", opts.toolPath, ...opts.toolArgs],
  });
}

/**
 * Execute sandbox-exec with the given command.
 * Returns the exit code of the sandboxed process.
 */
export async function executeSandboxExec(
  command: SandboxCommand
): Promise<Result<number, Error>> {
  try {
    const proc = Bun.spawn([command.cmd, ...command.args], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await proc.exited;
    return Result.ok(exitCode);
  } catch (err) {
    return Result.error(err instanceof Error ? err : new Error(String(err)));
  }
}
