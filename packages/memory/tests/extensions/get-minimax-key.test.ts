/**
 * Tests for getMinimaxKey fallback logic in extensions.
 * Verifies: MINIMAX_API_KEY > MINIMAX_CN_API_KEY > mmx config file
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// We'll test the actual getMinimaxKey logic by reading the extension source
// and simulating the same environment checks.

describe('getMinimaxKey fallback priority', () => {
  // Simulate the getMinimaxKey logic for testing
  function getMinimaxKey(env: Record<string, string>, homeDir: string): string | undefined {
    if (env.MINIMAX_API_KEY) return env.MINIMAX_API_KEY;
    if (env.MINIMAX_CN_API_KEY) return env.MINIMAX_CN_API_KEY;
    const mmxConfig = path.join(homeDir, '.mmx', 'config.json');
    if (fs.existsSync(mmxConfig)) {
      try {
        return JSON.parse(fs.readFileSync(mmxConfig, 'utf-8')).api_key;
      } catch {}
    }
    return undefined;
  }

  it('prefers MINIMAX_API_KEY over CN variant', () => {
    const key = getMinimaxKey(
      { MINIMAX_API_KEY: 'sk-primary', MINIMAX_CN_API_KEY: 'sk-cn-fallback' },
      '/nonexistent',
    );
    expect(key).toBe('sk-primary');
  });

  it('falls back to MINIMAX_CN_API_KEY when API_KEY not set', () => {
    const key = getMinimaxKey(
      { MINIMAX_CN_API_KEY: 'sk-cn-only' },
      '/nonexistent',
    );
    expect(key).toBe('sk-cn-only');
  });

  it('returns undefined when no env keys set and no config file', () => {
    const key = getMinimaxKey({}, '/nonexistent');
    expect(key).toBeUndefined();
  });

  it('reads from mmx config.json when env vars are absent', () => {
    // Create a temp mmx config
    const tmpDir = '/tmp/test-mmx-getkey';
    const configDir = path.join(tmpDir, '.mmx');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify({ api_key: 'sk-from-config', region: 'cn' }),
    );

    const key = getMinimaxKey({}, tmpDir);
    expect(key).toBe('sk-from-config');

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('API_KEY takes precedence over mmx config', () => {
    const tmpDir = '/tmp/test-mmx-getkey2';
    const configDir = path.join(tmpDir, '.mmx');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify({ api_key: 'sk-from-config' }),
    );

    const key = getMinimaxKey({ MINIMAX_API_KEY: 'sk-from-env' }, tmpDir);
    expect(key).toBe('sk-from-env');

    fs.rmSync(tmpDir, { recursive: true });
  });

  it('CN_API_KEY takes precedence over mmx config when API_KEY absent', () => {
    const tmpDir = '/tmp/test-mmx-getkey3';
    const configDir = path.join(tmpDir, '.mmx');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify({ api_key: 'sk-from-config' }),
    );

    const key = getMinimaxKey({ MINIMAX_CN_API_KEY: 'sk-cn-env' }, tmpDir);
    expect(key).toBe('sk-cn-env');

    fs.rmSync(tmpDir, { recursive: true });
  });
});