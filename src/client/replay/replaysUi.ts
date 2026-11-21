import './replay.css';
import { decodeReplay } from '../../sim/replay/codec';
import { metaOf } from '../../sim/replay/format';
import { DEFAULT_CAP_BYTES, replayStore, type StoredMeta } from './store';
import { fmtTime } from './viewerUi';
import { unzip, zip } from './zip';

const EXT = '.faereplay';

function download(name: string, data: Uint8Array, type: string) {
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const fileName = (m: StoredMeta) => {
  const d = new Date(m.recordedAt);
  const p = (n: number) => String(n).padStart(2, '0');
  return `faefight-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}-${m.id.slice(0, 6)}${EXT}`;
};

/** Store a file the user picked (a .faereplay, or a .zip of them). Returns how many replays were added. */
export async function importFiles(files: File[]): Promise<number> {
  const store = await replayStore();
  let n = 0;
  for (const f of files) {
    const raw = new Uint8Array(await f.arrayBuffer());
    const entries = f.name.toLowerCase().endsWith('.zip') ? unzip(raw).filter((e) => e.name.endsWith(EXT)) : [{ name: f.name, data: raw }];
    for (const e of entries) {
      const r = await decodeReplay(e.data); // validates; throws a readable error for anything else
      await store.put(metaOf(r, e.data.length), e.data);
      n++;
    }
  }
  return n;
}

/**
 * The Replays screen: every recorded match in this browser, newest first, with play / export / delete,
 * export-all (zip) and import. `play` gets the bytes of the chosen replay.
 */
export function showReplays(app: HTMLElement, act: { play(bytes: Uint8Array, meta: StoredMeta): void; back(): void }): HTMLElement {
  const screen = document.createElement('div');
  screen.className = 'menu';
  screen.dataset.testid = 'replays-screen';
  const card = document.createElement('div');
  card.className = 'menu-card glass replays-card';
  const head = document.createElement('div');
  head.className = 'replays-head';
  const title = document.createElement('h2');
  title.textContent = 'Replays';
  const usage = document.createElement('div');
  usage.className = 'replays-usage';
  head.append(title, usage);

  const status = document.createElement('div');
  status.className = 'loading';
  status.dataset.testid = 'replays-status';
  const list = document.createElement('div');
  list.className = 'replays-list';
  list.dataset.testid = 'replays-list';

  const actions = document.createElement('div');
  actions.className = 'replays-actions';
  const mk = (text: string, testid: string, onClick: () => void, primary = false) => {
    const b = document.createElement('button');
    b.className = `btn small${primary ? ' primary' : ''}`;
    b.textContent = text;
    b.dataset.testid = testid;
    b.onclick = onClick;
    return b;
  };
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = `${EXT},.zip`;
  picker.multiple = true;
  picker.style.display = 'none';
  picker.dataset.testid = 'replays-import-input';
  picker.onchange = () => {
    const files = [...(picker.files ?? [])];
    picker.value = '';
    if (!files.length) return;
    status.textContent = 'Importing…';
    importFiles(files).then((n) => { status.textContent = `Imported ${n} replay${n === 1 ? '' : 's'}.`; return refresh(); },
      (err) => { console.error('[replays] import failed', err); status.textContent = `Import failed: ${err?.message ?? err}`; });
  };
  let rows: StoredMeta[] = [];
  const exportAll = mk('Export all', 'replays-export-all', async () => {
    try {
      const store = await replayStore();
      const files: { name: string; data: Uint8Array }[] = [];
      for (const m of rows) { const data = await store.get(m.id); if (data) files.push({ name: fileName(m), data }); }
      download(`faefight-replays-${files.length}.zip`, zip(files), 'application/zip');
    } catch (err) { console.error('[replays] export failed', err); status.textContent = `Export failed: ${(err as Error)?.message ?? err}`; }
  });
  actions.append(mk('Back', 'replays-back', act.back), mk('Import…', 'replays-import', () => picker.click()), exportAll, picker);

  card.append(head, actions, status, list);
  screen.append(card);
  app.append(screen);

  async function refresh() {
    const store = await replayStore();
    rows = await store.list();
    const total = rows.reduce((s, m) => s + m.size, 0);
    usage.textContent = `${rows.length} saved · ${(total / 1048576).toFixed(1)} of ${DEFAULT_CAP_BYTES / 1048576} MB`;
    exportAll.disabled = !rows.length;
    list.replaceChildren();
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'replays-empty';
      empty.textContent = 'No replays yet. Every match you play is saved here.';
      list.append(empty);
    }
    for (const m of rows) list.append(row(m));
  }

  function row(m: StoredMeta) {
    const r = document.createElement('div');
    r.className = 'replay-row-item';
    r.dataset.testid = 'replay-row';
    const when = new Date(m.recordedAt);
    const winner = m.players.find((p) => p.id === m.winner);
    const info = document.createElement('div');
    info.className = 'replay-info';
    const top = document.createElement('div');
    top.className = 'replay-title';
    top.textContent = `${when.toLocaleDateString()} ${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${m.mapName} · ${fmtTime(m.duration)}${m.kind === 'host' ? ' · online' : ''}`;
    const who = document.createElement('div');
    who.className = 'replay-players';
    for (const p of m.players) {
      const s = document.createElement('span');
      s.className = `replay-player${p.id === m.winner ? ' won' : ''}${p.id === m.localId ? ' me' : ''}`;
      s.textContent = p.name;
      who.append(s);
    }
    const res = document.createElement('div');
    res.className = 'replay-result';
    res.textContent = m.unfinished ? 'Unfinished' : winner ? `Winner: ${winner.name}` : 'No winner';
    info.append(top, who, res);
    const btns = document.createElement('div');
    btns.className = 'replay-btns';
    btns.append(
      mk('Play', 'replay-watch', async () => {
        const data = await (await replayStore()).get(m.id);
        if (!data) { status.textContent = 'That replay is gone.'; void refresh(); return; }
        act.play(data, m);
      }, true),
      mk('Export', 'replay-export', async () => {
        const data = await (await replayStore()).get(m.id);
        if (data) download(fileName(m), data, 'application/octet-stream');
      }),
      mk('Delete', 'replay-delete', async () => {
        if (!confirm(`Delete the replay from ${when.toLocaleString()}?`)) return;
        await (await replayStore()).delete(m.id);
        void refresh();
      }),
    );
    r.append(info, btns);
    return r;
  }

  refresh().catch((err) => {
    console.error('[replays] could not open storage', err);
    status.textContent = `Replays unavailable: ${err?.message ?? err}`;
  });
  return screen;
}
