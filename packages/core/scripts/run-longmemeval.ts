#!/usr/bin/env npx tsx
/**
 * LongMemEval Benchmark Runner for ShogAgent Memory System
 *
 * Uses MemoryCore from extensions/memory/core.ts —
 * the SAME code that runs in production containers.
 *
 * Usage:
 *   DEEPSEEK_API_KEY=xxx npx tsx scripts/run-longmemeval.ts [--limit N] [--max-tokens N]
 */

import fs from 'fs';
import path from 'path';

const { MemoryCore } = await import(path.resolve(import.meta.dirname!, '..', 'container', 'extensions', 'memory', 'core.ts')) as { MemoryCore: any };

// --- Config ---

const DATA_PATH = '/tmp/LongMemEval/data/longmemeval_oracle.json';
const RESULTS_DIR = path.join(process.cwd(), 'results');
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';
const MODEL = 'deepseek-chat';

const limitArg = process.argv.find(a => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : 500;

const tokenArg = process.argv.find(a => a.startsWith('--max-tokens='));
const MAX_TOKENS = tokenArg ? parseInt(tokenArg.split('=')[1], 10) : 16000;

// --- DeepSeek API ---

async function callDeepSeek(
  messages: Array<{ role: string; content: string }>,
  maxTokens: number = 200,
): Promise<string> {
  const resp = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages, max_tokens: maxTokens, temperature: 0 }),
  });
  if (!resp.ok) throw new Error(`DeepSeek API error ${resp.status}: ${await resp.text()}`);
  const data = await resp.json() as any;
  return data.choices?.[0]?.message?.content || '';
}

// --- LongMemEval ---

interface EvalQuestion {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  question_date: string;
  haystack_session_ids: string[];
  haystack_dates: string[];
  haystack_sessions: Array<Array<{ role: string; content: string }>>;
}

async function answerQuestion(mem: InstanceType<typeof MemoryCore>, question: string): Promise<string> {
  const context = await mem.buildContext(question);
  const systemPrompt = context
    ? `You are a helpful assistant. Use the following memories to answer the user's question. Answer concisely and directly.\n\n${context}`
    : 'You are a helpful assistant. Answer concisely.';
  return callDeepSeek([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: question },
  ]);
}

async function evaluateAnswer(question: string, expected: string, hypothesis: string): Promise<{ label: number; reason: string }> {
  const response = await callDeepSeek([{ role: 'user', content:
    `You are an evaluator. Given a question, the expected answer, and the model's answer, determine if the model's answer is correct.

Question: ${question}
Expected Answer: ${expected}
Model's Answer: ${hypothesis}

Is the model's answer correct? It doesn't need to match exactly, but must convey the same key information.
Reply with ONLY a JSON object: {"label": 1, "reason": "..."} if correct, {"label": 0, "reason": "..."} if incorrect.` }], 200);
  try {
    const m = response.match(/\{[^}]+\}/);
    if (m) return JSON.parse(m[0]);
  } catch {}
  return { label: 0, reason: 'Failed to parse eval' };
}

async function main() {
  if (!DEEPSEEK_API_KEY) { console.error('Set DEEPSEEK_API_KEY'); process.exit(1); }

  console.log('Loading LongMemEval dataset...');
  const dataset: EvalQuestion[] = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
  console.log(`Total: ${dataset.length}, running: ${LIMIT}, max_tokens: ${MAX_TOKENS}`);

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const resultsPath = path.join(RESULTS_DIR, 'longmemeval-results.jsonl');
  const stream = fs.createWriteStream(resultsPath, { flags: 'w' });

  const workDir = '/tmp/longmemeval-workdir';
  let correct = 0, total = 0;
  const byType: Record<string, { correct: number; total: number }> = {};

  for (let i = 0; i < Math.min(LIMIT, dataset.length); i++) {
    const q = dataset[i];
    total++;

    const mem = new MemoryCore({
      groupDir: workDir,
      dbPath: path.join(workDir, '.pi-mind-index.db'),
      maxInjectTokens: MAX_TOKENS,
      freshDb: true,
      ollamaUrl: 'http://localhost:11434',
    });

    // Store sessions as wiki/ files + index
    for (let j = 0; j < q.haystack_sessions.length; j++) {
      const content = q.haystack_sessions[j].map(t => `${t.role}: ${t.content}`).join('\n\n');
      const wikiDir = path.join(workDir, 'wiki');
      fs.mkdirSync(wikiDir, { recursive: true });
      const fp = path.join(wikiDir, `session-${q.haystack_session_ids[j]}.md`);
      const raw = `---\ndate: ${q.haystack_dates[j]}\ntype: note\ntags: [conversation]\n---\n\n${content}`;
      fs.writeFileSync(fp, raw);
    }
    mem.syncIndex();

    let hypothesis: string;
    try { hypothesis = await answerQuestion(mem, q.question); }
    catch (err) { hypothesis = `Error: ${err}`; }

    let evalResult: { label: number; reason: string };
    try { evalResult = await evaluateAnswer(q.question, q.answer, hypothesis); }
    catch (err) { evalResult = { label: 0, reason: `Eval error: ${err}` }; }

    if (evalResult.label === 1) correct++;
    const qType = q.question_type;
    if (!byType[qType]) byType[qType] = { correct: 0, total: 0 };
    byType[qType].total++;
    if (evalResult.label === 1) byType[qType].correct++;

    stream.write(JSON.stringify({
      question_id: q.question_id, question_type: qType,
      question: q.question, expected: q.answer,
      hypothesis, label: evalResult.label, reason: evalResult.reason,
    }) + '\n');

    console.log(`[${total}/${LIMIT}] ${evalResult.label ? '✓' : '✗'} (${((correct/total)*100).toFixed(1)}%) ${qType}: ${q.question.slice(0,60)}...`);

    mem.cleanup();
    await new Promise(r => setTimeout(r, 500));
  }

  stream.end();
  console.log(`\n=== Results ===\nOverall: ${correct}/${total} = ${((correct/total)*100).toFixed(1)}%\n\nBy type:`);
  for (const [type, s] of Object.entries(byType)) console.log(`  ${type}: ${s.correct}/${s.total} = ${((s.correct/s.total)*100).toFixed(1)}%`);
  console.log(`\nSaved to: ${resultsPath}`);
}

main().catch(console.error);
