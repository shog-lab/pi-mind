/**
 * pi-mind Skill Evolution Extension
 *
 * Registers two tools:
 *   - create_skill — author a NEW skill (fails if one with the name exists)
 *   - update_skill — modify an EXISTING skill (fails if it doesn't exist)
 *
 * Both write directly to <host-repo>/.pi/skills/<name>/SKILL.md. update_skill
 * backs the previous content up to a same-dir SKILL.md.bak.<timestamp>.
 * Skills take effect on next pi startup.
 *
 * 0.6.0 split the old single `write_skill` tool into create + update to:
 *   1. force deliberate intent (agent has to think "am I authoring or revising?")
 *   2. let pi's per-tool permission prompts be more specific
 *      ("Create new skill 'X'?" vs "Update existing 'Y'?")
 *
 * Per the "Behavior-changing autonomy requires inline gate" design principle
 * (see top-level AGENTS.md), the tool descriptions REQUIRE the agent to
 * propose the proposal in chat first and only call after explicit user
 * approval. The companion define-skill / revise-skill skills walk the agent
 * through that workflow.
 */

import { dirname } from "node:path";
import { resolvePiMindDir } from "@shog-lab/pi-utils";
import { createSkill, updateSkill } from "../../lib/skill-evolution.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PI_MIND_DIR = resolvePiMindDir();
const HOST_ROOT = dirname(PI_MIND_DIR);

const SKILL_PARAMS = {
  type: "object" as const,
  properties: {
    name: {
      type: "string",
      description: "Skill name. lowercase letters / digits / hyphens only, must start with a letter, ≤ 64 chars. e.g. 'deploy-flow', 'fix-flaky-test'.",
    },
    description: {
      type: "string",
      description: "One-sentence description of what the skill does. Surfaced in the agent's skill list, so make it match-able for relevance.",
    },
    body: {
      type: "string",
      description: "Markdown body of the skill (everything after the frontmatter). Typically: ## Usage, ## What it does, ## Steps, ## Anti-patterns. Be concrete — examples beat abstractions.",
    },
  },
  required: ["name", "description", "body"],
};

const ASK_FIRST_PREAMBLE = [
  "**MUST ASK USER FIRST.** Before calling this tool:",
  "  1. Propose the skill in chat — show the name, description, and full body draft",
  "  2. Wait for explicit user approval (yes / 同意 / 改成 X 后同意 / etc.)",
  "  3. ONLY call this tool after the user said yes",
  "",
  "Skills change FUTURE agent behavior, persistently, across all sessions.",
  "Per the 'Behavior-changing autonomy requires inline gate' design principle,",
  "you do not have authority to commit a skill without that explicit gate.",
  "If the user invoked the define-skill / revise-skill workflow, that does",
  "NOT itself count as approval to call this tool — the workflow ends with",
  "you proposing the draft and waiting for confirmation.",
  "",
].join("\n");

export default function skillEvolutionExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "create_skill",
    label: "Create New Skill",
    description: ASK_FIRST_PREAMBLE + [
      "Create a NEW skill at <host>/.pi/skills/<name>/SKILL.md.",
      "",
      "Fails if a skill with the same name already exists — use update_skill",
      "for that case. Also refuses to overwrite skills installed by npm",
      "packages (those appear as symlinks under .pi/skills/) — pick a",
      "different name.",
      "",
      "Skills only become visible to the agent on the NEXT pi startup.",
    ].join("\n"),
    parameters: SKILL_PARAMS,
    async execute(_id: string, params: { name: string; description: string; body: string }) {
      const result = createSkill({
        name: params.name,
        description: params.description,
        body: params.body,
        hostRoot: HOST_ROOT,
      });
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: `create_skill failed (${result.reason}): ${result.detail}` }],
          details: {},
          isError: true as const,
        };
      }
      return {
        content: [{ type: "text" as const, text: `Created ${result.path}\n(Restart pi to make the skill visible.)` }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "update_skill",
    label: "Update Existing Skill",
    description: ASK_FIRST_PREAMBLE + [
      "Update an EXISTING skill at <host>/.pi/skills/<name>/SKILL.md.",
      "",
      "Fails if the skill doesn't exist — use create_skill for new ones.",
      "Previous content is backed up to a same-dir SKILL.md.bak.<timestamp>",
      "before overwrite, so manual rollback is `cp` away.",
      "",
      "When proposing the update in chat, SHOW THE DIFF (what's being changed)",
      "not just the new content — the user needs to see what's being lost.",
      "",
      "Skills only become visible to the agent on the NEXT pi startup.",
    ].join("\n"),
    parameters: SKILL_PARAMS,
    async execute(_id: string, params: { name: string; description: string; body: string }) {
      const result = updateSkill({
        name: params.name,
        description: params.description,
        body: params.body,
        hostRoot: HOST_ROOT,
      });
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: `update_skill failed (${result.reason}): ${result.detail}` }],
          details: {},
          isError: true as const,
        };
      }
      const text = result.backedUpTo
        ? `Updated ${result.path}\nPrevious content backed up → ${result.backedUpTo}\n(Restart pi to make the changes visible.)`
        : `Updated ${result.path}\n(Restart pi to make the changes visible.)`;
      return { content: [{ type: "text" as const, text }], details: {} };
    },
  });
}
