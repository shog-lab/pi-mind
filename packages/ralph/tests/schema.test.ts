/**
 * Tests for pi-goals schema (lib/schema.ts).
 * Schema objects are for pi-coding-agent's internal use (type validation),
 * not for manual .parse() calls. Tests verify structure and defaults.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
} from "../extensions/goals/schema.js";

describe("DEFAULT_CONFIG", () => {
  it("has expected defaults", () => {
    expect(DEFAULT_CONFIG.defaultMaxIterations).toBe(10);
    expect(DEFAULT_CONFIG.verificationTools).toContain("Bash");
    expect(DEFAULT_CONFIG.verificationTools).toContain("Read");
    expect(DEFAULT_CONFIG.verificationTools).toContain("Grep");
    expect(DEFAULT_CONFIG.verificationTools).toContain("Find");
  });

  it("execution tools are built-in pi tools (no spawn_subagent — sub-agents run with --no-extensions)", () => {
    expect(DEFAULT_CONFIG.executionTools).toContain("Bash");
    expect(DEFAULT_CONFIG.executionTools).toContain("Read");
    expect(DEFAULT_CONFIG.executionTools).toContain("Write");
    expect(DEFAULT_CONFIG.executionTools).toContain("Edit");
    // spawn_subagent is NOT available in sub-agents since they use --no-extensions
    expect(DEFAULT_CONFIG.executionTools).not.toContain("spawn_subagent");
  });

  it("verification tools exclude write/edit", () => {
    expect(DEFAULT_CONFIG.verificationTools).not.toContain("Write");
    expect(DEFAULT_CONFIG.verificationTools).not.toContain("Edit");
    expect(DEFAULT_CONFIG.verificationTools).not.toContain("spawn_subagent");
  });
});

describe("schema exports", () => {
  it("exports GoalState schema", async () => {
    const { GoalState } = await import("../extensions/goals/schema.js");
    expect(GoalState).toBeDefined();
    expect((GoalState as any).anyOf).toBeDefined(); // Union stores variants in anyOf
  });

  it("exports UserStorySchema", async () => {
    const { UserStorySchema } = await import("../extensions/goals/schema.js");
    expect(UserStorySchema).toBeDefined();
    expect(UserStorySchema.type).toBe("object");
  });

  it("exports GoalSchema", async () => {
    const { GoalSchema } = await import("../extensions/goals/schema.js");
    expect(GoalSchema).toBeDefined();
    expect(GoalSchema.type).toBe("object");
  });

  it("exports PRDDBSchema", async () => {
    const { PRDDBSchema } = await import("../extensions/goals/schema.js");
    expect(PRDDBSchema).toBeDefined();
    expect(PRDDBSchema.type).toBe("object");
  });
});

describe("GoalState union values", () => {
  it("GoalState has 7 variants", async () => {
    const { GoalState } = await import("../extensions/goals/schema.js");
    // TypeBox Union stores variants in anyOf array
    const variants = (GoalState as any).anyOf;
    expect(variants).toHaveLength(7);
  });

  it("GoalState variants match expected states", async () => {
    const { GoalState } = await import("../extensions/goals/schema.js");
    const variants = (GoalState as any).anyOf;
    // "iteration_limited" is distinct from "failed": loop ran out of
    // rounds with stories still incomplete, but nothing crashed.
    const expected = ["created", "active", "paused", "completed", "failed", "budget_limited", "iteration_limited"];
    const actual = variants.map((v: any) => v.const);
    expect(actual.sort()).toEqual(expected.sort());
  });
});

describe("UserStorySchema properties", () => {
  it("has required id, title, description, priority", async () => {
    const { UserStorySchema } = await import("../extensions/goals/schema.js");
    const props = (UserStorySchema as any).properties;
    expect(props.id).toBeDefined();
    expect(props.title).toBeDefined();
    expect(props.description).toBeDefined();
    expect(props.priority).toBeDefined();
  });

  it("has optional passes and notes with defaults", async () => {
    const { UserStorySchema } = await import("../extensions/goals/schema.js");
    const props = (UserStorySchema as any).properties;
    expect(props.passes.default).toBe(false);
    expect(props.notes.default).toBe("");
  });

  it("acceptanceCriteria is array of strings", async () => {
    const { UserStorySchema } = await import("../extensions/goals/schema.js");
    const props = (UserStorySchema as any).properties;
    expect(props.acceptanceCriteria.type).toBe("array");
    expect(props.acceptanceCriteria.items.type).toBe("string");
  });
});

describe("GoalSchema properties", () => {
  it("has required id, state, objective, branchName, cwd", async () => {
    const { GoalSchema } = await import("../extensions/goals/schema.js");
    const props = (GoalSchema as any).properties;
    expect(props.id).toBeDefined();
    expect(props.state).toBeDefined();
    expect(props.objective).toBeDefined();
    expect(props.branchName).toBeDefined();
    expect(props.cwd).toBeDefined();
  });

  it("has tokensUsed with default 0", async () => {
    const { GoalSchema } = await import("../extensions/goals/schema.js");
    const props = (GoalSchema as any).properties;
    expect(props.tokensUsed.default).toBe(0);
  });

  it("has optional userStories array", async () => {
    const { GoalSchema } = await import("../extensions/goals/schema.js");
    const props = (GoalSchema as any).properties;
    expect(props.userStories.type).toBe("array");
    expect(props.userStories.items).toBeDefined();
  });
});