/**
 * Tests for lib/session-archive.ts — cwd-encoding + own-session predicate
 * used by archiveSession() to filter ~/.pi/agent/sessions/ down to the
 * subdirs that genuinely belong to this .pi-mind's host repo.
 */
import { describe, expect, it } from 'vitest';

const { encodeCwdPrefix, isOwnSessionDir } = (await import(
  '../lib/session-archive.js'
)) as typeof import('../lib/session-archive.js');

describe('encodeCwdPrefix', () => {
  it('encodes a typical project path (no trailing --)', () => {
    expect(encodeCwdPrefix('/Users/x/Code/A')).toBe('--Users-x-Code-A');
  });

  it('encodes a deep path', () => {
    expect(encodeCwdPrefix('/Users/x/Code/A/src/foo')).toBe('--Users-x-Code-A-src-foo');
  });

  it('encodes a system temp dir', () => {
    expect(encodeCwdPrefix('/private/var/folders/lf/abc/T/pi-eval-XYZ')).toBe(
      '--private-var-folders-lf-abc-T-pi-eval-XYZ',
    );
  });
});

describe('isOwnSessionDir', () => {
  const hostPrefix = '--Users-x-Code-A';
  const excludePrefix = '--Users-x-Code-A-.pi-mind';

  it('matches the host root cwd exactly', () => {
    expect(isOwnSessionDir('--Users-x-Code-A--', hostPrefix, excludePrefix)).toBe(true);
  });

  it('matches a subdirectory of the host root', () => {
    expect(isOwnSessionDir('--Users-x-Code-A-src--', hostPrefix, excludePrefix)).toBe(true);
    expect(isOwnSessionDir('--Users-x-Code-A-src-foo--', hostPrefix, excludePrefix)).toBe(true);
  });

  it('rejects a sibling whose name shares the host prefix as a string', () => {
    // /Users/x/Code/A2 → --Users-x-Code-A2-- shares the leading text with
    // --Users-x-Code-A but is a different repo. The suffix-discipline must catch this.
    expect(isOwnSessionDir('--Users-x-Code-A2--', hostPrefix, excludePrefix)).toBe(false);
    expect(isOwnSessionDir('--Users-x-Code-Apple--', hostPrefix, excludePrefix)).toBe(false);
  });

  it('rejects an unrelated repo', () => {
    expect(isOwnSessionDir('--Users-x-Code-B--', hostPrefix, excludePrefix)).toBe(false);
  });

  it('rejects eval / judge tempdirs', () => {
    expect(
      isOwnSessionDir(
        '--private-var-folders-lf-abc-T-pi-eval-XYZ--',
        hostPrefix,
        excludePrefix,
      ),
    ).toBe(false);
    expect(
      isOwnSessionDir(
        '--private-var-folders-lf-abc-T-pi-judge-XYZ--',
        hostPrefix,
        excludePrefix,
      ),
    ).toBe(false);
  });

  it("excludes pi-mind's own L2 subagent cwd (descends from PI_MIND_DIR)", () => {
    expect(isOwnSessionDir('--Users-x-Code-A-.pi-mind--', hostPrefix, excludePrefix)).toBe(false);
    expect(isOwnSessionDir('--Users-x-Code-A-.pi-mind-knowledge--', hostPrefix, excludePrefix)).toBe(false);
  });

  it('includes other dotdirs that are not PI_MIND_DIR descendants', () => {
    // .pi-mind is excluded, but other dotfiles under the host repo still count.
    expect(isOwnSessionDir('--Users-x-Code-A-.git--', hostPrefix, excludePrefix)).toBe(true);
  });
});
