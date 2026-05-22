/**
 * pi-mind Skill Evolution Extension
 *
 * Registers write_skill — the only tool agents need to author or modify
 * skills. The companion define-skill / revise-skill skills (markdown
 * documents loaded into the agent's context only when invoked) carry the
 * guidance on WHEN and HOW to call it.
 *
 * Skills are written directly to <host-repo>/.pi/skills/<name>/SKILL.md.
 * They take effect on next pi startup. Previous content is backed up to
 * a same-dir timestamped .bak so manual rollback is trivial.
 */

import { dirname } from "node:path";
import { resolvePiMindDir } from "@shog-lab/pi-utils";
import { writeSkill } from "../../lib/skill-evolution.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PI_MIND_DIR = resolvePiMindDir();
const HOST_ROOT = dirname(PI_MIND_DIR);

export default function skillEvolutionExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "write_skill",
    label: "Write Skill",
    description: [
      "Author or revise a pi skill (markdown instructions the agent can",
      "later load with 'use <name> skill').",
      "",
      "Write to <host>/.pi/skills/<name>/SKILL.md. If a skill of the same",
      "name already exists, its current content is backed up to a same-dir",
      "timestamped .bak before being overwritten.",
      "",
      "CALL THIS ONLY when invoked inside the define-skill or revise-skill",
      "workflow (those skills guide the user-requested process and end by",
      "calling this tool). Do not call from arbitrary turns — skill files",
      "shape future agent behavior, so authoring should be a deliberate,",
      "user-driven act.",
      "",
      "Refuses to overwrite skills installed by npm packages (those appear",
      "as symlinks under .pi/skills/) — pick a different name in that case.",
      "",
      "Skills only become visible to the agent on the NEXT pi startup.",
    ].join("\n"),
    parameters: {
      type: "object",
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
    },
    async execute(_id: string, params: { name: string; description: string; body: string }) {
      const result = writeSkill({
        name: params.name,
        description: params.description,
        body: params.body,
        hostRoot: HOST_ROOT,
      });
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: `write_skill failed (${result.reason}): ${result.detail}` }],
          details: {},
          isError: true as const,
        };
      }
      const text = result.backedUpTo
        ? `Wrote ${result.path}\nBacked up previous content → ${result.backedUpTo}\n(Restart pi to make the skill visible.)`
        : `Wrote ${result.path}\n(Restart pi to make the skill visible.)`;
      return { content: [{ type: "text" as const, text }], details: {} };
    },
  });
}
