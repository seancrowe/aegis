import { existsSync } from "node:fs";
import type { ProjectBlock } from "./config";
import { expandUserPath } from "./policyPath";
import { canonicalPathSpellings } from "../sandbox/masking";

/** Expand a project key and remove trailing slashes without collapsing root. */
export function normalizeProjectDir(key: string, home: string): string {
  return expandUserPath(key, home).replace(/\/+$/, "") || "/";
}

/** Whether path is dir itself or is beneath dir at a component boundary. */
export function isWithinDir(dir: string, path: string): boolean {
  return path === dir || path.startsWith(dir === "/" ? "/" : `${dir}/`);
}

export interface ProjectMatch {
  block: ProjectBlock;
  /** The spelling (expanded or realpath) that matched cwd — for diagnostics. */
  dir: string;
}

export interface ProjectMatchResult {
  /** Applicable blocks, outermost first; ties keep declaration order. */
  matched: ProjectMatch[];
  /** Blocks whose directory does not exist on disk (they can never match). */
  missing: ProjectBlock[];
}

export function matchProjectBlocks(
  blocks: ProjectBlock[],
  cwd: string,
  home: string
): ProjectMatchResult {
  const cwdSpellings = canonicalPathSpellings(cwd);
  const matched: ProjectMatch[] = [];
  const missing: ProjectBlock[] = [];

  for (const block of blocks) {
    const normalizedDir = normalizeProjectDir(block.key, home);
    if (!existsSync(normalizedDir)) missing.push(block);

    const dirSpellings = canonicalPathSpellings(normalizedDir);
    const dir = dirSpellings.find((dirSpelling) =>
      cwdSpellings.some((cwdSpelling) => isWithinDir(dirSpelling, cwdSpelling))
    );
    if (dir !== undefined) matched.push({ block, dir });
  }

  matched.sort((a, b) => a.dir.length - b.dir.length);
  return { matched, missing };
}
