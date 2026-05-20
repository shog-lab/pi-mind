---
name: prd-compile
description: Compile a markdown PRD into the prd.json format the goal loop consumes.
---

# prd-compile Skill

Compile a markdown PRD document into `prd.json`, the structured format the `/goal` command uses to drive the autonomous loop.

(Previously named `ralph` after the package codename; renamed for clarity since the name didn't describe what the skill does.)

## Usage

```
Load the prd-compile skill and convert <path-to-prd.md> to prd.json
```

## What it does

1. Reads the markdown PRD
2. Parses user stories with acceptance criteria
3. Outputs `prd.json` with:
   - `branchName`: git branch for this feature
   - `userStories`: array with `id`, `title`, `description`, `acceptanceCriteria`, `priority`, `passes: false`

## prd.json Format

```json
{
  "project": "MyProject",
  "branchName": "ralph/feature-name",
  "description": "Brief description",
  "userStories": [
    {
      "id": "US-001",
      "title": "Story title",
      "description": "What this story does",
      "acceptanceCriteria": [
        "Criterion 1",
        "Criterion 2"
      ],
      "priority": 1,
      "passes": false,
      "notes": ""
    }
  ]
}
```

## Example

```bash
Load the prd-compile skill and convert tasks/prd-login.md to prd.json
```

This creates `prd.json` in the current directory.

## Next Steps

After conversion:
```bash
pi -p "/goal --from prd.json"
```

## Tips

- Verify the `branchName` is unique per feature (Ralph archives previous runs by branch)
- Check that all acceptance criteria are concrete and verifiable
- Ensure each story is small enough for one iteration
