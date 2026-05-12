/**
 * Tests for GoalStore (lib/store.ts).
 * Uses temp directories for isolated testing.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { GoalStore } from "../extensions/goals/store.js";
import type { Goal } from "../extensions/goals/schema.js";

let tmpDir: string;
let store: GoalStore;

function resolveGoalsDir() {
  return path.join(tmpDir, ".pi-goals");
}

function resolveGoalsDB() {
  return path.join(resolveGoalsDir(), "goals.db");
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "goals-store-"));
  process.env.PI_GOALS_DIR = path.join(tmpDir, ".pi-goals");
  store = new GoalStore(resolveGoalsDB());
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function createGoal(overrides?: Partial<Goal>): Goal {
  const now = new Date().toISOString();
  return {
    id: "goal-test-" + Math.random().toString(36).slice(2),
    state: "created",
    objective: "Test goal",
    branchName: "ralph/test",
    cwd: tmpDir,
    tokensUsed: 0,
    maxIterations: 10,
    currentIteration: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("GoalStore", () => {
  describe("createGoal + getGoal", () => {
    it("creates and retrieves a goal", () => {
      const goal = createGoal();
      store.createGoal(goal);
      const retrieved = store.getGoal(goal.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(goal.id);
      expect(retrieved!.objective).toBe("Test goal");
      expect(retrieved!.state).toBe("created");
    });

    it("creates goal with userStories", () => {
      const goal = createGoal({
        userStories: [
          {
            id: "US-001",
            title: "Story 1",
            description: "Desc",
            acceptanceCriteria: ["AC1"],
            priority: 1,
            passes: false,
            notes: "",
          },
        ],
      });
      store.createGoal(goal);
      const retrieved = store.getGoal(goal.id);
      expect(retrieved!.userStories).toHaveLength(1);
      expect(retrieved!.userStories![0].id).toBe("US-001");
    });

    it("returns null for non-existent goal", () => {
      const retrieved = store.getGoal("nonexistent");
      expect(retrieved).toBeNull();
    });
  });

  describe("updateGoal", () => {
    it("updates state", () => {
      const goal = createGoal({ state: "created" });
      store.createGoal(goal);
      store.updateGoal(goal.id, { state: "active" });
      const retrieved = store.getGoal(goal.id);
      expect(retrieved!.state).toBe("active");
    });

    it("updates currentIteration", () => {
      const goal = createGoal();
      store.createGoal(goal);
      store.updateGoal(goal.id, { currentIteration: 3 });
      const retrieved = store.getGoal(goal.id);
      expect(retrieved!.currentIteration).toBe(3);
    });

    it("updates completedAt when transitioning to completed", () => {
      const goal = createGoal({ state: "active" });
      store.createGoal(goal);
      store.transitionTo(goal.id, "completed");
      const retrieved = store.getGoal(goal.id);
      expect(retrieved!.completedAt).toBeDefined();
    });
  });

  describe("getNextStory", () => {
    it("returns highest priority incomplete story", () => {
      const goal = createGoal({
        userStories: [
          { id: "US-003", title: "P3", description: "D", acceptanceCriteria: [], priority: 3, passes: false, notes: "" },
          { id: "US-001", title: "P1", description: "D", acceptanceCriteria: [], priority: 1, passes: false, notes: "" },
          { id: "US-002", title: "P2", description: "D", acceptanceCriteria: [], priority: 2, passes: false, notes: "" },
        ],
      });
      store.createGoal(goal);
      const next = store.getNextStory(goal.id);
      expect(next!.id).toBe("US-001");
    });

    it("skips completed stories", () => {
      const goal = createGoal({
        userStories: [
          { id: "US-001", title: "P1", description: "D", acceptanceCriteria: [], priority: 1, passes: true, notes: "" },
          { id: "US-002", title: "P2", description: "D", acceptanceCriteria: [], priority: 2, passes: false, notes: "" },
        ],
      });
      store.createGoal(goal);
      const next = store.getNextStory(goal.id);
      expect(next!.id).toBe("US-002");
    });

    it("returns null when all complete", () => {
      const goal = createGoal({
        userStories: [
          { id: "US-001", title: "P1", description: "D", acceptanceCriteria: [], priority: 1, passes: true, notes: "" },
        ],
      });
      store.createGoal(goal);
      const next = store.getNextStory(goal.id);
      expect(next).toBeNull();
    });
  });

  describe("updateStoryPasses", () => {
    it("marks story as passing", () => {
      const goal = createGoal({
        userStories: [
          { id: "US-001", title: "P1", description: "D", acceptanceCriteria: [], priority: 1, passes: false, notes: "" },
        ],
      });
      store.createGoal(goal);
      store.updateStoryPasses(goal.id, "US-001", true);
      const next = store.getNextStory(goal.id);
      expect(next).toBeNull(); // all complete
    });

    it("marks story as failing", () => {
      const goal = createGoal({
        userStories: [
          { id: "US-001", title: "P1", description: "D", acceptanceCriteria: [], priority: 1, passes: false, notes: "" },
        ],
      });
      store.createGoal(goal);
      store.updateStoryPasses(goal.id, "US-001", false);
      const next = store.getNextStory(goal.id);
      expect(next).not.toBeNull();
    });
  });

  describe("allStoriesComplete", () => {
    it("returns true when all stories pass", () => {
      const goal = createGoal({
        userStories: [
          { id: "US-001", title: "P1", description: "D", acceptanceCriteria: [], priority: 1, passes: true, notes: "" },
        ],
      });
      store.createGoal(goal);
      expect(store.allStoriesComplete(goal.id)).toBe(true);
    });

    it("returns false when incomplete stories exist", () => {
      const goal = createGoal({
        userStories: [
          { id: "US-001", title: "P1", description: "D", acceptanceCriteria: [], priority: 1, passes: true, notes: "" },
          { id: "US-002", title: "P2", description: "D", acceptanceCriteria: [], priority: 2, passes: false, notes: "" },
        ],
      });
      store.createGoal(goal);
      expect(store.allStoriesComplete(goal.id)).toBe(false);
    });
  });

  describe("transitionTo", () => {
    it("transitions to active", () => {
      const goal = createGoal({ state: "created" });
      store.createGoal(goal);
      store.transitionTo(goal.id, "active");
      const retrieved = store.getGoal(goal.id);
      expect(retrieved!.state).toBe("active");
    });

    it("transitions to completed and sets completedAt", () => {
      const goal = createGoal({ state: "active" });
      store.createGoal(goal);
      store.transitionTo(goal.id, "completed");
      const retrieved = store.getGoal(goal.id);
      expect(retrieved!.state).toBe("completed");
      expect(retrieved!.completedAt).toBeDefined();
    });

    it("transitions to budget_limited", () => {
      const goal = createGoal({ state: "active" });
      store.createGoal(goal);
      store.transitionTo(goal.id, "budget_limited");
      const retrieved = store.getGoal(goal.id);
      expect(retrieved!.state).toBe("budget_limited");
    });
  });

  describe("iterationLogs", () => {
    it("inserts and retrieves iteration log", () => {
      const goal = createGoal({ state: "active" });
      store.createGoal(goal);

      store.insertIteration({
        goalId: goal.id,
        iteration: 1,
        storyId: "US-001",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        executionOutput: "Done",
        verificationResult: { passes: true, evidence: {}, incompleteReasons: [] },
        changedFiles: ["a.ts", "b.ts"],
      });

      const logs = store.getIterations(goal.id);
      expect(logs).toHaveLength(1);
      expect(logs[0].iteration).toBe(1);
      expect(logs[0].storyId).toBe("US-001");
      expect(logs[0].verificationResult?.passes).toBe(true);
    });

    it("retrieves multiple iterations in order", () => {
      const goal = createGoal({ state: "active" });
      store.createGoal(goal);

      for (let i = 1; i <= 3; i++) {
        store.insertIteration({
          goalId: goal.id,
          iteration: i,
          storyId: `US-00${i}`,
          startedAt: new Date().toISOString(),
          changedFiles: [],
        });
      }

      const logs = store.getIterations(goal.id);
      expect(logs).toHaveLength(3);
      expect(logs[0].iteration).toBe(1);
      expect(logs[1].iteration).toBe(2);
      expect(logs[2].iteration).toBe(3);
    });
  });
});