/**
 * Sandbox backend selection. Picks the bwrap (Linux) or sandbox-exec (macOS)
 * implementation by platform; both consume the same SandboxOptions.
 */
import { Result } from "typescript-result";
import type { SandboxOptions, SandboxCommand } from "./types";
import { buildBwrapCommand, executeBwrap } from "./bwrap";
import { buildSandboxExecCommand, executeSandboxExec } from "./sandboxExec";

export interface SandboxBackend {
  /** Underlying executable name. */
  readonly bin: string;
  /** Whether the backend needs an empty overlay dir for masking. */
  readonly needsEmptyDir: boolean;
  /** Whether the backend needs the list of $HOME entries (for RO re-binds). */
  readonly needsHomeEntries: boolean;
  /** Whether the backend can substitute file contents via overrides. */
  readonly supportsContentOverride: boolean;
  buildCommand(opts: SandboxOptions): Result<SandboxCommand, Error>;
  execute(cmd: SandboxCommand): Promise<Result<number, Error>>;
}

const bwrapBackend: SandboxBackend = {
  bin: "bwrap",
  needsEmptyDir: true,
  needsHomeEntries: true,
  supportsContentOverride: true,
  buildCommand: buildBwrapCommand,
  execute: executeBwrap,
};

const sandboxExecBackend: SandboxBackend = {
  bin: "sandbox-exec",
  needsEmptyDir: false,
  needsHomeEntries: false,
  supportsContentOverride: false,
  buildCommand: buildSandboxExecCommand,
  execute: executeSandboxExec,
};

/**
 * Select the sandbox backend for the current platform.
 */
export function selectBackend(
  platform: NodeJS.Platform = process.platform
): Result<SandboxBackend, Error> {
  if (platform === "linux") return Result.ok(bwrapBackend);
  if (platform === "darwin") return Result.ok(sandboxExecBackend);
  return Result.error(
    new Error(
      `aegis: unsupported platform "${platform}" (supported: linux, darwin)`
    )
  );
}
