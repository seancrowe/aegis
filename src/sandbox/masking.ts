import { realpathSync } from "node:fs";

/** Return the written path plus its canonical spelling when it exists. */
export function canonicalPathSpellings(path: string): string[] {
  const paths = new Set<string>([path]);
  try {
    paths.add(realpathSync(path));
  } catch {
    // Policy paths may be absent by the time a command is assembled.
  }
  return [...paths];
}

interface MaskPolicy {
  hideHome: boolean;
  home: string;
  hidePaths: string[];
}

/**
 * Build the shared exec-chain mask predicate used by both sandbox backends.
 * Exec-chain entries are resolved paths, so masks must include their canonical
 * spellings or a symlinked mask can fail to recognize the executable behind it.
 */
export function makeIsPathMasked(policy: MaskPolicy): (path: string) => boolean {
  const masks = new Set<string>();
  if (policy.hideHome) {
    for (const path of canonicalPathSpellings(policy.home)) masks.add(path);
  }
  for (const hidePath of policy.hidePaths) {
    for (const path of canonicalPathSpellings(hidePath)) masks.add(path);
  }
  const maskList = [...masks];
  return (path: string): boolean =>
    maskList.some((mask) => path === mask || path.startsWith(mask + "/"));
}
