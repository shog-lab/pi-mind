---
name: prd
description: Generate Product Requirements Documents from natural language descriptions.
---

# PRD Skill

Generate a detailed PRD from a natural language feature description. This skill helps you plan features before using the Ralph goal loop.

## Usage

```
Load the prd skill and create a PRD for <feature description>
```

## What it does

1. Ask clarifying questions about the feature
2. Generate a structured PRD document
3. Save it to `tasks/prd-<feature-name>.md`

## PRD Structure

```markdown
# PRD: <Feature Name>

## Overview
Brief description of what this feature does and why it matters.

## User Stories

### US-001: <Story Title>
**As a** [persona]  
**I want** [action]  
**So that** [benefit]

**Acceptance Criteria:**
1. [Criterion 1]
2. [Criterion 2]
3. [Criterion 3 - include browser verification if UI]

## Technical Notes
- Any technical constraints or decisions
- Dependencies
- Edge cases
```

## Tips for Good PRDs

- **Small stories**: Each story should be completable in one context window
- **Verifiable criteria**: Every acceptance criterion should have concrete evidence
- **Browser verification**: For UI stories, include "Verify in browser" in criteria
- **Priority**: Order stories so the most critical is first

## Next Steps

After creating the PRD:
1. Review it for completeness
2. Adjust priorities if needed
3. Split any stories that seem too large
4. Use the `ralph` skill to convert to `prd.json` format
5. Run `/goal --from tasks/prd-<feature-name>.json`

## Example

```
Load the prd skill and create a PRD for "add user profile page with avatar upload"
```
