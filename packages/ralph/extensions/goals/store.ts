/**
 * Goal Store — SQLite-backed persistence for goal state machine.
 * Lives at $PI_GOALS_DIR/goals.db (default: $PI_MIND_DIR/../.pi-goals/goals.db).
 * 
 * State transitions:
 *   created → active → paused → active → completed
 *                              → budget_limited
 *                              → failed
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { resolvePiMindDir } from "@shog-lab/pi-utils";
import { Goal, GoalState, IterationLog, DEFAULT_CONFIG, type GoalsConfig } from "./schema.js";
import { withGroupLock } from "./mutex.js";

// --- Directory resolution ---

/**
 * Resolve PI_GOALS_DIR — defaults to a sibling of pi-mind's resolved directory.
 *
 * Chains off resolvePiMindDir(), so when running in a git worktree both
 * .pi-mind and .pi-goals route to the main repo root (not the worktree).
 * Explicit $PI_GOALS_DIR env var always wins.
 */
export function resolveGoalsDir(): string {
  if (process.env.PI_GOALS_DIR) return process.env.PI_GOALS_DIR;
  const piMindDir = resolvePiMindDir();
  // Sibling to pi-mind: ./.pi-mind → ../.pi-goals (note leading dot)
  return join(dirname(resolve(piMindDir)), ".pi-goals");
}

/** Resolve goals DB path */
export function resolveGoalsDB(): string {
  return join(resolveGoalsDir(), "goals.db");
}

/** Resolve config path */
function resolveConfig(): string {
  return join(resolveGoalsDir(), "pi-goals-config.json");
}

// --- Store class ---

export class GoalStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const resolved = dbPath || resolveGoalsDB();
    const dir = dirname(resolved);
    mkdirSync(dir, { recursive: true });
    this.db = new Database(resolved);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS goals (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL DEFAULT 'created',
        objective TEXT NOT NULL,
        branchName TEXT NOT NULL,
        cwd TEXT NOT NULL,
        prdFile TEXT,
        tokensUsed INTEGER NOT NULL DEFAULT 0,
        tokenBudget INTEGER,
        costUsd REAL NOT NULL DEFAULT 0,
        maxIterations INTEGER NOT NULL DEFAULT 10,
        currentIteration INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        completedAt TEXT
      );

      CREATE TABLE IF NOT EXISTS userStories (
        id TEXT PRIMARY KEY,
        goalId TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        acceptanceCriteria TEXT NOT NULL,  -- JSON array
        priority INTEGER NOT NULL,
        passes INTEGER NOT NULL DEFAULT 0,
        notes TEXT NOT NULL DEFAULT '',
        FOREIGN KEY (goalId) REFERENCES goals(id)
      );

      CREATE TABLE IF NOT EXISTS iterationLogs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        goalId TEXT NOT NULL,
        iteration INTEGER NOT NULL,
        storyId TEXT,
        startedAt TEXT NOT NULL,
        completedAt TEXT,
        executionOutput TEXT,
        verificationResult TEXT,  -- JSON
        changedFiles TEXT NOT NULL,  -- JSON array
        FOREIGN KEY (goalId) REFERENCES goals(id)
      );

      CREATE INDEX IF NOT EXISTS idx_goals_state ON goals(state);
      CREATE INDEX IF NOT EXISTS idx_stories_goalId ON userStories(goalId);
      CREATE INDEX IF NOT EXISTS idx_logs_goalId ON iterationLogs(goalId);
    `);

    // Lightweight migrations for DBs created before columns were added.
    // SQLite ALTER TABLE ADD COLUMN is idempotent only via try/catch on "duplicate column".
    try {
      this.db.exec(`ALTER TABLE goals ADD COLUMN costUsd REAL NOT NULL DEFAULT 0`);
    } catch { /* column already exists — migrated */ }
    try {
      this.db.exec(`ALTER TABLE goals ADD COLUMN worktreePath TEXT`);
    } catch { /* column already exists — migrated */ }
  }

  // --- Config ---

  loadConfig(): GoalsConfig {
    const configPath = resolveConfig();
    if (existsSync(configPath)) {
      try {
        const raw = JSON.parse(readFileSync(configPath, "utf-8"));
        return { ...DEFAULT_CONFIG, ...raw };
      } catch (e) {
        // File exists but failed to read / parse — almost always malformed JSON.
        // Silent fallback to DEFAULT_CONFIG would hide a real user-facing bug
        // (their override file is being ignored).
        console.warn(`[pi-goals] failed to parse config at ${configPath}: ${e instanceof Error ? e.message : String(e)}. Using DEFAULT_CONFIG.`);
      }
    }
    return DEFAULT_CONFIG;
  }

  // --- Goal CRUD ---

  createGoal(goal: Goal): void {
    const stmt = this.db.prepare(`
      INSERT INTO goals (id, state, objective, branchName, cwd, worktreePath, prdFile,
        tokensUsed, tokenBudget, costUsd, maxIterations, currentIteration, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      goal.id, goal.state, goal.objective, goal.branchName, goal.cwd,
      goal.worktreePath ?? null, goal.prdFile ?? null,
      goal.tokensUsed, goal.tokenBudget ?? null, goal.costUsd ?? 0,
      goal.maxIterations, goal.currentIteration,
      goal.createdAt, goal.updatedAt
    );

    if (goal.userStories) {
      const storyStmt = this.db.prepare(`
        INSERT INTO userStories (id, goalId, title, description, acceptanceCriteria, priority, passes, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const story of goal.userStories) {
        storyStmt.run(
          story.id, goal.id, story.title, story.description,
          JSON.stringify(story.acceptanceCriteria), story.priority, story.passes ? 1 : 0, story.notes
        );
      }
    }
  }

  getGoal(id: string): Goal | null {
    const row = this.db.prepare("SELECT * FROM goals WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;

    const stories = this.getStories(id);
    return {
      id: row.id as string,
      state: row.state as GoalState,
      objective: row.objective as string,
      branchName: row.branchName as string,
      cwd: row.cwd as string,
      worktreePath: (row.worktreePath as string | null) ?? undefined,
      prdFile: row.prdFile as string | undefined,
      tokensUsed: row.tokensUsed as number,
      tokenBudget: row.tokenBudget as number | undefined,
      costUsd: (row.costUsd as number) ?? 0,
      maxIterations: row.maxIterations as number,
      currentIteration: row.currentIteration as number,
      createdAt: row.createdAt as string,
      updatedAt: row.updatedAt as string,
      completedAt: row.completedAt as string | undefined,
      userStories: stories.length > 0 ? stories : undefined,
    };
  }

  updateGoal(id: string, updates: Partial<Goal>): void {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.state !== undefined) { fields.push("state = ?"); values.push(updates.state); }
    if (updates.tokensUsed !== undefined) { fields.push("tokensUsed = ?"); values.push(updates.tokensUsed); }
    if (updates.costUsd !== undefined) { fields.push("costUsd = ?"); values.push(updates.costUsd); }
    if (updates.currentIteration !== undefined) { fields.push("currentIteration = ?"); values.push(updates.currentIteration); }
    if (updates.completedAt !== undefined) { fields.push("completedAt = ?"); values.push(updates.completedAt); }
    if (updates.worktreePath !== undefined) { fields.push("worktreePath = ?"); values.push(updates.worktreePath); }

    if (fields.length === 0) return;

    fields.push("updatedAt = ?");
    values.push(new Date().toISOString());
    values.push(id);

    this.db.prepare(`UPDATE goals SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  }

  // --- Stories ---

  private getStories(goalId: string) {
    const rows = this.db.prepare("SELECT * FROM userStories WHERE goalId = ? ORDER BY priority").all(goalId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      goalId: r.goalId as string,
      title: r.title as string,
      description: r.description as string,
      acceptanceCriteria: JSON.parse(r.acceptanceCriteria as string),
      priority: r.priority as number,
      passes: !!r.passes,
      notes: r.notes as string,
    }));
  }

  updateStoryPasses(goalId: string, storyId: string, passes: boolean): void {
    this.db.prepare("UPDATE userStories SET passes = ? WHERE id = ? AND goalId = ?")
      .run(passes ? 1 : 0, storyId, goalId);
  }

  getNextStory(goalId: string) {
    const row = this.db.prepare(
      "SELECT * FROM userStories WHERE goalId = ? AND passes = 0 ORDER BY priority LIMIT 1"
    ).get(goalId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      goalId: row.goalId as string,
      title: row.title as string,
      description: row.description as string,
      acceptanceCriteria: JSON.parse(row.acceptanceCriteria as string),
      priority: row.priority as number,
      passes: !!row.passes,
      notes: row.notes as string,
    };
  }

  allStoriesComplete(goalId: string): boolean {
    const remaining = this.db.prepare(
      "SELECT COUNT(*) as cnt FROM userStories WHERE goalId = ? AND passes = 0"
    ).get(goalId) as { cnt: number };
    return remaining.cnt === 0;
  }

  // --- Iteration Logs ---

  insertIteration(log: Omit<IterationLog, "id">): number {
    const result = this.db.prepare(`
      INSERT INTO iterationLogs (goalId, iteration, storyId, startedAt, completedAt, executionOutput, verificationResult, changedFiles)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      log.goalId, log.iteration, log.storyId ?? null, log.startedAt,
      log.completedAt ?? null, log.executionOutput ?? null,
      log.verificationResult ? JSON.stringify(log.verificationResult) : null,
      JSON.stringify(log.changedFiles)
    );
    return result.lastInsertRowid as number;
  }

  getIterations(goalId: string): IterationLog[] {
    const rows = this.db.prepare(
      "SELECT * FROM iterationLogs WHERE goalId = ? ORDER BY iteration"
    ).all(goalId) as Record<string, unknown>[];
    return rows.map((r) => ({
      goalId: r.goalId as string,
      iteration: r.iteration as number,
      storyId: r.storyId as string | undefined,
      startedAt: r.startedAt as string,
      completedAt: r.completedAt as string | undefined,
      executionOutput: r.executionOutput as string | undefined,
      verificationResult: r.verificationResult ? JSON.parse(r.verificationResult as string) : undefined,
      changedFiles: JSON.parse(r.changedFiles as string),
    }));
  }

  // --- State transitions ---

  transitionTo(id: string, newState: GoalState): void {
    const updates: Partial<Goal> = { state: newState };
    if (newState === "completed" || newState === "failed") {
      updates.completedAt = new Date().toISOString();
    }
    this.updateGoal(id, updates);
  }

  // --- Cleanup ---

  close(): void {
    this.db.close();
  }
}

// --- Global store singleton ---

let _store: GoalStore | null = null;

export function getStore(): GoalStore {
  if (!_store) {
    _store = new GoalStore();
  }
  return _store;
}
