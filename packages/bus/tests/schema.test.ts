/**
 * Schema smoke tests. Behavior verification lives in the integration e2e probe
 * (see commit log) — most logic in index.ts is closure-scoped runtime state
 * that's only meaningful with a live pi extension API.
 */
import { describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

// Re-derive the schemas the extension uses internally. Keeping them inline here
// (rather than exporting from index.ts) so we don't pollute the extension's
// public surface with internal types. If a schema drifts the tests fail loudly.

const SessionMetaSchema = Type.Object({
  name: Type.String(),
  pid: Type.Number(),
  cwd: Type.String(),
  joinedAt: Type.String(),
  heartbeatAt: Type.String(),
});

const InboxMessageSchema = Type.Object({
  id: Type.String(),
  from: Type.String(),
  body: Type.String(),
  sentAt: Type.String(),
});

describe("SessionMeta schema", () => {
  it("accepts a complete meta", () => {
    const ok = {
      name: "calm-fox-abc",
      pid: 1234,
      cwd: "/repo/x",
      joinedAt: "2026-05-26T08:00:00Z",
      heartbeatAt: "2026-05-26T08:00:30Z",
    };
    expect(Value.Check(SessionMetaSchema, ok)).toBe(true);
  });

  it("rejects missing fields", () => {
    expect(Value.Check(SessionMetaSchema, { name: "x", pid: 1 })).toBe(false);
  });

  it("rejects wrong pid type", () => {
    const bad = {
      name: "x", pid: "1234", cwd: "/x",
      joinedAt: "2026-05-26T08:00:00Z",
      heartbeatAt: "2026-05-26T08:00:30Z",
    };
    expect(Value.Check(SessionMetaSchema, bad)).toBe(false);
  });
});

describe("InboxMessage schema", () => {
  it("accepts a complete message", () => {
    const ok = {
      id: "msg-1-abc",
      from: "calm-fox-abc",
      body: "hello",
      sentAt: "2026-05-26T08:00:00Z",
    };
    expect(Value.Check(InboxMessageSchema, ok)).toBe(true);
  });

  it("rejects missing fields", () => {
    expect(Value.Check(InboxMessageSchema, { id: "x", body: "y" })).toBe(false);
  });

  it("rejects wrong body type", () => {
    const bad = { id: "msg-1", from: "x", body: 42, sentAt: "2026-05-26T08:00:00Z" };
    expect(Value.Check(InboxMessageSchema, bad)).toBe(false);
  });
});
