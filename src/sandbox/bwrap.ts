/**
 * Bubblewrap sandbox argument builder and executor.
 */
import { Result } from "typescript-result";
import { mkdtemp } from "node:fs/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { SandboxOptions, SandboxCommand } from "./types";
import { makeIsPathMasked } from "./masking";

/** @deprecated use SandboxOptions from ./types */
export type BwrapOptions = SandboxOptions;
/** @deprecated use SandboxCommand from ./types */
export type BwrapCommand = SandboxCommand;

/**
 * Build the bwrap argument list for the given options.
 */
export function buildBwrapArgs(opts: SandboxOptions): Result<string[], Error> {
  const args: string[] = [];

  // 1. Base sandbox flags
  args.push("--die-with-parent");
  args.push("--unshare-pid");
  args.push("--unshare-ipc");
  args.push("--unshare-uts");
  args.push("--ro-bind", "/", "/");
  args.push("--dev", "/dev");
  args.push("--proc", "/proc");

  // 2. Home directory mounts
  // TODO: Linux diverges from macOS here: writes into a masked $HOME succeed
  // and are silently discarded at exit, the silent-loss shape aegis otherwise
  // avoids. Converging on macOS's fail-loudly semantics is not a one-line
  // change: bwrap creates mountpoints inside the masked home with --dir and
  // --ro-bind /dev/null for the tool's rwPaths, and --dir cannot create inside
  // a read-only mount. This needs either an empty host directory with the
  // mountpoints pre-created and --ro-bind'ed over $HOME, or the tmpfs remounted
  // read-only after setup.
  if (opts.hideHome) {
    // Hide-home: tmpfs over $HOME, then create the tool's own mountpoints
    // inside it. The mountpoint creation is what the TODO above is about.
    args.push("--tmpfs", opts.home);
    for (const rp of opts.cliDef.rwPaths) {
      const fullPath = join(opts.home, rp.path);
      if (rp.kind === "dir") {
        args.push("--dir", fullPath);
      } else {
        args.push("--ro-bind", "/dev/null", fullPath);
      }
    }
    // A bind source must exist or bwrap aborts before launching the tool.
    // Keep missing config entries lenient, matching extraWritable below; unlike
    // Seatbelt, a mount cannot describe a path that may appear later.
    for (const p of opts.allowRead) {
      if (existsSync(p)) {
        args.push("--ro-bind", p, p);
      }
    }
  } else {
    // Non-hideHome: bind $HOME as RW, selectively protect entries as RO.
    // File rwPaths (direct children) are NOT overlaid — they stay writable
    // as part of the $HOME bind, enabling atomic writes (temp+rename).
    // allowRead needs no mount in this branch because home is already readable;
    // adding a RO overlay could unexpectedly revoke a separate write grant.
    args.push("--bind", opts.home, opts.home);

    const fileRwBasenames = new Set(
      opts.cliDef.rwPaths
        .filter(rp => rp.kind === "file" && !rp.path.includes("/"))
        .map(rp => rp.path)
    );

    for (const entry of opts.homeEntries) {
      if (!fileRwBasenames.has(entry)) {
        const fullPath = join(opts.home, entry);
        args.push("--ro-bind", fullPath, fullPath);
      }
    }
  }

  args.push("--tmpfs", "/tmp");

  // 3. RW binds — cwd + tool config paths
  args.push("--bind", opts.cwd, opts.cwd);
  for (const rp of opts.cliDef.rwPaths) {
    // In non-hideHome mode, direct-child file rwPaths are already writable
    // from --bind $HOME; binding them individually would create mount points
    // that break atomic writes (temp+rename).
    if (!opts.hideHome && rp.kind === "file" && !rp.path.includes("/")) {
      continue;
    }
    const fullPath = join(opts.home, rp.path);
    args.push("--bind", fullPath, fullPath);
  }

  // 3b. Extra opt-in writable dirs (config.extraWritable). Bind only paths that
  //     already exist — bwrap errors on a missing bind source. A non-existent
  //     entry is silently skipped (config leniency); create the dir first if a
  //     tool needs to populate it. Must precede the hide overlays in section 5.
  for (const p of opts.extraWritable) {
    if (existsSync(p)) {
      args.push("--bind", p, p);
    }
  }

  // 4. chdir
  args.push("--chdir", opts.cwd);

  // 5. Hide overlays — MUST come after all --bind ops
  for (const hidePath of opts.hidePaths) {
    args.push("--ro-bind", opts.emptyDir, hidePath);
  }

  // 5b. CWD overrides (global config, resolved against CWD)
  for (const ov of opts.cwdOverrides) {
    args.push("--ro-bind", ov.source, ov.target);
  }

  // 5c. Project overrides (.aegis.toml — highest precedence)
  for (const ov of opts.projectOverrides) {
    args.push("--ro-bind", ov.source, ov.target);
  }

  // 5d. Tool binary carve-out — MUST come after the tmpfs and the hide
  //     overlays so the tool stays executable even when it lives inside a
  //     masked region. Real installers put both the launcher and its target
  //     under $HOME, and a tmpfs does not hide those paths so much as delete
  //     them, so exec dies with ENOENT unless each hop is restored.
  //
  //     Symlinks are recreated as symlinks (rather than binding the resolved
  //     file onto the launcher path) so a tool that inspects its own realpath
  //     to find adjacent resources still sees the layout it was installed
  //     with. Paths outside every masked region are skipped — those are
  //     already visible through the read-only root bind.
  const isMasked = makeIsPathMasked(opts);

  for (const entry of opts.toolChain) {
    if (!isMasked(entry.path)) continue;
    if (entry.kind === "symlink") {
      args.push("--symlink", entry.target, entry.path);
    } else {
      args.push("--ro-bind", entry.path, entry.path);
    }
  }

  // 6. Tool execution
  args.push("--", opts.toolPath, ...opts.toolArgs);

  return Result.ok(args);
}

/**
 * Build the full bwrap command (cmd + args) for dry-run output.
 */
export function buildBwrapCommand(
  opts: SandboxOptions
): Result<SandboxCommand, Error> {
  const argsResult = buildBwrapArgs(opts);
  if (!argsResult.ok) return Result.error(argsResult.error);
  return Result.ok({ cmd: "bwrap", args: argsResult.value });
}

/**
 * Execute bwrap with the given command.
 * Returns the exit code of the sandboxed process.
 */
export async function executeBwrap(
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

/** Prefix used for all overlay temp directories. */
export const OVERLAY_PREFIX = "aegis-overlay-";

/**
 * Create an empty temporary directory for overlay mounts.
 */
export async function createEmptyOverlayDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), OVERLAY_PREFIX));
}

/**
 * Remove a single overlay directory (synchronous, safe for process.on('exit')).
 */
export function removeOverlayDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort: ignore errors during cleanup
  }
}

/**
 * Remove all stale aegis-overlay-* directories from the system temp directory.
 * Call at startup to clean up leftovers from crashed or killed processes.
 */
export function cleanStaleOverlays(): void {
  const tmp = tmpdir();
  try {
    for (const entry of readdirSync(tmp)) {
      if (entry.startsWith(OVERLAY_PREFIX)) {
        rmSync(join(tmp, entry), { recursive: true, force: true });
      }
    }
  } catch {
    // Best-effort: /tmp may have permission-denied entries; ignore
  }
}

/**
 * Ensure host paths exist for bind mounts.
 * Creates directories and touches files as needed.
 */
export async function ensureHostPathsExist(
  paths: Array<{ path: string; kind: "file" | "dir" }>
): Promise<Result<void, Error>> {
  try {
    for (const { path: p, kind } of paths) {
      if (kind === "dir") {
        await mkdir(p, { recursive: true });
      } else {
        await mkdir(dirname(p), { recursive: true });
        if (!existsSync(p)) {
          await writeFile(p, "", "utf-8");
        }
      }
    }
    return Result.ok();
  } catch (err) {
    return Result.error(err instanceof Error ? err : new Error(String(err)));
  }
}
