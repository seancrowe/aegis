import { Result } from "typescript-result";
import { canonicalPathSpellings } from "../sandbox/masking";
import { isWithinDir } from "./projects";

/** First hide whose spelling (written or canonical) equals-or-contains `path`. */
export function findCoveringHide(
  hidePaths: string[],
  path: string
): string | undefined {
  const pathSpellings = canonicalPathSpellings(path);
  return hidePaths.find((hide) =>
    canonicalPathSpellings(hide).some((hideSpelling) =>
      pathSpellings.some((pathSpelling) =>
        isWithinDir(hideSpelling, pathSpelling)
      )
    )
  );
}

/** Error when any hide covers cwd or one of the tool's absolute rwPaths. */
export function checkHideConflicts(
  hidePaths: string[],
  cwd: string,
  rwPaths: { path: string; kind: "file" | "dir" }[],
  toolKey: string
): Result<void, Error> {
  const cwdHide = findCoveringHide(hidePaths, cwd);
  if (cwdHide !== undefined) {
    return Result.error(
      new Error(
        `aegis: hide path "${cwdHide}" covers the working directory "${cwd}"; ` +
          "the sandbox would start in an empty, unwritable directory. " +
          "Remove the hide or run from another directory."
      )
    );
  }

  for (const rwPath of rwPaths) {
    const hide = findCoveringHide(hidePaths, rwPath.path);
    if (hide !== undefined) {
      return Result.error(
        new Error(
          `aegis: hide path "${hide}" covers tool config path "${rwPath.path}" ` +
            `for "${toolKey}"; the tool could not read its own config. ` +
            "Hide a subpath instead."
        )
      );
    }
  }

  return Result.ok();
}

type GrantLabel = "extraWritable" | "allowRead";

/** Grants (extraWritable/allowRead) that lie inside a hide and therefore do nothing. */
export function findShadowedGrants(
  hidePaths: string[],
  grants: { label: GrantLabel; path: string }[]
): { label: GrantLabel; path: string; hide: string }[] {
  const shadowed: { label: GrantLabel; path: string; hide: string }[] = [];
  for (const grant of grants) {
    const hide = findCoveringHide(hidePaths, grant.path);
    if (hide !== undefined) shadowed.push({ ...grant, hide });
  }
  return shadowed;
}
