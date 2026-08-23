import { apiGet, apiPost, ApiError } from '../api.js';
import { clear, formatTimestamp, h } from '../dom.js';
import { emptyState, errorState, loadingState } from '../components/asyncState.js';

interface LabelSessionRow {
  id: number;
  startedAt: string;
  endedAt: string | null;
  notes: string | null;
}

interface LabelRow {
  id: number;
  sessionId: number;
  time: string;
  occupancyCount: number;
  notes: string | null;
}

export function renderRecording(container: HTMLElement): () => void {
  let disposed = false;
  const root = h('div', { class: 'view-scroll' });
  container.append(root);

  const startNotes = h('input', { type: 'text', placeholder: 'e.g. "family home, TV on"' }) as HTMLInputElement;
  const message = h('div', { class: 'sub' }, '');
  const sessionsPanel = h('div', {});

  const annotateSession = h('select', { 'aria-label': 'Session to annotate' }) as HTMLSelectElement;
  const annotateCount = h('input', { type: 'number', min: '0', max: '255', value: '0' }) as HTMLInputElement;
  const annotateNotes = h('input', { type: 'text', placeholder: 'optional note' }) as HTMLInputElement;

  root.append(
    h(
      'div',
      { class: 'panel' },
      h('h2', {}, 'Start a labelled recording session'),
      h('p', { class: 'sub' }, 'Starts a ground-truth session. Overlay it on the Occupancy timeline view to compare the prediction against reality.'),
      h('div', { class: 'controls' }, h('label', {}, 'Notes', startNotes), h('button', { onclick: () => void startSession() }, 'Start session')),
      message,
    ),
    h(
      'div',
      { class: 'panel' },
      h('h2', {}, 'Annotate an interval with a ground-truth count'),
      h(
        'div',
        { class: 'controls' },
        h('label', {}, 'Session', annotateSession),
        h('label', {}, 'Occupancy count', annotateCount),
        h('label', {}, 'Notes', annotateNotes),
        h('button', { onclick: () => void addLabel() }, 'Add label'),
        h('button', { onclick: () => void stopSelected() }, 'Stop this session'),
      ),
    ),
    sessionsPanel,
  );
  sessionsPanel.append(loadingState('Loading sessions…'));

  async function startSession(): Promise<void> {
    try {
      await apiPost('/api/labels/sessions', { notes: startNotes.value || undefined });
      startNotes.value = '';
      message.textContent = 'Session started.';
      await refresh();
    } catch (err) {
      message.textContent = err instanceof ApiError ? err.message : String(err);
    }
  }

  async function addLabel(): Promise<void> {
    const sessionId = Number(annotateSession.value);
    if (!sessionId) {
      message.textContent = 'Select a session first.';
      return;
    }
    try {
      await apiPost('/api/labels', {
        sessionId,
        occupancyCount: Number(annotateCount.value),
        notes: annotateNotes.value || undefined,
      });
      annotateNotes.value = '';
      message.textContent = 'Label recorded.';
      await refresh();
    } catch (err) {
      message.textContent = err instanceof ApiError ? err.message : String(err);
    }
  }

  async function stopSelected(): Promise<void> {
    const sessionId = Number(annotateSession.value);
    if (!sessionId) {
      message.textContent = 'Select a session first.';
      return;
    }
    try {
      const res = await apiPost<{ session: unknown; preservationWarning?: string }>(`/api/labels/sessions/${sessionId}/stop`);
      message.textContent = res.preservationWarning ?? 'Session stopped.';
      await refresh();
    } catch (err) {
      message.textContent = err instanceof ApiError ? err.message : String(err);
    }
  }

  async function refresh(): Promise<void> {
    let sessions: LabelSessionRow[];
    try {
      const res = await apiGet<{ sessions: LabelSessionRow[] }>('/api/labels/sessions?limit=100');
      sessions = res.sessions;
    } catch (err) {
      if (disposed) return;
      clear(sessionsPanel);
      sessionsPanel.append(errorState(err instanceof ApiError ? err.message : String(err)));
      return;
    }
    if (disposed) return;

    const prevSelection = annotateSession.value;
    clear(annotateSession);
    annotateSession.append(...sessions.map((s) => h('option', { value: String(s.id) }, `#${s.id} — ${formatTimestamp(s.startedAt)}${s.endedAt ? ' (stopped)' : ' (running)'}`)));
    if (prevSelection && sessions.some((s) => String(s.id) === prevSelection)) annotateSession.value = prevSelection;

    clear(sessionsPanel);
    sessionsPanel.append(h('h2', { class: 'panel-title' }, 'Sessions'));
    if (sessions.length === 0) {
      sessionsPanel.append(emptyState('No recording sessions yet.'));
      return;
    }

    const labelsBySession = await Promise.all(
      sessions.map((s) => apiGet<{ labels: LabelRow[] }>(`/api/labels/sessions/${s.id}/labels?limit=200`).catch(() => ({ labels: [] as LabelRow[] }))),
    );

    sessionsPanel.append(
      h(
        'div',
        { class: 'panel' },
        ...sessions.map((s, i) =>
          h(
            'div',
            {},
            h('h2', {}, `#${s.id} ${s.endedAt ? '(stopped)' : '(running)'}`),
            h('p', { class: 'sub' }, `started ${formatTimestamp(s.startedAt)}${s.endedAt ? `, ended ${formatTimestamp(s.endedAt)}` : ''}${s.notes ? ` — ${s.notes}` : ''}`),
            (labelsBySession[i]?.labels.length ?? 0) === 0
              ? emptyState('no labels recorded for this session yet')
              : h(
                  'table',
                  {},
                  h('thead', {}, h('tr', {}, h('th', {}, 'Time'), h('th', {}, 'Count'), h('th', {}, 'Notes'))),
                  h('tbody', {}, ...(labelsBySession[i]?.labels ?? []).map((l) => h('tr', {}, h('td', {}, formatTimestamp(l.time)), h('td', {}, String(l.occupancyCount)), h('td', {}, l.notes ?? '')))),
                ),
          ),
        ),
      ),
    );
  }

  void refresh();

  return () => {
    disposed = true;
  };
}
