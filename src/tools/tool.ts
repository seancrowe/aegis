/**
 * Shared tool utilities.
 */
import type { CliDef } from "../types";

/**
 * Remove duplicate occurrences of a flag from args array.
 * Returns a new array with the flag appearing exactly once at the front.
 */
export function dedupeFlag(args: string[], flag: string): string[] {
  const filtered = args.filter(a => a !== flag);
  return [flag, ...filtered];
}

/**
 * Normalize tool arguments by ensuring exactly one YOLO flag at the front.
 */
export function normalizeToolArgs(
  args: string[],
  cliDef: CliDef
): string[] {
  if (cliDef.yoloArg) {
    return dedupeFlag(args, cliDef.yoloArg);
  }
  return args;
}

/**
 * Filter out aegis-specific flags from args that should not be forwarded to the tool.
 */
export function filterAegisFlags(args: string[]): string[] {
  const result: string[] = [];
  let i = 0;
  while (i < args.length) {
    if (args[i] === "--hide-home" || args[i] === "--dry-run") {
      i++;
      continue;
    }
    if (args[i] === "--hide" || args[i] === "--writable" || args[i] === "-w") {
      i += 2; // skip flag + value
      continue;
    }
    if (args[i]!.startsWith("--hide=") || args[i]!.startsWith("--writable=")) {
      i++;
      continue;
    }
    result.push(args[i]!);
    i++;
  }
  return result;
}

/**
 * Get CLI definition by subCommand.
 */
export function getCliDef(subCommand: string, tools: CliDef[]): CliDef | undefined {
  return tools.find(c => c.subCommand === subCommand);
}
