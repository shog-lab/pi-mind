---
name: ralph
description: Convert a markdown PRD to prd.json format for Ralph goal execution.
---

# Ralph Skill

Convert a markdown PRD document to `prd.json` format, which the `/goal` command uses to drive the autonomous loop.

## Usage

```
Load the ralph skill and convert <path-to-prd.md> to prd.json
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
Load the ralph skill and convert tasks/prd-login.md to prd.json
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
