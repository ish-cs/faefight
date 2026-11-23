import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { loadParamsFile, paramsFromJson } from '../../scripts/ci/measure';
import { Bot } from '../../src/sim/bots/bot';
import { DEFAULT_BOT_PARAMS, type BotParams } from '../../src/sim/bots/params';

// bot-measure --params: a params file from CI must turn into the BotParams a Bot takes (it used to call a sanitize()
// export that main's params.ts doesn't have: "mod.sanitize is not a function").
describe('bot-measure params loading', () => {
  const write = (json: unknown) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'measure-params-'));
    const file = path.join(dir, 'params.json');
    fs.writeFileSync(file, JSON.stringify(json));
    return file;
  };

  test('a { params: {...} } file loads as BotParams with the overrides applied, and a Bot plays with it', async () => {
    const file = write({ note: 'sample', params: { 'drive.push.pro': 0.5, 'buildTuning.coverScore': 1.2 } });
    const p = (await loadParamsFile(file)) as BotParams;
    expect(p.drive.push.pro).toBe(0.5);
    expect(p.buildTuning.coverScore).toBe(1.2);
    expect(p.drive.push.hard).toBe(DEFAULT_BOT_PARAMS.drive.push.hard);
    const bot = new Bot(1, 'pro', () => 0.5, undefined, p);
    expect((bot as unknown as { P: BotParams }).P).toBe(p);
  });

  test('a bare flat map loads too', async () => {
    const p = (await loadParamsFile(write({ 'drive.push.pro': 0.3 }))) as BotParams;
    expect(p.drive.push.pro).toBe(0.3);
  });

  test('typos, non-numbers and a params.ts with no loader fail loudly', async () => {
    await expect(loadParamsFile(write({ params: { 'drive.pushh.pro': 1 } }))).rejects.toThrow(/unknown/);
    await expect(loadParamsFile(write({ params: { 'drive.push.pro': 'x' } }))).rejects.toThrow(/not a number/);
    expect(() => paramsFromJson({}, { params: {} })).toThrow(/neither withParams nor sanitize/);
  });

  test('a trainer-style params.ts (sanitize + toBotParams) is used when present', () => {
    const calls: string[] = [];
    const out = paramsFromJson({
      sanitize: (f) => { calls.push('sanitize'); return { ...f, clamped: 1 }; },
      toBotParams: (f) => { calls.push('toBotParams'); return f; },
      withParams: () => { calls.push('withParams'); return null; },
    }, { params: { a: 2 } });
    expect(calls).toEqual(['sanitize', 'toBotParams']);
    expect(out).toEqual({ a: 2, clamped: 1 });
  });
});
