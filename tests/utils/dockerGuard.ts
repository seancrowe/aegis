import { existsSync } from "node:fs";

/**
 * Check if running inside a Docker container.
 * Checks for /.dockerenv file which Docker creates automatically.
 */
export function isRunningInDocker(): boolean {
  return existsSync("/.dockerenv");
}

/**
 * Throws an error if not running inside Docker.
 * Use at the top of L3/L4 test files as a safety guard.
 */
export function requireDocker(testLayer: string): void {
  if (!isRunningInDocker()) {
    throw new Error(
      `${testLayer} tests must run inside Docker. ` +
      `Use 'bun run scripts/test.ts' or run directly in Docker container.`
    );
  }
}
