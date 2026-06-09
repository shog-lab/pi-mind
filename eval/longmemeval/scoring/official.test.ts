/**
 * Unit + integration tests for the official LongMemEval wrapper.
 *
 * Two layers:
 *   1. Pure-function tests for parseOfficialStdout + findOfficialResultFile
 *      + split → filename mapping. No filesystem / subprocess work.
 *   2. A fake-official-evaluator integration test that points
 *      `pythonBin` at a bash script emitting the exact stdout format
 *      upstream uses (per-category lines with trailing `(<count>)`).
 *      Verifies: overall parsed, perCategory populated,
 *      official-eval-results.json copied, official-score.json written,
 *      the result file path is `<run>/hypothesis.jsonl.eval-results-<model>`.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findOfficialResultFile, parseOfficialStdout, runOfficialScoring } from "./official.js";
import { getCachedPath } from "../datasets/longmemeval-download.js";

describe("parseOfficialStdout", () => {
  it("parses overall + per-category on the canonical upstream format", () => {
    const stdout = [
      "Loading questions...",
      "temporal-reasoning: 0.25 (2)",
      "multi-session: 0.50 (2)",
      "single-session-user: 1.00 (1)",
      "Overall accuracy: 0.5000 (5)",
    ].join("\n");
    const { overall, perCategory } = parseOfficialStdout(stdout);
    expect(overall).toBeCloseTo(0.5, 5);
    expect(perCategory).toEqual({
      "temporal-reasoning": 0.25,
      "multi-session": 0.5,
      "single-session-user": 1.0,
    });
  });

  it("accepts tab-indented per-category lines", () => {
    const stdout = [
      "\ttemporal-reasoning: 0.25 (2)",
      "\tmulti-session: 0.50 (2)",
      "Accuracy: 0.5",
    ].join("\n");
    const { overall, perCategory } = parseOfficialStdout(stdout);
    expect(overall).toBeCloseTo(0.5);
    expect(perCategory["temporal-reasoning"]).toBe(0.25);
    expect(perCategory["multi-session"]).toBe(0.5);
  });

  it("ignores 'overall' and 'accuracy' as category names (those are summary lines)", () => {
    const stdout = "overall: 0.5\naccuracy: 0.5\nreal-category: 0.7 (3)\n";
    const { overall, perCategory } = parseOfficialStdout(stdout);
    expect(overall).toBeCloseTo(0.5);
    expect(Object.keys(perCategory)).toEqual(["real-category"]);
  });

  it("first occurrence wins on duplicate categories (defensive)", () => {
    const stdout = "temporal-reasoning: 0.30 (1)\ntemporal-reasoning: 0.99 (1)\n";
    const { perCategory } = parseOfficialStdout(stdout);
    expect(perCategory["temporal-reasoning"]).toBeCloseTo(0.3, 5);
  });

  it("returns null overall when no accuracy line is present", () => {
    const { overall, perCategory } = parseOfficialStdout("nothing parseable here");
    expect(overall).toBeNull();
    expect(perCategory).toEqual({});
  });
});

describe("findOfficialResultFile", () => {
  it("returns <hypothesis>.eval-results-<model>", () => {
    expect(findOfficialResultFile("/tmp/run/hypothesis.jsonl", "gpt-4o"))
      .toBe("/tmp/run/hypothesis.jsonl.eval-results-gpt-4o");
  });

  it("handles paths with no directory", () => {
    expect(findOfficialResultFile("hypothesis.jsonl", "gpt-4o-mini"))
      .toBe("hypothesis.jsonl.eval-results-gpt-4o-mini");
  });
});

describe("getCachedPath split → filename mapping", () => {
  // Critical regression test: split s/m used to break because we built
  // the path as `longmemeval_${split}.json`; the actual cached files
  // are longmemeval_s_cleaned.json / longmemeval_m_cleaned.json.
  it("oracle → longmemeval_oracle.json", () => {
    expect(getCachedPath("oracle")).toMatch(/longmemeval_oracle\.json$/);
  });
  it("s → longmemeval_s_cleaned.json", () => {
    expect(getCachedPath("s")).toMatch(/longmemeval_s_cleaned\.json$/);
  });
  it("m → longmemeval_m_cleaned.json", () => {
    expect(getCachedPath("m")).toMatch(/longmemeval_m_cleaned\.json$/);
  });
});

describe("runOfficialScoring — fake-evaluator integration", () => {
  let tmp: string;
  let fakeRepo: string;
  let fakePython: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "official-fake-"));
    fakeRepo = mkdtempSync(join(tmpdir(), "official-repo-"));
    fakePython = join(tmp, "fake-evaluator.py");

    // Lay out a fake LongMemEval repo: src/evaluation/evaluate_qa.py
    mkdirSync(join(fakeRepo, "src", "evaluation"), { recursive: true });
    writeFileSync(
      join(fakeRepo, "src", "evaluation", "evaluate_qa.py"),
      "#!/usr/bin/env python3\n" +
      "import json, os, sys\n" +
      "model = sys.argv[1]\n" +
      "hyp_path = sys.argv[2]\n" +
      "split_path = sys.argv[3]\n" +
      "with open(hyp_path) as f:\n" +
      "    hyps = [json.loads(l) for l in f if l.strip()]\n" +
      "# 1:1 ground truth for limit-2 smoke\n" +
      "truth = {\n" +
      "  'gpt4_2655b836': 'GPS system not functioning correctly',\n" +
      "  'gpt4_2487a7cb': 'GPU fan noise',\n" +
      "}\n" +
      "correct = 0\n" +
      "total = 0\n" +
      "for h in hyps:\n" +
      "    if h['hypothesis'] == truth.get(h['question_id']):\n" +
      "        correct += 1\n" +
      "    total += 1\n" +
      "print('temporal-reasoning: %.2f (%d)' % (correct/total, total))\n" +
      "print('Overall accuracy: %.4f (%d)' % (correct/total, total))\n" +
      "out = hyp_path + '.eval-results-' + model\n" +
      "with open(out, 'w') as f:\n" +
      "    json.dump({'correct': correct, 'total': total, 'per_q': []}, f)\n" +
      "sys.exit(0)\n",
    );
    chmodSync(join(fakeRepo, "src", "evaluation", "evaluate_qa.py"), 0o755);

    // Lay out a fake split JSON file the wrapper expects.
    const cacheDir = join(tmp, "cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "longmemeval_oracle.json"), "[]");

    // Lay out a hypothesis.jsonl in the run dir.
    mkdirSync(join(tmp, "run"), { recursive: true });
    writeFileSync(
      join(tmp, "run", "hypothesis.jsonl"),
      [
        JSON.stringify({ question_id: "gpt4_2655b836", hypothesis: "GPS system not functioning correctly" }),
        JSON.stringify({ question_id: "gpt4_2487a7cb", hypothesis: "GPU fan noise" }),
      ].join("\n") + "\n",
    );

    // Wire `pythonBin` to the system python; we'll let the official
    // wrapper's spawn call land on the real python3, which in turn
    // reads the shebang `#!/usr/bin/env python3` from evaluate_qa.py
    // — no, that doesn't work because spawn uses pythonBin directly,
    // not the shebang. Instead, set pythonBin to a tiny shell wrapper.
    const wrapper = join(tmp, "fake-py.sh");
    writeFileSync(wrapper, "#!/bin/sh\nexec /usr/bin/env python3 \"$@\"\n");
    chmodSync(wrapper, 0o755);
    fakePython = wrapper;
  });

  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
    try { rmSync(fakeRepo, { recursive: true, force: true }); } catch {}
  });

  it("parses perCategory, copies result file from <hyp>.eval-results-<model>, writes official-score.json", () => {
    const runDir = join(tmp, "run");
    const score = runOfficialScoring({
      runDir,
      officialRepoPath: fakeRepo,
      split: "oracle",
      splitCacheDir: join(tmp, "cache"),
      judgeModel: "gpt-4o-mini",
      pythonBin: fakePython,
    });
    expect(score.overall).toBeCloseTo(1.0, 4);
    expect(score.perCategory).toEqual({ "temporal-reasoning": 1.0 });
    // The upstream script wrote <run>/hypothesis.jsonl.eval-results-gpt-4o-mini
    // (path = hyp_path + ".eval-results-" + model). The wrapper must
    // have copied it to official-eval-results.json.
    expect(score.evalResultsFile).toBe(join(runDir, "official-eval-results.json"));
    expect(existsSync(score.evalResultsFile!)).toBe(true);
    const copied = JSON.parse(readFileSync(score.evalResultsFile!, "utf-8"));
    expect(copied.correct).toBe(2);
    expect(copied.total).toBe(2);

    // official-score.json should also exist with the parsed fields.
    const scorePath = join(runDir, "official-score.json");
    expect(existsSync(scorePath)).toBe(true);
    const summary = JSON.parse(readFileSync(scorePath, "utf-8"));
    expect(summary.exitOk).toBe(true);
    expect(summary.overall).toBeCloseTo(1.0, 4);
    expect(summary.perCategory["temporal-reasoning"]).toBe(1.0);
    expect(summary.evalResultsFile).toBe(score.evalResultsFile);
  });

  it("fails gracefully when the repo is missing, and still writes official-score.json with reasons", () => {
    const runDir = join(tmp, "run");
    const score = runOfficialScoring({
      runDir,
      officialRepoPath: "/nonexistent/longmemeval/repo",
      split: "oracle",
      splitCacheDir: join(tmp, "cache"),
      judgeModel: "gpt-4o-mini",
      pythonBin: fakePython,
    });
    expect(score.overall).toBeNull();
    expect(score.perCategory).toEqual({});
    expect(score.stderr).toMatch(/official evaluator not found/);
    // Graceful-failure summary still written.
    const scorePath = join(runDir, "official-score.json");
    expect(existsSync(scorePath)).toBe(true);
    const summary = JSON.parse(readFileSync(scorePath, "utf-8"));
    expect(summary.exitOk).toBe(false);
    expect(summary.overall).toBeNull();
  });
});
