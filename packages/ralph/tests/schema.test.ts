/**
 * Tests for the simplified pi-goals schema.
 */
import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  PRDSchema, UserStorySchema, VerificationResultSchema,
  EXECUTION_TOOLS, VERIFICATION_TOOLS, DEFAULT_MAX_ITERATIONS,
} from "../extensions/goals/schema.js";

describe("UserStorySchema", () => {
  it("requires id, title, description, acceptanceCriteria, priority", () => {
    const valid = {
      id: "US-001", title: "x", description: "y",
      acceptanceCriteria: ["a"], priority: 1, passes: false, notes: "",
    };
    expect(Value.Check(UserStorySchema, valid)).toBe(true);
  });

  it("acceptanceCriteria must be array of strings", () => {
    const props = (UserStorySchema as any).properties;
    expect(props.acceptanceCriteria.type).toBe("array");
    expect(props.acceptanceCriteria.items.type).toBe("string");
  });

  it("passes defaults to false, notes to empty", () => {
    const props = (UserStorySchema as any).properties;
    expect(props.passes.default).toBe(false);
    expect(props.notes.default).toBe("");
  });
});

describe("PRDSchema", () => {
  it("accepts a well-formed PRD", () => {
    const prd = {
      project: "test",
      branchName: "ralph/test",
      description: "test prd",
      userStories: [{
        id: "US-001", title: "x", description: "y",
        acceptanceCriteria: ["a"], priority: 1, passes: false, notes: "",
      }],
    };
    expect(Value.Check(PRDSchema, prd)).toBe(true);
  });

  it("rejects missing userStories", () => {
    const prd = { project: "x", branchName: "b", description: "d" };
    expect(Value.Check(PRDSchema, prd)).toBe(false);
  });

  it("rejects story missing acceptanceCriteria", () => {
    const prd = {
      project: "x", branchName: "b", description: "d",
      userStories: [{ id: "1", title: "t", description: "d", priority: 1, passes: false, notes: "" }],
    };
    expect(Value.Check(PRDSchema, prd)).toBe(false);
  });
});

describe("VerificationResultSchema", () => {
  it("requires passes: boolean", () => {
    expect(Value.Check(VerificationResultSchema, { passes: true })).toBe(true);
    expect(Value.Check(VerificationResultSchema, { passes: "yes" })).toBe(false);
    expect(Value.Check(VerificationResultSchema, { passes: null })).toBe(false);
    expect(Value.Check(VerificationResultSchema, { pass: true })).toBe(false);
  });

  it("evidence is optional record of strings", () => {
    expect(Value.Check(VerificationResultSchema, {
      passes: true, evidence: { c1: "found it" },
    })).toBe(true);
  });

  it("rejects evidence values that aren't strings", () => {
    expect(Value.Check(VerificationResultSchema, {
      passes: true, evidence: { c1: 42 },
    })).toBe(false);
  });

  it("incompleteReasons is optional array of strings", () => {
    expect(Value.Check(VerificationResultSchema, {
      passes: false, incompleteReasons: ["reason a", "reason b"],
    })).toBe(true);
  });
});

describe("tool allowlists", () => {
  it("EXECUTION_TOOLS has write/edit; VERIFICATION_TOOLS does not", () => {
    expect(EXECUTION_TOOLS).toContain("bash");
    expect(EXECUTION_TOOLS).toContain("read");
    expect(EXECUTION_TOOLS).toContain("write");
    expect(EXECUTION_TOOLS).toContain("edit");
    expect(VERIFICATION_TOOLS).toContain("bash");
    expect(VERIFICATION_TOOLS).toContain("read");
    expect(VERIFICATION_TOOLS).not.toContain("write");
    expect(VERIFICATION_TOOLS).not.toContain("edit");
  });

  it("tool names are all lowercase (pi tool registry is case-sensitive)", () => {
    for (const t of [...EXECUTION_TOOLS, ...VERIFICATION_TOOLS]) {
      expect(t).toBe(t.toLowerCase());
    }
  });
});

describe("constants", () => {
  it("DEFAULT_MAX_ITERATIONS is sane", () => {
    expect(DEFAULT_MAX_ITERATIONS).toBeGreaterThan(0);
    expect(DEFAULT_MAX_ITERATIONS).toBeLessThan(100);
  });
});
