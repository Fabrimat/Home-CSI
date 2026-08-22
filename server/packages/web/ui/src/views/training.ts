import { apiGet, apiPatch, apiPost, ApiError } from '../api.js';
import { clear, h } from '../dom.js';

/**
 * Guided live-walkthrough training mode (docs/roadmap.md "Training mode for
 * cold-start bootstrap", brief B14) -- produces the very first labelled
 * corpus before any trained model exists, by having the operator declare
 * ground truth as they walk through the house.
 *
 * This is deliberately a *separate* tool from `views/recording.ts` (the
 * point-in-time correction/annotation controls), not a superset of it --
 * see this view's own intro text for the one-line pointer between the two.
 */

interface LabelSessionRow {
  id: number;
  startedAt: string;
  endedAt: string | null;
  notes: string | null;
}

/** `labels.source` (migration 008) -- this view only ever reads/writes `'training'`. */
type LabelSource = 'manual' | 'weak:phone-presence' | 'confirmed' | 'training';

interface LabelRow {
  id: number;
  sessionId: number;
  time: string;
  endTime: string | null;
  occupancyCount: number;
  source: LabelSource;
  notes: string | null;
}

/** The coarse occupancy STATE this view declares -- never a people count (see `docs/architecture.md` "Motion, not people"). */
type DeclaredState = 0 | 1 | 2;

const STATE_LABELS: Record<DeclaredState, string> = {
  0: 'House empty',
  1: 'Just me',
  2: 'Two or more of us',
};

const STATE_BUTTON_LABELS: Record<DeclaredState, string> = {
  0: '0',
  1: '1',
  2: '2+',
};

type MotionTag = '' | 'still' | 'moving';

/**
 * Marks `label_sessions.notes` as created by this view, so re-entering the
 * training view can find an already-open training session to resume
 * (`findOpenTrainingSession`) instead of orphaning it.
 *
 * Deliberately NOT `WEAK_LABEL_PREFIX` (`'[weak:phone-presence]'`,
 * `@homecsi/labeling/src/sessions.ts`) and never allowed to start with it:
 * `trainingPreservation.ts`'s `preserveSessionFeatures` skips raw per-link
 * feature preservation for any weak-flagged session, so a weak-prefixed
 * training session's underlying features would silently evaporate once the
 * 7-day `features` retention window passes -- poisoning exactly the corpus
 * this mode exists to build.
 */
const TRAINING_MARKER = '[training]';

function isTrainingSession(notes: string | null): boolean {
  return notes !== null && notes.startsWith(TRAINING_MARKER);
}

function composeSessionNotes(operatorNotes: string): string {
  const trimmed = operatorNotes.trim();
  return trimmed ? `${TRAINING_MARKER} ${trimmed}` : TRAINING_MARKER;
}

function composeLabelNotes(contextNote: string, motion: MotionTag): string | undefined {
  const trimmed = contextNote.trim();
  const parts = [trimmed, motion ? `(${motion})` : ''].filter((p) => p.length > 0);
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/** "2m 14s" / "45s" -- coarser formatters elsewhere (`occupancySeries.ts`'s `formatDuration`) round to whole minutes, too coarse for a live ticking readout the operator glances at while walking. */
function formatHeldDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return m === 0 ? `${s}s` : `${m}m ${String(s).padStart(2, '0')}s`;
}

function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatIntervalSpan(row: LabelRow): string {
  if (row.endTime === null) return `${formatClock(row.time)} → (open)`;
  const ms = new Date(row.endTime).getTime() - new Date(row.time).getTime();
  return `${formatClock(row.time)} → ${formatClock(row.endTime)} (${formatHeldDuration(ms)})`;
}

type Banner = { kind: 'info' | 'warning' | 'error'; text: string } | null;

const BANNER_COLOR: Record<NonNullable<Banner>['kind'], string> = {
  info: 'var(--accent)',
  warning: 'var(--warn)',
  error: 'var(--bad)',
};

export function renderTraining(container: HTMLElement): () => void {
  let disposed = false;
  const root = h('div', { class: 'view-scroll' });
  container.append(root);

  // ---- Mutable view state (rebuilt from the server on resume, never trusted from memory alone) ----
  let session: LabelSessionRow | null = null;
  let currentLabel: LabelRow | null = null; // the currently open declaration, if any
  let transcript: LabelRow[] = []; // ascending by time, as returned by the API
  let resumeCandidate: LabelSessionRow | null = null; // an open training session found on mount, awaiting operator confirmation
  let busy = false; // guards against a double tap firing overlapping requests
  let motionTag: MotionTag = '';
  let banner: Banner = { kind: 'info', text: 'Checking for an existing training session…' };
  let checking = true; // suppresses the start-session panel until the resume check resolves, to avoid a flash of "start" right before "resume"

  // ---- Persistent elements (never recreated, so typed text / focus survives a re-render) ----
  const bannerEl = h('div', { class: 'panel' });

  const startNotesInput = h('input', { type: 'text', placeholder: 'e.g. "Saturday walkthrough, whole house"' }) as HTMLInputElement;
  const startButton = h('button', { onclick: () => void startSession() }, 'Start training session');
  const startPanel = h(
    'div',
    { class: 'panel' },
    h('h2', {}, 'Start a training session'),
    h(
      'p',
      { class: 'sub' },
      'Walk through the house declaring ground truth as you go. This is the guided cold-start flow for bootstrapping the first labelled ' +
        'corpus before any trained model exists (docs/roadmap.md "Training mode for cold-start bootstrap"). To review or correct the ' +
        "system's own past predictions instead, use the Occupancy timeline view — select a stretch there and mark it wrong or confirm it " +
        'correct. The Recording controls view is a third, simpler tool for point-in-time annotation only; it cannot label a past stretch.',
    ),
    h('div', { class: 'controls' }, h('label', {}, 'Notes', startNotesInput), startButton),
  );

  const resumeButton = h('button', { onclick: () => void resumeSession() }, 'Resume');
  const resumeIgnoreButton = h('button', { onclick: () => void dismissResume() }, 'Start a new session instead');
  const resumePanel = h('div', { class: 'panel' });

  const contextInput = h('input', { type: 'text', placeholder: 'e.g. "kitchen", "upstairs", "still, reading"' }) as HTMLInputElement;
  const stillButton = h('button', { onclick: () => setMotionTag('still') }, 'still');
  const movingButton = h('button', { onclick: () => setMotionTag('moving') }, 'moving');
  const clearMotionButton = h('button', { onclick: () => setMotionTag('') }, '✕');

  const declareButtons: Record<DeclaredState, HTMLButtonElement> = {
    0: h('button', { onclick: () => void declare(0) }, STATE_BUTTON_LABELS[0]),
    1: h('button', { onclick: () => void declare(1) }, STATE_BUTTON_LABELS[1]),
    2: h('button', { onclick: () => void declare(2) }, STATE_BUTTON_LABELS[2]),
  };
  for (const btn of Object.values(declareButtons)) {
    btn.setAttribute('style', 'flex:1; padding:1.4rem 0.5rem; font-size:2rem; font-weight:700; min-width:80px;');
  }

  const readoutState = h('div', { style: 'font-size:2.2rem; font-weight:700;' }, '—');
  const readoutDuration = h('div', { class: 'sub', style: 'font-size:1rem;' }, '');

  const stopButton = h('button', { onclick: () => void stopSession() }, 'Stop session');
  const sessionInfo = h('p', { class: 'sub' }, '');

  const declarePanel = h(
    'div',
    { class: 'panel' },
    h('h2', {}, 'Declare current state'),
    sessionInfo,
    h('div', { class: 'controls' }, declareButtons[0], declareButtons[1], declareButtons[2]),
    h(
      'div',
      { class: 'controls' },
      h('label', {}, 'Context note (carried to the next declaration)', contextInput),
      h('label', {}, 'Motion (optional)', h('div', { class: 'controls' }, stillButton, movingButton, clearMotionButton)),
    ),
    h('div', { style: 'margin: 0.5rem 0;' }, readoutState, readoutDuration),
    h('div', { class: 'controls' }, stopButton),
  );

  const transcriptPanel = h('div', { class: 'panel' });

  root.append(h('h2', {}, 'Training mode'), bannerEl, resumePanel, startPanel, declarePanel, transcriptPanel);

  // ---- Rendering ----

  function syncBanner(): void {
    clear(bannerEl);
    if (!banner) {
      bannerEl.style.display = 'none';
      return;
    }
    bannerEl.style.display = '';
    bannerEl.setAttribute('style', `border-color: ${BANNER_COLOR[banner.kind]}; color: ${banner.kind === 'error' ? BANNER_COLOR.error : 'var(--text)'};`);
    bannerEl.append(h('strong', {}, banner.kind === 'warning' ? 'Warning: ' : banner.kind === 'error' ? 'Error: ' : ''), banner.text);
  }

  function setMotionTag(tag: MotionTag): void {
    motionTag = motionTag === tag ? '' : tag;
    syncMotionButtons();
  }

  function syncMotionButtons(): void {
    stillButton.setAttribute('style', motionTag === 'still' ? 'border-color: var(--accent); color: var(--accent);' : '');
    movingButton.setAttribute('style', motionTag === 'moving' ? 'border-color: var(--accent); color: var(--accent);' : '');
  }

  function syncDeclareButtons(): void {
    for (const state of [0, 1, 2] as const) {
      const active = currentLabel !== null && currentLabel.occupancyCount === state;
      declareButtons[state].setAttribute(
        'style',
        `flex:1; padding:1.4rem 0.5rem; font-size:2rem; font-weight:700; min-width:80px;${
          active ? ' border-color: var(--ok); color: var(--ok); background: var(--bg-panel-raised);' : ''
        }`,
      );
    }
  }

  function syncReadout(): void {
    if (currentLabel === null) {
      readoutState.textContent = 'No declaration yet — tap a state above.';
      readoutDuration.textContent = '';
      return;
    }
    readoutState.textContent = STATE_LABELS[currentLabel.occupancyCount as DeclaredState] ?? String(currentLabel.occupancyCount);
    tickReadoutDuration();
  }

  function tickReadoutDuration(): void {
    if (disposed || currentLabel === null) return;
    const heldMs = Date.now() - new Date(currentLabel.time).getTime();
    readoutDuration.textContent = `held for ${formatHeldDuration(heldMs)}`;
  }

  function syncTranscript(): void {
    clear(transcriptPanel);
    transcriptPanel.append(h('h2', {}, 'Transcript'));
    if (session === null || transcript.length === 0) {
      transcriptPanel.append(h('p', { class: 'sub' }, 'No declarations recorded yet.'));
      return;
    }
    const newestFirst = [...transcript].reverse();
    transcriptPanel.append(
      h(
        'table',
        {},
        h('thead', {}, h('tr', {}, h('th', {}, 'State'), h('th', {}, 'Interval'), h('th', {}, 'Note'))),
        h(
          'tbody',
          {},
          ...newestFirst.map((row) =>
            h(
              'tr',
              {},
              h('td', {}, STATE_LABELS[row.occupancyCount as DeclaredState] ?? String(row.occupancyCount)),
              h('td', {}, formatIntervalSpan(row)),
              h('td', {}, row.notes ?? ''),
            ),
          ),
        ),
      ),
    );
  }

  function setDeclareButtonsDisabled(disabled: boolean): void {
    for (const btn of Object.values(declareButtons)) btn.disabled = disabled;
    stopButton.disabled = disabled;
  }

  function syncPanels(): void {
    const hasOpenSession = session !== null && session.endedAt === null;
    resumePanel.style.display = resumeCandidate !== null ? '' : 'none';
    startPanel.style.display = !checking && !hasOpenSession && resumeCandidate === null ? '' : 'none';
    declarePanel.style.display = hasOpenSession ? '' : 'none';
    if (session !== null) {
      sessionInfo.textContent = `Session #${session.id}, started ${formatClock(session.startedAt)}${
        session.endedAt ? `, stopped ${formatClock(session.endedAt)}` : ''
      }.`;
    }
  }

  function syncAll(): void {
    if (disposed) return;
    syncBanner();
    syncMotionButtons();
    syncDeclareButtons();
    syncReadout();
    syncTranscript();
    syncPanels();
  }

  // ---- Resume-on-mount ----

  async function findOpenTrainingSession(): Promise<LabelSessionRow | null> {
    const res = await apiGet<{ sessions: LabelSessionRow[] }>('/api/labels/sessions?limit=500');
    return res.sessions.find((s) => s.endedAt === null && isTrainingSession(s.notes)) ?? null;
  }

  async function checkForResume(): Promise<void> {
    try {
      const found = await findOpenTrainingSession();
      if (disposed) return;
      checking = false;
      if (found) {
        resumeCandidate = found;
        banner = {
          kind: 'info',
          text: `Found an open training session (#${found.id}, started ${formatClock(found.startedAt)}${
            found.notes ? ` — ${found.notes.replace(TRAINING_MARKER, '').trim()}` : ''
          }).`,
        };
        clear(resumePanel);
        resumePanel.append(
          h('h2', {}, 'Resume open training session?'),
          h(
            'p',
            { class: 'sub' },
            `A phone lock or reload must not orphan a walk in progress — session #${found.id} is still open on the server.`,
          ),
          h('div', { class: 'controls' }, resumeButton, resumeIgnoreButton),
        );
      } else {
        banner = null;
      }
    } catch (err) {
      if (disposed) return;
      checking = false;
      banner = { kind: 'error', text: err instanceof ApiError ? err.message : String(err) };
    }
    syncAll();
  }

  async function resumeSession(): Promise<void> {
    if (resumeCandidate === null) return;
    session = resumeCandidate;
    resumeCandidate = null;
    try {
      await refreshTranscript();
      banner = { kind: 'info', text: `Resumed session #${session.id}.` };
    } catch (err) {
      banner = { kind: 'error', text: err instanceof ApiError ? err.message : String(err) };
    }
    syncAll();
  }

  function dismissResume(): void {
    // Deliberately does NOT stop the found session server-side — the operator
    // chose not to resume it here, but it remains resumable later (or via the
    // CLI) rather than being silently closed out from under them.
    resumeCandidate = null;
    banner = null;
    syncAll();
  }

  // ---- Session lifecycle ----

  async function startSession(): Promise<void> {
    if (busy) return;
    busy = true;
    startButton.disabled = true;
    try {
      const res = await apiPost<{ session: LabelSessionRow }>('/api/labels/sessions', {
        notes: composeSessionNotes(startNotesInput.value),
      });
      session = res.session;
      transcript = [];
      currentLabel = null;
      startNotesInput.value = '';
      banner = { kind: 'info', text: `Session #${session.id} started. Declare the current state to begin the trace.` };
    } catch (err) {
      banner = { kind: 'error', text: err instanceof ApiError ? err.message : String(err) };
    } finally {
      busy = false;
      startButton.disabled = false;
      syncAll();
    }
  }

  async function refreshTranscript(): Promise<void> {
    if (session === null) return;
    const res = await apiGet<{ labels: LabelRow[] }>(`/api/labels/sessions/${session.id}/labels?limit=5000`);
    transcript = res.labels;
    const last = transcript[transcript.length - 1];
    currentLabel = last !== undefined && last.endTime === null ? last : null;
  }

  async function declare(newState: DeclaredState): Promise<void> {
    if (session === null || busy) return;

    // Tapping the already-current state is a no-op, not a zero-length interval.
    if (currentLabel !== null && currentLabel.occupancyCount === newState) {
      banner = { kind: 'info', text: `Already declared "${STATE_LABELS[newState]}" — tap ignored.` };
      syncAll();
      return;
    }

    busy = true;
    setDeclareButtonsDisabled(true);
    const now = new Date();
    const notes = composeLabelNotes(contextInput.value, motionTag);
    const toClose = currentLabel;

    try {
      // Close-then-open, so the intervals abut and never overlap: a failure
      // here must NOT open a new declaration, or the operator would have two
      // open declarations at once with no way to tell which is real.
      if (toClose !== null) {
        await apiPatch(`/api/labels/${toClose.id}`, { endTime: now.toISOString() });
      }
    } catch (err) {
      banner = {
        kind: 'error',
        text: `Could not close the previous declaration — the new state was NOT recorded. ${
          err instanceof ApiError ? err.message : String(err)
        }`,
      };
      busy = false;
      setDeclareButtonsDisabled(false);
      syncAll();
      return;
    }

    try {
      await apiPost<{ label: LabelRow }>('/api/labels', {
        sessionId: session.id,
        time: now.toISOString(),
        occupancyCount: newState,
        source: 'training',
        notes,
      });
      await refreshTranscript();
      banner = { kind: 'info', text: `Declared "${STATE_LABELS[newState]}"${notes ? ` — ${notes}` : ''}.` };
    } catch (err) {
      // The close above already succeeded, so there is now a real gap: no
      // declaration is open. Say so plainly and reconcile from the server
      // rather than guessing at local state.
      banner = {
        kind: 'error',
        text: `Previous declaration was closed, but the new "${STATE_LABELS[newState]}" declaration failed to record — tap it again. ${
          err instanceof ApiError ? err.message : String(err)
        }`,
      };
      try {
        await refreshTranscript();
      } catch {
        // best-effort reconciliation; the error above already explains the situation
      }
    } finally {
      busy = false;
      setDeclareButtonsDisabled(false);
      syncAll();
    }
  }

  async function stopSession(): Promise<void> {
    if (session === null || busy) return;
    busy = true;
    setDeclareButtonsDisabled(true);
    const toClose = currentLabel;

    try {
      // Same close-then-act ordering as declare(): if closing the open
      // declaration fails, the session is NOT stopped, and nothing else
      // about local state changes -- the declare panel stays exactly as it
      // was, so the operator can just retry.
      if (toClose !== null) {
        await apiPatch(`/api/labels/${toClose.id}`, { endTime: new Date().toISOString() });
      }
    } catch (err) {
      banner = { kind: 'error', text: err instanceof ApiError ? err.message : String(err) };
      busy = false;
      setDeclareButtonsDisabled(false);
      syncAll();
      return;
    }

    try {
      const res = await apiPost<{ session: LabelSessionRow; preservationWarning?: string }>(
        `/api/labels/sessions/${session.id}/stop`,
      );
      session = res.session;
      await refreshTranscript();
      banner =
        res.preservationWarning !== undefined
          ? { kind: 'warning', text: res.preservationWarning }
          : { kind: 'info', text: 'Session stopped and labels recorded.' };
    } catch (err) {
      // The close above already succeeded, so the declaration is no longer
      // open even though the session-stop call failed -- reconcile from the
      // server (same rationale as declare()'s analogous catch) rather than
      // leaving `currentLabel`/`session` at stale pre-close values, which
      // would otherwise keep the "held for Xs" readout ticking against a
      // label the server has already closed.
      banner = {
        kind: 'error',
        text: `Declaration closed, but stopping the session failed — try Stop again. ${
          err instanceof ApiError ? err.message : String(err)
        }`,
      };
      try {
        await refreshTranscript();
      } catch {
        // best-effort reconciliation; the error above already explains the situation
      }
    } finally {
      busy = false;
      setDeclareButtonsDisabled(false);
      syncAll();
    }
  }

  // ---- Ticking clock: only the duration text updates every second, never a full re-render (that would blur the context-note input mid-typing) ----
  const timer = setInterval(() => {
    if (disposed) return;
    tickReadoutDuration();
  }, 1000);

  void checkForResume();
  syncAll();

  return () => {
    disposed = true;
    clearInterval(timer);
  };
}
