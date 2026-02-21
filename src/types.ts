/**
 * Shared types for aegis.
 */

export interface RwPath {
  kind: "file" | "dir";
  /** Path relative to $HOME */
  path: string;
}

export interface CliDef {
  /** Human-readable display name */
  name: string;
  /** Actual binary on PATH */
  cliCmd: string;
  /** aegis subcommand (what you type) */
  subCommand: string;
  /** Auto-injected YOLO flag */
  yoloArg?: string;
  /** Paths to mount read-write relative to $HOME */
  rwPaths: RwPath[];
}
