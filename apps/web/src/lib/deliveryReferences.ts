/**
 * Reference files of a profile: full paths on the engine's host. A file is
 * picked from a project or a browsed folder, both of which give a root and a
 * '/'-joined relative path, so the full path is joined here and checked
 * against the references already kept.
 */
import {
  isWindowsAbsolutePath,
  normalizeProjectPathForComparison,
  normalizeProjectPathForDispatch,
} from "@t3tools/shared/path";

/**
 * The full path of `relativePath` under `root`. A Windows root (drive letter
 * or UNC) is written with backslashes throughout, so a project at `C:/work`
 * gives `C:\work\docs\a.md`, never `C:/work\docs\a.md`. Case is kept as given.
 */
export function joinReferencePath(root: string, relativePath: string): string {
  const windows = isWindowsAbsolutePath(root);
  const separator = windows ? "\\" : "/";
  const styled = (value: string) => (windows ? value.replaceAll("/", "\\") : value);
  const base = styled(normalizeProjectPathForDispatch(root));
  // On Windows neither separator can begin a file name, so both are stripped;
  // on POSIX a backslash is a regular character and only '/' is stripped.
  const file = windows
    ? styled(relativePath).replace(/^[\\/]+/, "")
    : relativePath.replace(/^\/+/, "");
  return base.endsWith(separator) ? `${base}${file}` : `${base}${separator}${file}`;
}

/**
 * The references with `path` added, unless the same file is already there in
 * another spelling (separators, or drive and folder case on Windows); then the
 * existing entry is kept as it is stored and the same list is returned.
 */
export function addReference(
  references: ReadonlyArray<string>,
  path: string,
): ReadonlyArray<string> {
  const identity = normalizeProjectPathForComparison(path);
  return references.some((item) => normalizeProjectPathForComparison(item) === identity)
    ? references
    : [...references, path];
}
