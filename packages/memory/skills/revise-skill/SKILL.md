---
name: revise-skill
description: Modify an existing pi skill based on a user-requested change — read live, apply the change, commit via update_skill.
---

# revise-skill

Use this when the user asks you to change an existing skill ("X skill should also …", "X skill is wrong, it says Y but Z is right", "make X skill clearer about the auth step").

## Process

1. **Locate the skill**. Live skills live at `.pi/skills/<name>/SKILL.md`. The directory may be a symlink (npm-package skill) or a regular directory (user-authored). Read the current SKILL.md.

2. **If it's a symlink**, refuse to modify it directly. Tell the user it's an installed-package skill and they need to either:
   - File a change against the upstream package (their preferred route for shared skills), OR
   - Manually replace the symlink with a regular file copy and then re-run revise-skill on the copy.

3. **Understand the existing skill** — read the whole body. Identify the part the user wants to change.

4. **Apply the change minimally**. Don't rewrite the whole skill just to tweak one step. If the change is "add a step before Y", insert one numbered item. If "rename X to Y", search-and-replace inside your draft.

5. **Show the user a diff** (what's changing, not just the new body) before committing. Same principle as define-skill: explicit review = the gate. (See "Behavior-changing autonomy requires inline gate" in AGENTS.md.)

6. **When they approve**, call `update_skill({name, description, body})` with the FULL new body. The tool will automatically back up the previous content to a same-dir timestamped `.bak`. (`update_skill` will FAIL if the skill doesn't already exist — for new skills, use the `define-skill` workflow + `create_skill` tool.)

7. **Remind the user** to restart pi if they want the change live.

## When to push back on the user

- **"Rewrite the X skill to also do Y"** — that's often a sign Y should be a new skill, not bolted into X. Suggest splitting.
- **"Remove all the anti-pattern sections"** — anti-patterns earn their keep by stopping LLMs from drifting. Resist removing them unless they're genuinely wrong.
- **"Make it shorter"** — verify it's actually too long for the job, not just verbose. Cut filler, keep concrete steps.

## Rollback

If the user later regrets the change:
- The previous content is at `.pi/skills/<name>/SKILL.md.bak.<timestamp>`.
- Manually: `cp .pi/skills/<name>/SKILL.md.bak.<ts> .pi/skills/<name>/SKILL.md`.

There is intentionally no rollback tool — manual revert is fine because the user is in the conversation when they realize it's wrong, and the .bak path is right there in the previous update_skill output.

## Don't

- Don't call `update_skill` without the user seeing a diff. The user reviewing and saying "yes" IS the gate — without it, you must not commit.
- Don't preserve old structure "just in case" — if the user asked for a clean change, give them a clean change.
- Don't try to revise a skill the user hasn't named explicitly — ask "which skill?" if unclear.
