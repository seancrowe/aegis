/**
 * Backend-neutral sandbox types shared by the bwrap (Linux) and
 * sandbox-exec (macOS) backends.
 */
import type { CliDef } from "../types";
import type { ResolvedOverride } from "../config/overrides";
import type { ExecChainEntry } from "../fs/paths";

export interface SandboxOptions {
  /** Current working directory */
  cwd: string;
  /** Home directory */
  home: string;
  /** CLI definition */
  cliDef: CliDef;
  /** Absolute path to the tool executable */
  toolPath: string;
  /**
   * Every hop involved in resolving `toolPath` — the symlinks and the regular
   * file behind them. Both backends carve these out of masked regions so the
   * tool can still be exec'd when it is installed under a hidden $HOME.
   * Pass [] to skip the carve-out.
   */
  toolChain: ExecChainEntry[];
  /** Arguments to pass to the tool */
  toolArgs: string[];
  /** Whether to use hide-home mode */
  hideHome: boolean;
  /** Directories to hide (absolute paths) */
  hidePaths: string[];
  /**
   * Extra paths to keep readable under a masked home (absolute, ~-expanded).
   * These never grant write access. Pass [] when unused.
   */
  allowRead: string[];
  /**
   * Extra directories to keep writable beyond cwd and tool config (absolute,
   * ~-expanded). From config.extraWritable. macOS emits an allow rule for each
   * (matches even if the path doesn't exist yet); bwrap RW-binds the ones that
   * exist. Pass [] when unused.
   */
  extraWritable: string[];
  /**
   * Empty directory for overlay mounts. Used only by the bwrap backend;
   * the sandbox-exec backend ignores it (masking is expressed as deny rules).
   * Pass "" when unused.
   */
  emptyDir: string;
  /**
   * Top-level entries in $HOME (basenames). Used only by the bwrap backend
   * for RO re-binds in non-hideHome mode. Pass [] when unused.
   */
  homeEntries: string[];
  /** CWD overrides from global config, resolved against CWD. */
  cwdOverrides: ResolvedOverride[];
  /** Project overrides from .aegis.toml, resolved against CWD. */
  projectOverrides: ResolvedOverride[];
  /**
   * Absolute temp dirs to keep writable (sandbox-exec backend only): the host
   * /tmp and per-user $TMPDIR, canonicalized. bubblewrap mounts a private
   * tmpfs at /tmp instead and ignores this. Pass [] when unused.
   */
  tmpPaths: string[];
}

export interface SandboxCommand {
  cmd: string;
  args: string[];
}
