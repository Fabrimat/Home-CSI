import { apiGet, ApiError } from '../api.js';
import { clear, h } from '../dom.js';
import { emptyState, errorState, loadingState } from '../components/asyncState.js';

interface LogEntry {
  time: string;
  level: string;
  msg: string;
  [extra: string]: unknown;
}

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
const POLL_INTERVAL_MS = 4000;

export function renderLogs(container: HTMLElement): () => void {
  let disposed = false;
  const root = h('div', { class: 'view-scroll panel' });
  container.append(root);

  const levelSelect = h('select', { 'aria-label': 'Minimum level' }) as HTMLSelectElement;
  levelSelect.append(h('option', { value: '' }, 'all levels'), ...LEVELS.map((l) => h('option', { value: l }, l)));
  const linesArea = h('div', {});
  linesArea.append(loadingState('Loading log tail…'));

  root.append(h('h2', {}, 'Log tail'), h('div', { class: 'controls' }, h('label', {}, 'Level', levelSelect)), linesArea);

  // See the identical comment in views/overview.ts: this view also polls
  // (POLL_INTERVAL_MS), so an unchanged error must not re-announce on every
  // tick. Reset on every successful fetch so recovery renders real content
  // and a later, distinct recurrence of the same message announces again.
  let lastErrorMessage: string | null = null;

  async function load(): Promise<void> {
    const level = levelSelect.value;
    try {
      const res = await apiGet<{ lines: LogEntry[] }>(`/api/logs${level ? `?level=${level}&limit=500` : '?limit=500'}`);
      if (disposed) return;
      lastErrorMessage = null;
      clear(linesArea);
      if (res.lines.length === 0) {
        linesArea.append(emptyState('No log lines captured yet (this process\'s in-memory tail is empty).'));
        return;
      }
      for (const line of res.lines) {
        linesArea.append(
          h('div', { class: `log-line level-${line.level}` }, `[${line.time}] ${line.level.toUpperCase().padEnd(5)} ${line.msg}`),
        );
      }
    } catch (err) {
      if (disposed) return;
      const message = err instanceof ApiError ? err.message : String(err);
      if (message === lastErrorMessage) return;
      lastErrorMessage = message;
      clear(linesArea);
      linesArea.append(errorState(message));
    }
  }

  levelSelect.addEventListener('change', () => void load());
  void load();
  const timer = setInterval(() => void load(), POLL_INTERVAL_MS);

  return () => {
    disposed = true;
    clearInterval(timer);
  };
}
