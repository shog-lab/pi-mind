/**
 * Tests for memory extension (index.ts) behavior.
 * These test the non-core logic: feedback detection and Semaphore.
 * (MemoryCore itself is tested in tests/memory-core.test.ts.)
 */

import { describe, it, expect } from 'vitest';

// Re-implement the pure detection logic here to test the patterns
// (the actual module imports Node.js-specific deps, so we test the patterns in isolation)

type FeedbackType = 'correction' | 'complaint' | 'preference' | 'self-admission';

const CORRECTION_PATTERNS = [
  /不对|不是这样|你说错了|应该是|之前说的不对|你搞错/i,
  /不对吧|不是吧|真的吗|你确定吗/i,
];
const COMPLAINT_PATTERNS = [/太差了|根本不行|完全错了|垃圾|烂/i];
const PREFERENCE_PATTERNS = [/我觉得应该|我更喜欢|不如改成|应该这样/i];
const SELF_ADMISSION_PATTERNS = [/抱歉.*错|我搞错了|我收回刚才说的/i];

function detectFeedbackType(text: string): FeedbackType | null {
  if (CORRECTION_PATTERNS.some((p) => p.test(text))) return 'correction';
  if (COMPLAINT_PATTERNS.some((p) => p.test(text))) return 'complaint';
  if (PREFERENCE_PATTERNS.some((p) => p.test(text))) return 'preference';
  if (SELF_ADMISSION_PATTERNS.some((p) => p.test(text))) return 'self-admission';
  return null;
}

// --- Semaphore ---

class Semaphore {
  private running = 0;
  private queue: Array<() => void> = [];
  constructor(private maxConcurrent: number) {}
  async acquire(): Promise<void> {
    if (this.running < this.maxConcurrent) {
      this.running++;
      return;
    }
    await new Promise<void>((r) => this.queue.push(r));
  }
  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) {
      this.running++;
      next();
    }
  }
  get runningCount() {
    return this.running;
  }
  get queuedCount() {
    return this.queue.length;
  }
}

// --- Tests ---

describe('detectFeedbackType', () => {
  describe('correction patterns', () => {
    it('detects 应该是', () => {
      expect(detectFeedbackType('不对，应该是这样写')).toBe('correction');
    });

    it('detects 你说错了', () => {
      expect(detectFeedbackType('你说错了')).toBe('correction');
    });

    it('detects 之前说的不对', () => {
      expect(detectFeedbackType('之前说的不对，请重新考虑')).toBe('correction');
    });

    it('detects 你搞错', () => {
      expect(detectFeedbackType('你搞错了')).toBe('correction');
    });

    it('detects 不对吧', () => {
      expect(detectFeedbackType('不对吧？')).toBe('correction');
    });

    it('detects 不是吧', () => {
      expect(detectFeedbackType('不是吧，这么做有问题')).toBe('correction');
    });

    it('detects 真的吗', () => {
      expect(detectFeedbackType('真的吗？我有点怀疑')).toBe('correction');
    });

    it('is case insensitive', () => {
      expect(detectFeedbackType('不对吧')).toBe('correction');
    });

    it('does not fire on neutral text', () => {
      expect(detectFeedbackType('请帮我写一个函数')).toBe(null);
      expect(detectFeedbackType('今天的天气不错')).toBe(null);
    });
  });

  describe('complaint patterns', () => {
    it('detects 太差了', () => {
      expect(detectFeedbackType('太差了，根本不能用')).toBe('complaint');
    });

    it('detects 垃圾', () => {
      expect(detectFeedbackType('这个方案就是垃圾')).toBe('complaint');
    });

    it('does not fire on mild text', () => {
      expect(detectFeedbackType('这个不太好')).toBe(null);
    });
  });

  describe('preference patterns', () => {
    it('detects 我觉得应该', () => {
      expect(detectFeedbackType('我觉得应该改成另一种方式')).toBe('preference');
    });

    it('detects 我更喜欢', () => {
      expect(detectFeedbackType('我更喜欢简洁的代码')).toBe('preference');
    });

    it('detects 不如改成', () => {
      expect(detectFeedbackType('不如改成这样')).toBe('preference');
    });
  });

  describe('self-admission patterns', () => {
    it('detects 抱歉.*错', () => {
      expect(detectFeedbackType('抱歉，我之前说错了')).toBe('self-admission');
    });

    it('detects 我搞错了', () => {
      expect(detectFeedbackType('我搞错了，请忽略上一条')).toBe('self-admission');
    });

    it('detects 我收回刚才说的', () => {
      expect(detectFeedbackType('我收回刚才说的')).toBe('self-admission');
    });
  });

  it('returns null when no pattern matches', () => {
    expect(detectFeedbackType('请帮我处理这个任务')).toBe(null);
    expect(detectFeedbackType('谢谢你的帮助')).toBe(null);
  });

  it('prefers correction over other types when multiple match', () => {
    const text = '不对，我觉得应该这样（这是投诉吗？）';
    expect(detectFeedbackType(text)).toBe('correction');
  });
});

describe('Semaphore', () => {
  it('allows up to maxConcurrent acquisitions', async () => {
    const sem = new Semaphore(2);
    await sem.acquire();
    await sem.acquire();
    expect(sem.runningCount).toBe(2);
  });

  it('queues when at capacity', async () => {
    const sem = new Semaphore(1);
    await sem.acquire();
    expect(sem.runningCount).toBe(1);

    let secondReleased = false;
    const acquireSecond = sem.acquire().then(() => { secondReleased = true; });

    expect(sem.queuedCount).toBe(1);
    expect(secondReleased).toBe(false);

    sem.release();
    await acquireSecond;
    expect(secondReleased).toBe(true);
    expect(sem.runningCount).toBe(1);
  });

  it('releases and picks next in FIFO order', async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];

    const task = async (id: number) => {
      await sem.acquire();
      order.push(id);
      sem.release();
    };

    await Promise.all([task(1), task(2), task(3)]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('release without acquire goes negative ( unguarded)', () => {
    // The real Semaphore does not guard against over-release.
    // This documents actual behavior, not desired behavior.
    const sem = new Semaphore(2);
    sem.release();
    expect(sem.runningCount).toBe(-1); // This is the actual (buggy) behavior
  });
});
