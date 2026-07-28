/**
 * macOS sandbox-exec (Seatbelt / SBPL) backend.
 *
 * Mirrors the bwrap model as a policy instead of a set of mounts:
 *   --ro-bind / /        -> (allow default) + (deny file-write*)
 *   --bind CWD CWD       -> (allow file-read* file-write* (subpath CWD))
 *   --bind ~/.claude ... -> (allow file-read* file-write* (subpath ...))   [rwPaths]
 *   --ro-bind EMPTY HIDE -> (deny file-read* file-write* (subpath HIDE))   [hidePaths/masks]
 *   masked $HOME         -> (deny file-read* file-write* ...) + re-allows   [hideHome]
 *   --tmpfs /tmp         -> (allow file-write* (subpath /tmp …))           [tmpPaths]
 *
 * Note the /tmp mapping is NOT isolation: bwrap mounts a private tmpfs, while
 * Seatbelt can only re-permit writes to the host's real temp dirs. The tool
 * shares the host /tmp and $TMPDIR (see README "macOS notes").
 *
 * Rules are emitted in last-match-wins order so later, more specific rules
 * override earlier broad ones — the declarative analogue of bwrap's mount stack.
 */
import { Result } from "typescript-result";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import type { SandboxOptions, SandboxCommand } from "./types";
import {
  canonicalPathSpellings,
  makeIsPathMasked,
} from "./masking";

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
 * Return both forms Seatbelt may need to deny for a user-written path.
 *
 * Like resolveTmpPaths() below, this accounts for Seatbelt comparing the
 * kernel-resolved path. Keeping the written form and adding its realpath is
 * intentionally additive for a deny: it can only hide more, never grant
 * access. Resolution is best-effort because a configured path may disappear
 * before the profile is built.
 */
function denyPaths(path: string): string[] {
  return canonicalPathSpellings(path);
}

/**
 * Write-only character devices that stay writable inside the sandbox. These
 * hold no user data; denying writes to them only breaks programs (most notably
 * /dev/null, which is touched by an enormous fraction of shell commands).
 * Pseudo-terminal masters/slaves are added separately (ptmx here, /dev/ttysNNN
 * via regex) so spawned subprocesses can allocate a tty.
 */
const DEVICE_LITERALS = [
  "/dev/null",
  "/dev/zero",
  "/dev/random",
  "/dev/urandom",
  "/dev/tty",
  "/dev/dtracehelper",
  "/dev/ptmx",
] as const;

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

  // 2b. Re-allow writes to the standard device nodes. The global deny above
  //     blocks ALL writes, but these are write-only "scratch" devices that a
  //     huge fraction of programs touch — redirecting to /dev/null, seeding
  //     from /dev/urandom, talking to the controlling terminal, allocating a
  //     pty for a spawned subprocess. Denying them produces spurious
  //     "operation not permitted" failures with no security benefit (they hold
  //     no user data). This is macOS-only: the bwrap backend gets a real /dev
  //     via `--dev /dev`. Block devices (raw disks like /dev/disk0) are
  //     deliberately NOT listed.
  for (const dev of DEVICE_LITERALS) {
    lines.push(`(allow file-write* ${literal(dev)})`);
  }
  // Per-fd nodes (/dev/fd/N) and dynamically-numbered pty slaves (/dev/ttysNNN).
  lines.push(`(allow file-write* (subpath "/dev/fd"))`);
  lines.push(`(allow file-write* (regex #"^/dev/ttys[0-9]+$"))`);

  // 3. A masked home is empty AND unwritable: reads are denied so the contents
  //    are invisible, and writes fail immediately rather than being accepted
  //    and discarded at exit (the Linux backend still does the latter — see the
  //    TODO in bwrap.ts). The write deny is stated here rather than left to the
  //    global (deny file-write*) above, so relaxing that global default cannot
  //    silently start letting writes through a masked home.
  //    cwd, rwPaths, extraWritable and tmpPaths are re-allowed below and win
  //    under last-match.
  //    INVARIANT: every spelling denied here must have its re-allows emitted at
  //    the same spelling (see section 4) — Seatbelt matches the kernel-resolved
  //    path, so a deny at the realpath with an allow only at the written form
  //    locks the tool out of its own config directory.
  const homeSpellings = denyPaths(opts.home);
  if (opts.hideHome) {
    for (const path of homeSpellings) {
      lines.push(`(deny file-read* file-write* ${subpath(path)})`);
    }
    // 3a. When $HOME is itself reached through a symlink, the deny above covers
    //     the link NODE, so the kernel cannot even readlink() it and every path
    //     beneath resolves to ENOTDIR — including the rwPath allows emitted in
    //     section 4, which are then never reached. Re-allow metadata on the
    //     link itself (not its contents) so traversal can proceed, mirroring
    //     the exec-chain carve-out at the end of this function. Reading a
    //     symlink discloses only its target, never the masked directory.
    //     denyPaths returns [written, canonical] and collapses to a single
    //     entry when they match, so a second entry is exactly the signal that
    //     the written spelling is a link.
    if (homeSpellings.length > 1) {
      lines.push(`(allow file-read-metadata ${literal(homeSpellings[0]!)})`);
    }
  }

  // 3b. Read-only carve-outs follow the broad home deny but precede every
  // explicit hide/override deny, preserving least privilege under Seatbelt's
  // last-match-wins evaluation. Emitting these even without hideHome keeps
  // --hide-home and config allowlist behavior on the same policy path.
  for (const p of opts.allowRead) {
    lines.push(`(allow file-read* ${subpath(p)})`);
  }

  // 4. Writable paths: cwd + tool config (rwPaths). file/dir kind is irrelevant
  //    here — there are no mounts, so the atomic-write concern from bwrap is moot.
  //
  //    rwPaths are emitted at EVERY spelling `homeSpellings` denies, reusing
  //    that exact array so the deny loop above and this allow loop cannot drift
  //    apart. Anything less and a symlinked $HOME (/var -> /private/var) denies
  //    at the resolved path while allowing only at the written one.
  //
  //    opts.cwd needs no such treatment: it comes from process.cwd(), which the
  //    kernel already returns fully resolved.
  //
  //    Deliberately NOT extended to allowRead / extraWritable. Tilde-spelled
  //    entries there are home-derived too (expandUserPaths joins them against
  //    the un-realpathed $HOME) and hit the identical mismatch — this exclusion
  //    is a choice, not an oversight. Unlike rwPaths, which aegis derives from
  //    the tool catalog, the user wrote those spellings, and the README's
  //    documented policy is that aegis does not silently rewrite user-written
  //    paths: configure the real path instead.
  const writable: string[] = [opts.cwd];
  for (const rp of opts.cliDef.rwPaths) {
    for (const h of homeSpellings) writable.push(join(h, rp.path));
  }
  for (const p of writable) {
    lines.push(`(allow file-read* file-write* ${subpath(p)})`);
  }

  // 4a. Extra opt-in writable dirs (config.extraWritable). Emitted before
  //     hidePaths/overrides so an explicit `--hide` of the same path still wins
  //     under last-match. No existence check: a subpath rule matches a cache
  //     dir the tool creates on first use.
  for (const p of opts.extraWritable) {
    lines.push(`(allow file-read* file-write* ${subpath(p)})`);
  }

  // 4b. Keep temp dirs writable. Reads are already permitted by (allow
  //     default); this re-allows the writes that the global (deny file-write*)
  //     would otherwise block, giving the tool a working /tmp and $TMPDIR.
  //     Emitted before hidePaths so an explicit `--hide /tmp` can still win.
  for (const tp of opts.tmpPaths) {
    lines.push(`(allow file-write* ${subpath(tp)})`);
  }

  // 5. Hidden credential dirs.
  for (const hidePath of opts.hidePaths) {
    for (const path of denyPaths(hidePath)) {
      lines.push(`(deny file-read* file-write* ${subpath(path)})`);
    }
  }

  // 6. Masking overrides. Substitution overrides (those with a real source
  //    file) are rejected earlier by the backend; only masks reach here, so we
  //    deny the target regardless of `source`.
  for (const ov of [...opts.cwdOverrides, ...opts.projectOverrides]) {
    for (const path of denyPaths(ov.target)) {
      lines.push(`(deny file-read* file-write* ${subpath(path)})`);
    }
  }

  // 7. Keep the harness binary itself readable/executable even if it lives
  //    under a denied subtree (e.g. a hidden $HOME).
  lines.push(`(allow file-read* process-exec ${literal(opts.toolPath)})`);

  // 7b. Seatbelt resolves the whole path at exec time, so a tool reached
  //     through symlinks needs each hop allowed — permitting only the
  //     launcher leaves the file behind it denied. Restricted to hops that
  //     actually fall inside a masked region: everything else is already
  //     readable under (allow default), and emitting redundant allow rules
  //     only widens the profile for no benefit.
  const isMasked = makeIsPathMasked(opts);

  for (const entry of opts.toolChain) {
    if (entry.path === opts.toolPath || !isMasked(entry.path)) continue;
    lines.push(`(allow file-read* process-exec ${literal(entry.path)})`);
  }

  return lines.join("\n") + "\n";
}

/**
 * Resolve the host temp directories that stay writable inside the sandbox:
 * the system /tmp and the per-user $TMPDIR. Paths are canonicalized via
 * realpath so the SBPL subpath rules match the kernel's resolved paths
 * (/tmp -> /private/tmp, $TMPDIR -> /private/var/folders/...). The literal
 * "/tmp" is always included so the rule reads sensibly even if realpath fails.
 */
export function resolveTmpPaths(): string[] {
  const paths = new Set<string>(["/tmp"]);
  const add = (p: string): void => {
    try {
      paths.add(realpathSync(p));
    } catch {
      // Path may not exist on this host; skip it.
    }
  };
  add("/tmp");
  add(tmpdir());
  return [...paths];
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
      env: { ...process.env, AEGIS_SANDBOX: "1" },
    });
    const exitCode = await proc.exited;
    return Result.ok(exitCode);
  } catch (err) {
    return Result.error(err instanceof Error ? err : new Error(String(err)));
  }
}
