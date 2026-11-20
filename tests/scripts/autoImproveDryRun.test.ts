import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../../scripts/auto-improve';
import { recordHeadlessMatch } from '../../src/sim/replay/headless';

describe('pnpm auto-improve --dry-run against a local fake blob dir', () => {
  it('downloads new replays and error reports, re-simulates them, writes nothing to the repo', async () => {
    const blob = fs.mkdtempSync(path.join(os.tmpdir(), 'faefight-blob-'));
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'faefight-state-'));
    const rec = await recordHeadlessMatch({ players: [{ name: 'A', isBot: true, difficulty: 'hard' }, { name: 'B', isBot: true, difficulty: 'hard' }] }, 3, 240);
    fs.mkdirSync(path.join(blob, 'replays/2026-11-20'), { recursive: true });
    fs.writeFileSync(path.join(blob, 'replays/2026-11-20/r1.faereplay'), rec.bytes);
    fs.mkdirSync(path.join(blob, 'errors/2026-11-20'), { recursive: true });
    fs.writeFileSync(path.join(blob, 'errors/2026-11-20/e1.json'), JSON.stringify({ receivedAt: '2026-11-20T01:00:00Z', reports: [{ build: 'b', kind: 'error', message: 'boom', count: 2 }] }));

    const repo = path.resolve(__dirname, '../..');
    const before = fs.readFileSync(path.join(repo, 'src/sim/bots/trained-params.json'), 'utf8');
    const r = await main(['--dry-run', '--source', blob, '--state-dir', state, '--repo', repo]);

    expect(r.outcome).toBe('dry-run');
    if (r.outcome !== 'dry-run') return;
    expect(r.newReplays).toBe(1);
    expect(r.newErrors).toBe(1);
    expect(r.analysis.replays).toBe(1);
    expect(r.analysis.findings).toEqual([]); // a clean bot match re-simulates without invariant violations
    expect(fs.existsSync(path.join(state, 'cache/replays/2026-11-20/r1.faereplay'))).toBe(true);
    expect(fs.readdirSync(path.join(state, 'logs')).some((f) => f.endsWith('-dry.log'))).toBe(true);
    // Dry run: no state advance (the real run still sees these), no lock left behind, champion untouched.
    expect(fs.existsSync(path.join(state, 'state.json'))).toBe(false);
    expect(fs.existsSync(path.join(state, 'lock'))).toBe(false);
    expect(fs.readFileSync(path.join(repo, 'src/sim/bots/trained-params.json'), 'utf8')).toBe(before);
  }, 120_000);
});
