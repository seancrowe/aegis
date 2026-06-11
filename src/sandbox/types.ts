/**
 * Backend-neutral sandbox types shared by the bwrap (Linux) and
 * sandbox-exec (macOS) backends.
 */
import type { CliDef } from "../types";
import type { ResolvedOverride } from "../config/overrides";

export interface SandboxOptions {
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
  /** Project overrides from .aegis.json, resolved against CWD. */
  projectOverrides: ResolvedOverride[];
}

export interface SandboxCommand {
  cmd: string;
  args: string[];
}
