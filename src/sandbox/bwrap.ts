/**
 * Bubblewrap sandbox argument builder and executor.
 */
import { Result } from "typescript-result";
import { mkdtemp } from "node:fs/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { CliDef } from "../types";

export interface BwrapOptions {
  /** Current working directory */
  cwd: string;
  /** Home directory */
  home: string;
  /** CLI definition */
  cliDef: CliDef;
  /** Absolute path to the tool executable */
  toolPath: string;
  /** Arguments to pass to the tool */
  toolArgs: string[];
  /** Whether to use hide-home mode */
  hideHome: boolean;
  /** Directories to hide (absolute paths) */
  hidePaths: string[];
  /** Empty directory for overlay mounts */
  emptyDir: string;
}

export interface BwrapCommand {
  cmd: string;
  args: string[];
}

/**
 * Build the bwrap argument list for the given options.
 */
export function buildBwrapArgs(opts: BwrapOptions): Result<string[], Error> {
  const args: string[] = [];

  // 1. Base sandbox flags
  args.push("--die-with-parent");
  args.push("--unshare-pid");
  args.push("--unshare-ipc");
  args.push("--unshare-uts");
  args.push("--ro-bind", "/", "/");
  args.push("--dev", "/dev");
  args.push("--proc", "/proc");

  // 2. Hide-home: tmpfs over $HOME, then create mountpoints (before --tmpfs /tmp)
  if (opts.hideHome) {
    args.push("--tmpfs", opts.home);
    for (const rp of opts.cliDef.rwPaths) {
      const fullPath = join(opts.home, rp.path);
      if (rp.kind === "dir") {
        args.push("--dir", fullPath);
      } else {
        args.push("--ro-bind", "/dev/null", fullPath);
      }
    }
  }

  args.push("--tmpfs", "/tmp");

  // 3. RW binds — cwd + tool config paths
  args.push("--bind", opts.cwd, opts.cwd);
  for (const rp of opts.cliDef.rwPaths) {
    const fullPath = join(opts.home, rp.path);
    args.push("--bind", fullPath, fullPath);
  }

  // 4. chdir
  args.push("--chdir", opts.cwd);

  // 5. Hide overlays — MUST come after all --bind ops
  for (const hidePath of opts.hidePaths) {
    args.push("--ro-bind", opts.emptyDir, hidePath);
  }

  // 6. Tool execution
  args.push("--", opts.toolPath, ...opts.toolArgs);

  return Result.ok(args);
}

/**
 * Build the full bwrap command (cmd + args) for dry-run output.
 */
export function buildBwrapCommand(
  opts: BwrapOptions
): Result<BwrapCommand, Error> {
  const argsResult = buildBwrapArgs(opts);
  if (!argsResult.ok) return Result.error(argsResult.error);
  return Result.ok({ cmd: "bwrap", args: argsResult.value });
}

/**
 * Execute bwrap with the given command.
 * Returns the exit code of the sandboxed process.
 */
export async function executeBwrap(
  command: BwrapCommand
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
