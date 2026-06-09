/**
 * Helpers for the session-archive filter.
 *
 * pi writes its session JSONL files under ~/.pi/agent/sessions/<cwd-encoded>/,
 * one subdir per cwd, accumulating ALL cwds that ever ran pi on the machine:
 * every project the user touched, every eval tempdir, every L2 subagent
 * spawn. A naive archive that copies the whole tree into every .pi-mind/
 * produces an N-way redundant snapshot mixed with subprocess pollution.
 *
 * These helpers let archiveSession() filter the source tree down to the
 * subdirs that genuinely belong to the host repo whose .pi-mind/ is doing
 * the archiving.
 */

/**
 * Encode an absolute path the way pi names its session subdirectory.
 *
 *   /Users/x/Code/A   →  "--Users-x-Code-A"
 *
 * Leading "--" + slashes-as-dashes, leading "/" dropped. The trailing "--"
 * that real session-dir names carry belongs to the leaf component; we omit
 * it here so callers can do startsWith checks against deeper paths.
 */
export function encodeCwdPrefix(absPath: string): string {
  return "--" + absPath.replace(/^\//, "").replace(/\//g, "-");
}

/**
 * Decide whether a session subdir name (already encoded) belongs to this
 * .pi-mind's archive scope.
 *
 * Includes: hostPrefix exactly, or any descendant of hostPrefix.
 * Excludes: equal to or descending from excludePrefix (used to keep
 *           pi-mind's own L2 subagent sessions out of the archive).
 *
 * Suffix discipline ("+ '-'" / "+ '--'") prevents false positives where
 * /Users/x/Code/A would match /Users/x/Code/A2.
 */
export function isOwnSessionDir(
  subdirName: string,
  hostPrefix: string,
  excludePrefix: string,
): boolean {
  const matches = (name: string, prefix: string): boolean =>
    name === prefix + "--" || name.startsWith(prefix + "-");
  return matches(subdirName, hostPrefix) && !matches(subdirName, excludePrefix);
}
