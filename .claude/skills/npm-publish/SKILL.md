---
name: npm-publish
description: Publish a package from this monorepo to npm under the @shog-lab scope. Captures the version-bump conventions, the token-failure modes, and the 2FA workaround so repeat publishes don't re-discover them.
---

# npm-publish

Publish a single package from `packages/<name>/` to the npm registry under the `@shog-lab` scope. This monorepo has no CI publish; every release is manual.

## Conventions (this repo)

- Root `package.json` is `private: true`. Only individual workspace packages publish.
- Currently publishable: `@shog-lab/pi-utils` / `pi-mind-core` / `pi-toolkit` / `pi-ralph`. `eval` is private.
- Internal deps use `"@shog-lab/pi-utils": "*"`; npm rewrites these on publish.
- `prepare` script auto-runs `npm run build` before publish.
- Version commit message format (see git log): `chore(<pkg>): bump x.y.z → x.y.(z+1)` for patch, with a richer body if breaking.
- Do NOT use `npm version` — manual edit + handcrafted commit body is the convention.
- Publish straight to `main`. No release branches, no PRs.

## Pre-flight

1. Confirm working tree clean (or only the version bump pending).
2. `npm run typecheck --workspace=packages/<pkg>` and `npm run test --workspace=packages/<pkg>` must be green.
3. **End-to-end probe.** REQUIRED, not optional. Write a `.tmp-verify-<feature>.mjs` that imports the actual built code from `packages/<pkg>/dist/...` and runs the critical functional paths — happy path AND expected-failure paths (e.g. "invalid input rejected"). Unit tests alone are insufficient: vitest injects shims (notably a working `require`) that mask ESM-only failures. Concrete incident: 2026-05-21 v0.5.0 skill-evolution shipped a symlink-guard that used `require("node:fs")` inside try/catch; unit tests passed, real Node ESM threw and silently fell through. The end-to-end probe caught it. Without the probe, the bug would have shipped.
4. `npm whoami` — if it errors **E401**, the token in `~/.npmrc` is dead (see "Token failure" below).

## Pick the version (semver)

- **Patch** (`0.1.1 → 0.1.2`): pure bugfix or doc-only, no API surface change.
- **Minor** (`0.1.1 → 0.2.0`): new feature OR breaking change while under 1.0. (pre-1.0 packages routinely break on minor — that's fine and expected.)
- **Major** (`0.x → 1.0.0`): only when we mean to declare API stability. Not used in this repo yet.

When in doubt about minor vs patch: if any saveMemory-style signature changed, or any exported function was renamed/removed, it's minor.

## Steps

1. **Edit `packages/<pkg>/package.json`** — bump `"version"` by hand. No tool, no `npm version`.
2. **Stage + commit**:
   ```bash
   git add packages/<pkg>/package.json
   git commit -m "chore(<pkg>): bump <old> → <new>

   <one-paragraph 'why' if minor/major>
   "
   ```
3. **Dry-run** to inspect tarball contents:
   ```bash
   cd packages/<pkg>
   npm publish --dry-run --access public
   ```
   Look at the file list (should include `dist/**`, `skills/**`, `bin/**/*.js`, `README.md`, `system-prompt.md`, `LICENSE` per the package's `files` field). A "you cannot publish over 0.x.y" error here just means version is correct (you can't dry-run a version that already exists).
4. **Publish**:
   ```bash
   npm publish --access public
   ```
   `--access public` is required for `@scoped` packages on free accounts.
5. **Verify** (read-only, no auth needed):
   ```bash
   npm view @shog-lab/<pkg> version
   ```
   should show the new version.
6. **Push the bump commit**:
   ```bash
   git push origin main
   ```

## Token failure (E401 on whoami)

The token in `~/.npmrc` doesn't physically disappear, but it can become invalid for several reasons:

- **Expired** — npm tokens are now time-limited by default (90 / 365 days).
- **Account password changed** — invalidates all tokens.
- **Manually revoked** in the web UI or by security automation.
- **npm internal rotation** — older legacy tokens get force-expired periodically.

There is no "recover" path. Generate a new token:

1. Log in at https://www.npmjs.com.
2. Profile menu → "Access Tokens" → "Generate New Token" → "Granular Access Token".
3. Settings:
   - **Permissions: Read and write** (publish needs write).
   - **Packages: Specific packages** → add `@shog-lab/pi-mind-core` (and any other shog-lab packages you publish often).
   - **Organizations: Do NOT check `shoglab`** — that's a different/unrelated org, not the `shog-lab` user scope. Leaving it unchecked is correct.
   - **Expiration: 365 days** (npm doesn't allow "never").
   - **Bypass 2FA: check it if present.** ⚠️ As of 2026-05-20 the option may be missing from the UI or fail to take effect even when checked — see next section.
4. Copy the token (only shown once).
5. Write into `~/.npmrc` (overwriting the dead one):
   ```bash
   echo "//registry.npmjs.org/:_authToken=<new-token>" > ~/.npmrc
   ```
6. Verify: `npm whoami` should print `shog-lab`.

## 2FA still required even with a granular token

Symptom on `npm publish`:
```
403 Forbidden ... Two-factor authentication or granular access token with bypass 2fa enabled is required
```

This happens when either (a) the token wasn't created with "Bypass 2FA", or (b) you did check the box but npm's UI is currently buggy and didn't honor it (observed 2026-05-20).

Three workarounds, in order of preference:

1. **Generate a fresh token, definitely with Bypass 2FA enabled**, replace in `~/.npmrc`, retry. Look extra carefully at the checkbox; it may be labeled slightly differently (e.g. "Allow publishing without 2FA prompt").
2. **One-shot OTP** for this publish:
   ```bash
   npm publish --access public --otp=<6-digit-code>
   ```
   Code is your authenticator app's current value; you have ~30 seconds before it rotates.
3. **Last resort: temporarily disable account-level 2FA**, publish, re-enable. Don't do this casually.

## Post-publish hygiene

If the token was ever pasted into a chat / screenshot / shared anywhere unsafe:

1. https://www.npmjs.com/settings/<user>/tokens
2. Revoke the leaked token.
3. Generate a replacement.
4. Update `~/.npmrc` again.

The leaked token from 2026-05-20 (`npm_jiX...` and `npm_u0T...`) should be revoked once you're done publishing.

## Common mistakes (don't)

- **Don't** publish from a dirty working tree. The bump commit should be clean.
- **Don't** commit `~/.npmrc` or any token to the repo. `.gitignore` doesn't ignore `.npmrc` currently — that's intentional because there should never be one in the repo.
- **Don't** publish without running typecheck + test first; `prepare` only runs `build`, not test.
- **Don't** use `npm version` — it auto-creates a commit + tag that breaks the repo's commit-message convention.
- **Don't** publish more than one workspace package in a single command. Iterate.

## Related

- Memory of the publish flow: [[project-publish-flow]] (in pi-mind memory, kept in sync with this skill).
