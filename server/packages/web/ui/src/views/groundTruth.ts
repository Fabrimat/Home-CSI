import './groundTruth.css';
import { apiDelete, apiGet, apiPatch, apiPost, ApiError } from '../api.js';
import { clear, h } from '../dom.js';
import { statusMessage, type StatusKind } from '../components/statusMessage.js';
import { emptyState, errorState, loadingState } from '../components/asyncState.js';
import { occupancyDeepLinkHash, type RetentionConfig } from '../labelRanges.js';
import {
  ANNOTATION_CATEGORIES,
  annotationReviewWindow,
  canDeclare,
  composeLabelNotes,
  composeSessionNotes,
  deriveMissions,
  formatCountdown,
  formatHeldDuration,
  isSessionOpen,
  isShortcutSuppressed,
  MIN_INTERVAL_MS,
  openDeclarationOf,
  planAnnotationSpan,
  planDeclaration,
  recentLabelChips,
  STATE_BUTTON_LABELS,
  STATE_LABELS,
  TRAINING_MARKER,
  type AnnotationCategory,
  type AnnotationRow,
  type CoverageSnapshot,
  type DeclaredState,
  type MotionTag,
} from '../groundTruthLogic.js';

/**
 * The one ground-truth surface: three modes over the same job of telling the
 * system what actually happened.
 *
 *  - **Live** -- the guided walkthrough that produces the very first labelled
 *    corpus before any trained model exists (docs/roadmap.md "Training mode
 *    for cold-start bootstrap"). Absorbed wholesale from the standalone
 *    training-mode view this replaces; every ordering rule in
 *    `declare()`/`stopSession()` below is a documented guarantee, not an
 *    implementation detail.
 *  - **Annotate** -- one-tap confounder markers ("that spike is the
 *    microwave", `POST /api/annotations`). Carries NO occupancy count, ever.
 *  - **Missions** -- what is worth reviewing before the 7-day retention
 *    window drops the raw features behind it (`GET /api/coverage`).
 *
 * To review or correct the system's own past predictions, the Occupancy
 * timeline view remains the place: select a stretch there and confirm or
 * correct it. Missions links straight into it.
 *
 * Deliberately NOT gamified with points: see the comment above
 * `renderMissions` -- big touch targets, one-tap actions, keyboard shortcuts
 * and instant undo are the "game feel"; a score is not.
 */

type Mode = 'live' | 'annotate' | 'missions';

const MODES: Array<{ id: Mode; label: string; hint: string }> = [
  { id: 'live', label: 'Live', hint: 'declare state as you walk' },
  { id: 'annotate', label: 'Annotate', hint: 'mark an event, one tap' },
  { id: 'missions', label: 'Missions', hint: 'what expires next' },
];

interface LabelSessionRow {
  id: number;
  startedAt: string;
  endedAt: string | null;
  notes: string | null;
}

/** `labels.source` (migration 008) -- Live mode only ever reads/writes `'training'`. */
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

/** How far back Annotate mode's "what I just recorded" list looks. */
const RECENT_ANNOTATIONS_WINDOW_MS = 24 * 3600_000;
const RECENT_ANNOTATIONS_SHOWN = 8;
const RECENT_LABEL_CHIPS = 6;
/** Half-width of the review window offered for a *point* annotation's occupancy hand-off -- a selection to look at, never a fabricated label. */
const POINT_REVIEW_PAD_MS = 150_000;

function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatIntervalSpan(row: { time: string; endTime: string | null }): string {
  if (row.endTime === null) return `${formatClock(row.time)} → (open)`;
  const ms = new Date(row.endTime).getTime() - new Date(row.time).getTime();
  return `${formatClock(row.time)} → ${formatClock(row.endTime)} (${formatHeldDuration(ms)})`;
}

function errText(err: unknown): string {
  return err instanceof ApiError ? err.message : String(err);
}

type Banner = { kind: 'info' | 'warning' | 'error'; text: string } | null;

export function renderGroundTruth(container: HTMLElement): () => void {
  let disposed = false;
  let mode: Mode = 'live';
  const root = h('div', { class: 'view-scroll gt-root' });
  container.append(root);

  // ==== Mode switcher =====================================================
  // A real radio group in a labelled fieldset, not a div of clickable spans:
  // arrow-key selection, focus indication and the group's accessible name all
  // come from the platform rather than being re-implemented (and forgotten)
  // here.
  const modeSwitcher = h(
    'fieldset',
    { class: 'gt-modes' },
    h('legend', {}, 'Ground truth mode'),
    ...MODES.map((m) =>
      h(
        'label',
        { class: 'gt-mode' },
        h('input', { type: 'radio', name: 'gt-mode', value: m.id, checked: m.id === mode, onchange: () => setMode(m.id) }),
        h('span', { class: 'gt-mode-label' }, m.label),
        h('span', { class: 'gt-mode-hint' }, m.hint),
      ),
    ),
  );

  const liveSection = h('section', { class: 'gt-section', 'aria-label': 'Live state declaration' });
  const annotateSection = h('section', { class: 'gt-section', 'aria-label': 'Event annotation' });
  const missionsSection = h('section', { class: 'gt-section', 'aria-label': 'Review missions' });

  root.append(h('h2', { class: 'gt-title' }, 'Ground truth'), modeSwitcher, liveSection, annotateSection, missionsSection);

  function setMode(next: Mode): void {
    mode = next;
    liveSection.style.display = next === 'live' ? '' : 'none';
    annotateSection.style.display = next === 'annotate' ? '' : 'none';
    missionsSection.style.display = next === 'missions' ? '' : 'none';
    if (next === 'annotate') void refreshAnnotations();
    if (next === 'missions') void loadMissions();
  }

  // ==== Mode: Live ========================================================
  // Absorbed from the standalone training-mode view. The mutable state is
  // rebuilt from the server on resume and never trusted from memory alone.
  let session: LabelSessionRow | null = null;
  let currentLabel: LabelRow | null = null; // the currently open declaration, if any
  let transcript: LabelRow[] = []; // ascending by time, as returned by the API
  let resumeCandidate: LabelSessionRow | null = null; // an open training session found on mount, awaiting operator confirmation
  let busy = false; // guards against a double tap firing overlapping requests
  let motionTag: MotionTag = '';
  let banner: Banner = { kind: 'info', text: 'Checking for an existing training session…' };
  let checking = true; // suppresses the start-session panel until the resume check resolves, to avoid a flash of "start" right before "resume"

  // Persistent elements (never recreated, so typed text / focus survives a re-render).
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
        'correct; the Missions mode above links straight to the stretches worth reviewing first.',
    ),
    h('div', { class: 'controls' }, h('label', {}, 'Notes', startNotesInput), startButton),
  );

  const resumeButton = h('button', { onclick: () => void resumeSession() }, 'Resume');
  const resumeIgnoreButton = h('button', { onclick: () => dismissResume() }, 'Start a new session instead');
  const resumePanel = h('div', { class: 'panel' });

  const contextInput = h('input', { type: 'text', placeholder: 'e.g. "kitchen", "upstairs", "still, reading"' }) as HTMLInputElement;
  const stillButton = h('button', { class: 'gt-motion', onclick: () => setMotionTag('still') }, 'still');
  const movingButton = h('button', { class: 'gt-motion', onclick: () => setMotionTag('moving') }, 'moving');
  const clearMotionButton = h('button', { class: 'gt-motion', 'aria-label': 'Clear the motion tag', onclick: () => setMotionTag('') }, '✕');

  const declareButtons: Record<DeclaredState, HTMLButtonElement> = {
    0: h('button', { class: 'gt-declare', onclick: () => void declare(0) }),
    1: h('button', { class: 'gt-declare', onclick: () => void declare(1) }),
    2: h('button', { class: 'gt-declare', onclick: () => void declare(2) }),
  };
  for (const state of [0, 1, 2] as const) {
    // Big digit for the thumb, the words underneath for everyone else: the
    // digit alone is not an accessible name for "two or more of us".
    declareButtons[state].append(
      h('span', { class: 'gt-declare-digit', 'aria-hidden': 'true' }, STATE_BUTTON_LABELS[state]),
      h('span', { class: 'gt-declare-text' }, STATE_LABELS[state]),
    );
  }

  const readoutState = h('div', { class: 'gt-readout-state' }, '—');
  const readoutDuration = h('div', { class: 'sub gt-readout-duration' }, '');

  const stopButton = h('button', { onclick: () => void stopSession() }, 'Stop session');
  const sessionInfo = h('p', { class: 'sub' }, '');

  const declarePanel = h(
    'div',
    { class: 'panel' },
    h('h2', {}, 'Declare current state'),
    sessionInfo,
    h('div', { class: 'gt-declare-row' }, declareButtons[0], declareButtons[1], declareButtons[2]),
    h('p', { class: 'sub' }, 'Keyboard: 0 / 1 / 2 declare the matching state (ignored while you are typing in a field).'),
    h(
      'div',
      { class: 'controls' },
      h('label', {}, 'Context note (carried to the next declaration)', contextInput),
      h('label', {}, 'Motion (optional)', h('div', { class: 'controls' }, stillButton, movingButton, clearMotionButton)),
    ),
    h('div', { class: 'gt-readout' }, readoutState, readoutDuration),
    h('div', { class: 'controls' }, stopButton),
  );

  const transcriptPanel = h('div', { class: 'panel' });

  liveSection.append(bannerEl, resumePanel, startPanel, declarePanel, transcriptPanel);

  function syncBanner(): void {
    clear(bannerEl);
    if (!banner) {
      bannerEl.style.display = 'none';
      return;
    }
    bannerEl.style.display = '';
    // Delegates to the shared statusMessage component for both the visual
    // severity styling AND the screen-reader announcement -- this banner
    // reports session lifecycle outcomes (started/resumed/stopped/failed),
    // which is exactly the kind of one-off action-result feedback that must
    // not be visual-only. 'warning' here maps to the component's 'warn' kind.
    bannerEl.append(statusMessage(banner.kind === 'warning' ? 'warn' : banner.kind, banner.text, true));
  }

  function setMotionTag(tag: MotionTag): void {
    motionTag = motionTag === tag ? '' : tag;
    syncMotionButtons();
  }

  function syncMotionButtons(): void {
    stillButton.classList.toggle('active', motionTag === 'still');
    movingButton.classList.toggle('active', motionTag === 'moving');
  }

  function syncDeclareButtons(): void {
    for (const state of [0, 1, 2] as const) {
      const active = currentLabel !== null && currentLabel.occupancyCount === state;
      declareButtons[state].classList.toggle('active', active);
      // `aria-pressed` so the currently declared state is conveyed to
      // assistive tech, not only by the highlight.
      declareButtons[state].setAttribute('aria-pressed', active ? 'true' : 'false');
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
      transcriptPanel.append(emptyState('No declarations recorded yet.'));
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

  function syncLive(): void {
    if (disposed) return;
    syncBanner();
    syncMotionButtons();
    syncDeclareButtons();
    syncReadout();
    syncTranscript();
    syncPanels();
  }

  // ---- Resume-on-mount ----

  /**
   * Asks the server directly for the newest still-open `[training]` session
   * (`open=true&notesPrefix=[training]`, brief B3's additive filter on
   * `GET /api/labels/sessions`).
   *
   * The standalone training view this replaces paged `limit=500` newest-first and scanned
   * client-side, which is fragile for a real reason: every dashboard
   * correction creates its own `label_sessions` row, so enough corrections
   * would push an open training session off the end of even the maximum page
   * and silently orphan a walk in progress -- exactly the phone-locked-
   * mid-walk case this resume flow exists for.
   */
  async function findOpenTrainingSession(): Promise<LabelSessionRow | null> {
    const res = await apiGet<{ sessions: LabelSessionRow[] }>(
      `/api/labels/sessions?open=true&notesPrefix=${encodeURIComponent(TRAINING_MARKER)}&limit=1`,
    );
    return res.sessions[0] ?? null;
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
      banner = { kind: 'error', text: errText(err) };
    }
    syncLive();
  }

  async function resumeSession(): Promise<void> {
    if (resumeCandidate === null) return;
    session = resumeCandidate;
    resumeCandidate = null;
    try {
      await refreshTranscript();
      banner = { kind: 'info', text: `Resumed session #${session.id}.` };
    } catch (err) {
      banner = { kind: 'error', text: errText(err) };
    }
    syncLive();
  }

  function dismissResume(): void {
    // Deliberately does NOT stop the found session server-side — the operator
    // chose not to resume it here, but it remains resumable later (or via the
    // CLI) rather than being silently closed out from under them.
    resumeCandidate = null;
    banner = null;
    syncLive();
  }

  // ---- Session lifecycle ----

  async function startSession(): Promise<void> {
    // Third instance of the same class: starting while a session is open
    // would orphan the open one. Only the (hidden) start panel reaches this,
    // but the guard belongs on the state. A *stopped* session is not open, so
    // starting the next walk after a stop still works.
    if (busy || isSessionOpen(session)) return;
    busy = true;
    startButton.disabled = true;
    try {
      const res = await apiPost<{ session: LabelSessionRow }>('/api/labels/sessions', {
        // `composeSessionNotes` is what keeps these notes `[training]`-marked
        // and, critically, never `[weak:phone-presence]`-prefixed -- see its
        // doc comment: a weak-flagged session's raw features are skipped by
        // preservation and silently evaporate at the 7-day mark.
        notes: composeSessionNotes(startNotesInput.value),
      });
      session = res.session;
      transcript = [];
      currentLabel = null;
      startNotesInput.value = '';
      banner = { kind: 'info', text: `Session #${session.id} started. Declare the current state to begin the trace.` };
    } catch (err) {
      banner = { kind: 'error', text: errText(err) };
    } finally {
      busy = false;
      startButton.disabled = false;
      syncLive();
    }
  }

  async function refreshTranscript(): Promise<void> {
    if (session === null) return;
    const res = await apiGet<{ labels: LabelRow[] }>(`/api/labels/sessions/${session.id}/labels?limit=5000`);
    transcript = res.labels;
    currentLabel = openDeclarationOf(transcript);
  }

  async function declare(newState: DeclaredState): Promise<void> {
    // Deliberately state-based, and deliberately HERE rather than at the call
    // sites: panel visibility is not access control. `stopSession` leaves the
    // stopped session in view state, and the keydown shortcut routes 0/1/2
    // straight here whenever Live mode is showing -- with the declare panel
    // hidden. Without the `endedAt` half of this guard one stray keypress
    // appends a permanent, open-ended `source: 'training'` label to an
    // already-stopped, already-preserved session (see `canDeclare`). The
    // explicit null clause is redundant with it and kept only because it is
    // what narrows `session` for the calls further down.
    if (session === null || !canDeclare(session, busy)) return;

    const plan = planDeclaration(currentLabel, newState);
    // Tapping the already-current state is a no-op, not a zero-length interval.
    if (plan.kind === 'noop') {
      banner = { kind: 'info', text: `Already declared "${STATE_LABELS[newState]}" — tap ignored.` };
      syncLive();
      return;
    }

    busy = true;
    setDeclareButtonsDisabled(true);
    const now = new Date();
    const notes = composeLabelNotes(contextInput.value, motionTag);

    try {
      // Close-then-open, so the intervals abut and never overlap: a failure
      // here must NOT open a new declaration, or the operator would have two
      // open declarations at once with no way to tell which is real.
      if (plan.closeLabelId !== null) {
        await apiPatch(`/api/labels/${plan.closeLabelId}`, { endTime: now.toISOString() });
      }
    } catch (err) {
      banner = {
        kind: 'error',
        text: `Could not close the previous declaration — the new state was NOT recorded. ${errText(err)}`,
      };
      busy = false;
      setDeclareButtonsDisabled(false);
      syncLive();
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
        text: `Previous declaration was closed, but the new "${STATE_LABELS[newState]}" declaration failed to record — tap it again. ${errText(err)}`,
      };
      try {
        await refreshTranscript();
      } catch {
        // best-effort reconciliation; the error above already explains the situation
      }
    } finally {
      busy = false;
      setDeclareButtonsDisabled(false);
      syncLive();
    }
  }

  async function stopSession(): Promise<void> {
    // Same reasoning as declare(): stopping an already-stopped session would
    // push its `ended_at` forward and re-run preservation over a wider
    // window. Only the (hidden) Stop button reaches this today -- the guard is
    // on the state, not on the button being off screen.
    if (session === null || !canDeclare(session, busy)) return;
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
      banner = { kind: 'error', text: errText(err) };
      busy = false;
      setDeclareButtonsDisabled(false);
      syncLive();
      return;
    }

    try {
      const res = await apiPost<{ session: LabelSessionRow; preservationWarning?: string }>(
        `/api/labels/sessions/${session.id}/stop`,
      );
      session = res.session;
      await refreshTranscript();
      // A preservationWarning means the labels were recorded but the raw
      // per-link features behind them could not be archived into
      // training_features -- rendered as a distinct warning, never dropped.
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
        text: `Declaration closed, but stopping the session failed — try Stop again. ${errText(err)}`,
      };
      try {
        await refreshTranscript();
      } catch {
        // best-effort reconciliation; the error above already explains the situation
      }
    } finally {
      busy = false;
      setDeclareButtonsDisabled(false);
      syncLive();
    }
  }

  // ==== Mode: Annotate ====================================================
  let annotations: AnnotationRow[] = [];
  let lastWrite: AnnotationRow | null = null; // the single undo target
  let pending: { category: AnnotationCategory; label: string; startMs: number } | null = null;
  let annotateBusy = false;

  let renderedChipsKey: string | null = null; // null until the chip row has been rendered once
  const labelInput = h('input', { type: 'text', placeholder: 'e.g. "microwave", "front door"' }) as HTMLInputElement;
  const chipsRow = h('div', { class: 'gt-chips' });
  const intervalToggle = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const cancelPendingButton = h('button', { onclick: () => cancelPending() }, 'Cancel');
  // The ticking text is its own node so the 1s tick never re-appends the
  // Cancel button -- moving a focused element in the DOM can blur it, and
  // losing focus once a second is not a keyboard-usable UI.
  const pendingText = h('div', {});
  const pendingReadout = h('div', { class: 'gt-pending' }, pendingText, h('div', { class: 'controls' }, cancelPendingButton));
  const undoButton = h('button', { class: 'gt-undo', onclick: () => void undoLastWrite() }, 'Undo last (z)');
  // A persistent `role="status"` container whose *contents* change, rather
  // than a fresh statusMessage() node per tap: this fires on every single
  // annotation, so it must be polite (never `role="alert"`), and a live
  // region that is re-created each time is unreliably announced. The visual
  // severity classes are reused from style.css, the politeness is not.
  const annotateFeedback = h('div', { class: 'gt-feedback', role: 'status' });
  const recentPanel = h('div', { class: 'panel' });
  const handoffRow = h('div', { class: 'gt-handoff' });

  const catButtons: Partial<Record<AnnotationCategory, HTMLButtonElement>> = {};
  const catLabels: Partial<Record<AnnotationCategory, HTMLElement>> = {};
  const categoryGrid = h(
    'div',
    { class: 'gt-cat-grid' },
    ...ANNOTATION_CATEGORIES.map((cat) => {
      const labelEl = h('span', { class: 'gt-cat-label' }, cat.label);
      const btn = h(
        'button',
        { class: 'gt-cat', onclick: () => void onCategoryTap(cat.id) },
        labelEl,
        h('span', { class: 'gt-cat-hint' }, cat.hint),
      );
      catButtons[cat.id] = btn;
      catLabels[cat.id] = labelEl;
      return btn;
    }),
  );

  annotateSection.append(
    h(
      'div',
      { class: 'panel' },
      h('h2', {}, 'Mark what just happened'),
      h(
        'p',
        { class: 'sub' },
        'One tap records the event at the current instant. These are confounders — things that move the CSI without being an occupant — and they carry ' +
          'no occupancy count at all. Looking for "someone was cooking"? That is occupancy signal, not a confounder: record it as a correction on the ' +
          'Occupancy timeline (Missions above links to the stretches worth reviewing) rather than as an annotation.',
      ),
      h(
        'div',
        { class: 'controls' },
        h('label', {}, 'Label (optional free text)', labelInput),
        h('label', { class: 'gt-inline-check' }, intervalToggle, 'Record as an interval (tap to start, tap the same button to stop)'),
      ),
      chipsRow,
      categoryGrid,
      pendingReadout,
      h('div', { class: 'controls' }, undoButton),
      annotateFeedback,
      handoffRow,
    ),
    recentPanel,
  );

  function setAnnotateFeedback(kind: StatusKind, text: string): void {
    clear(annotateFeedback);
    if (text) annotateFeedback.append(h('div', { class: `correction-message ${kind}` }, text));
  }

  function syncChips(): void {
    const chips = recentLabelChips(annotations, RECENT_LABEL_CHIPS);
    // Only rebuild when the set actually changed: these buttons are
    // focusable, and re-creating them after every write would drop keyboard
    // focus roughly whenever the operator is using them.
    const key = chips.join('|');
    if (key === renderedChipsKey) return;
    renderedChipsKey = key;
    clear(chipsRow);
    if (chips.length === 0) return;
    chipsRow.append(h('span', { class: 'sub' }, 'Recent labels:'));
    for (const chip of chips) {
      chipsRow.append(
        h(
          'button',
          {
            class: 'gt-chip',
            'aria-label': `Use the label "${chip}"`,
            onclick: () => {
              labelInput.value = chip;
              setAnnotateFeedback('info', `Label set to "${chip}".`);
            },
          },
          chip,
        ),
      );
    }
  }

  function syncPending(): void {
    for (const cat of ANNOTATION_CATEGORIES) {
      const btn = catButtons[cat.id];
      if (!btn) continue;
      // While an interval is open, only its own button stays live -- it *is*
      // the "tap again to stop" affordance, so the second tap lands on the
      // same big target as the first.
      const isPending = pending !== null && pending.category === cat.id;
      btn.disabled = annotateBusy || (pending !== null && !isPending);
      btn.classList.toggle('pending', isPending);
      const labelEl = catLabels[cat.id];
      if (labelEl) labelEl.textContent = isPending ? `Stop ${cat.label}` : cat.label;
    }
    undoButton.disabled = annotateBusy || lastWrite === null;
    pendingReadout.style.display = pending === null ? 'none' : '';
    syncPendingText();
  }

  function syncPendingText(): void {
    if (pending === null) return;
    pendingText.textContent = `Recording ${pending.category}${pending.label ? ` "${pending.label}"` : ''} since ${formatClock(
      new Date(pending.startMs).toISOString(),
    )} — ${formatHeldDuration(Date.now() - pending.startMs)}`;
  }

  function tickPending(): void {
    if (disposed || pending === null || mode !== 'annotate') return;
    syncPendingText();
  }

  function cancelPending(): void {
    pending = null;
    setAnnotateFeedback('info', 'Interval discarded — nothing was recorded.');
    syncPending();
  }

  function syncHandoff(): void {
    clear(handoffRow);
    if (lastWrite === null) return;
    const reviewWindow = annotationReviewWindow(lastWrite, POINT_REVIEW_PAD_MS);
    if (reviewWindow === null) return;
    // The honest escalation path: an annotation can never say "the house was
    // empty", because it carries no occupancy count by design. If this event
    // is worth training on as occupancy, that has to be a real correction on
    // the timeline -- so link there with the window preselected instead of
    // fabricating a count here.
    handoffRow.append(
      h(
        'a',
        {
          href: occupancyDeepLinkHash(reviewWindow.fromMs, reviewWindow.toMs),
          'aria-label': `Review occupancy from ${formatClock(new Date(reviewWindow.fromMs).toISOString())} to ${formatClock(
            new Date(reviewWindow.toMs).toISOString(),
          )} on the occupancy timeline`,
        },
        'Was the house empty (or not) for this? Record a real occupancy correction for this window →',
      ),
    );
  }

  function syncRecent(): void {
    clear(recentPanel);
    recentPanel.append(h('h2', {}, 'Just recorded'));
    if (annotations.length === 0) {
      recentPanel.append(emptyState('No annotations in the last 24 hours.'));
      return;
    }
    const newestFirst = [...annotations].sort((a, b) => Date.parse(b.time) - Date.parse(a.time)).slice(0, RECENT_ANNOTATIONS_SHOWN);
    recentPanel.append(
      h(
        'table',
        {},
        h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Category'), h('th', {}, 'Label'))),
        h(
          'tbody',
          {},
          ...newestFirst.map((a) =>
            h(
              'tr',
              {},
              h('td', {}, a.endTime === null ? formatClock(a.time) : formatIntervalSpan(a)),
              h('td', {}, a.category),
              h('td', {}, a.label ?? ''),
            ),
          ),
        ),
      ),
    );
  }

  function syncAnnotate(): void {
    if (disposed) return;
    syncChips();
    syncPending();
    syncHandoff();
    syncRecent();
  }

  async function refreshAnnotations(): Promise<void> {
    const to = new Date(Date.now() + 60_000); // `to` is exclusive -- keep an annotation recorded "now" inside the window
    const from = new Date(to.getTime() - RECENT_ANNOTATIONS_WINDOW_MS);
    try {
      const res = await apiGet<{ annotations: AnnotationRow[] }>(
        `/api/annotations?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}&limit=200`,
      );
      if (disposed) return;
      annotations = res.annotations;
      syncAnnotate();
    } catch (err) {
      if (disposed) return;
      setAnnotateFeedback('error', `Could not load recent annotations: ${errText(err)}`);
      syncAnnotate();
    }
  }

  async function onCategoryTap(category: AnnotationCategory): Promise<void> {
    if (annotateBusy) return;

    if (pending !== null) {
      // Second tap of the same button: close the interval at this instant.
      const started = pending;
      pending = null;
      const what = `${started.category}${started.label ? ` "${started.label}"` : ''}`;
      // A too-short span degrades to a point annotation rather than a lost
      // tap -- see `planAnnotationSpan` for why the API leaves no third option.
      const span = planAnnotationSpan(started.startMs, Date.now());
      if (span.endTime === null) {
        await writeAnnotation(
          { category: started.category, label: started.label, time: new Date(span.time) },
          `That interval was shorter than ${formatHeldDuration(MIN_INTERVAL_MS)} — recorded ${what} as a point at ${formatClock(
            new Date(span.time).toISOString(),
          )}.`,
        );
        return;
      }
      await writeAnnotation(
        { category: started.category, label: started.label, time: new Date(span.time), endTime: new Date(span.endTime) },
        `Recorded ${what} interval, ${formatHeldDuration(span.endTime - span.time)}.`,
      );
      return;
    }

    if (intervalToggle.checked) {
      pending = { category, label: labelInput.value.trim(), startMs: Date.now() };
      setAnnotateFeedback('info', `Started ${category} interval — tap "${category}" again to stop, or Cancel to discard.`);
      syncPending();
      return;
    }

    const at = new Date();
    await writeAnnotation(
      { category, label: labelInput.value.trim(), time: at },
      `Recorded ${category}${labelInput.value.trim() ? ` "${labelInput.value.trim()}"` : ''} at ${formatClock(at.toISOString())}.`,
    );
  }

  async function writeAnnotation(
    input: { category: AnnotationCategory; label: string; time: Date; endTime?: Date },
    okText: string,
  ): Promise<void> {
    annotateBusy = true;
    syncPending();
    try {
      // NOTE: no `occupancyCount` here, and there must never be one -- an
      // annotation asserts that something non-occupant happened, not how many
      // people were home (see migration 009 / routes/annotations.ts). The
      // hand-off link below is the honest way to say something about occupancy.
      const res = await apiPost<{ annotation: AnnotationRow }>('/api/annotations', {
        time: input.time.toISOString(),
        endTime: input.endTime?.toISOString(),
        category: input.category,
        label: input.label || undefined,
      });
      lastWrite = res.annotation;
      setAnnotateFeedback('ok', `${okText} Press z (or Undo last) if that was a mis-tap.`);
    } catch (err) {
      setAnnotateFeedback('error', `Could not record that annotation: ${errText(err)}`);
    } finally {
      annotateBusy = false;
      // Refetch rather than splicing locally: the server owns the row's
      // canonical time/id, and the recent list is what the operator checks
      // to confirm what actually landed. `refreshAnnotations` re-syncs the
      // whole panel (chips/pending/hand-off/recent) on both its paths.
      await refreshAnnotations();
    }
  }

  async function undoLastWrite(): Promise<void> {
    if (annotateBusy) return;
    const target = lastWrite;
    if (target === null) {
      setAnnotateFeedback('info', 'Nothing to undo — no annotation recorded from this page yet.');
      return;
    }
    annotateBusy = true;
    syncPending();
    try {
      await apiDelete<void>(`/api/annotations/${target.id}`);
      lastWrite = null;
      setAnnotateFeedback('ok', `Undone: ${target.category}${target.label ? ` "${target.label}"` : ''} at ${formatClock(target.time)}.`);
    } catch (err) {
      // A 404 means it is already gone (double-tapped undo, or deleted
      // elsewhere) -- that is the intended end state, so clear the target
      // instead of leaving a button that can only ever fail again.
      if (err instanceof ApiError && err.status === 404) {
        lastWrite = null;
        setAnnotateFeedback('warn', 'That annotation was already deleted.');
      } else {
        setAnnotateFeedback('error', `Undo failed: ${errText(err)}`);
      }
    } finally {
      annotateBusy = false;
      await refreshAnnotations();
    }
  }

  // ==== Mode: Missions ====================================================
  //
  // NO XP, no levels, no badges, no streaks, and no total-label score --
  // here or computed client-side. This is deliberate and load-bearing, not an
  // unfinished feature: a volume incentive on a training corpus rewards
  // producing labels rather than producing *true* labels, and junk labels are
  // the one thing that can ruin the dataset this whole mode exists to build.
  // `GET /api/coverage` deliberately exposes no total or streak field for the
  // same reason -- do not derive one to fill the gap. What is rewarded here
  // is coverage (how much of the window has a human judgement attached),
  // diversity (how many different kinds of event are represented), and
  // deadline saves (work that becomes permanently unrecoverable if ignored).
  let coverage: CoverageSnapshot | null = null;
  let retentionConfig: RetentionConfig | null = null;
  let missionsError: string | null = null;
  let missionsLoaded = false;

  const missionsBody = h('div', {});
  const refreshMissionsButton = h('button', { onclick: () => void loadMissions() }, 'Refresh');
  missionsSection.append(
    h(
      'div',
      { class: 'panel' },
      h('h2', {}, 'Missions'),
      h(
        'p',
        { class: 'sub' },
        'Raw per-link features live for the length of the debug window and then they are gone for good (docs/architecture.md "Data lifecycle"). ' +
          'A stretch nobody reviewed before then can never be corrected, confirmed, or trained on. That deadline is the whole game: these are the ' +
          'stretches closest to falling off the edge.',
      ),
      h('div', { class: 'controls' }, refreshMissionsButton),
      missionsBody,
    ),
  );

  function renderMissions(): void {
    clear(missionsBody);
    if (coverage === null) {
      missionsBody.append(missionsLoaded ? errorState(missionsError ?? 'Could not load coverage.') : loadingState('Loading coverage…'));
      return;
    }

    const maxAgeMs = retentionConfig?.retentionMaxAgeMs ?? null;
    const pct = Math.round(coverage.reviewedFraction * 100);
    const windowText = maxAgeMs === null ? 'the retention window' : `the last ${(maxAgeMs / 86_400_000).toFixed(1)} days`;
    missionsBody.append(
      h(
        'div',
        { class: 'gt-coverage' },
        h('div', { class: 'sub' }, `${pct}% of ${windowText} has a human judgement attached.`),
        // Native <progress>: the accessible value/name come from the platform
        // rather than an aria-hijacked div.
        h('progress', { class: 'gt-progress', max: 100, value: pct, 'aria-label': `Fraction of ${windowText} reviewed` }, `${pct}%`),
      ),
      h(
        'div',
        { class: 'grid gt-diversity' },
        statBlock('Confirmations', String(coverage.confirmations), 'system was right, on the record'),
        statBlock('Corrections', String(coverage.corrections), 'system was wrong, on the record'),
        statBlock('Annotations', String(coverage.annotations), 'confounders marked'),
        statBlock(
          'Categories covered',
          `${coverage.categoriesUsed.length}/${ANNOTATION_CATEGORIES.length}`,
          coverage.categoriesUsed.length === 0 ? 'none yet' : coverage.categoriesUsed.join(', '),
        ),
      ),
    );

    const missions = deriveMissions(coverage.expiringSoon, maxAgeMs, Date.now());
    missionsBody.append(h('h2', {}, 'Expiring soon'));
    if (missions.length === 0) {
      missionsBody.append(
        emptyState(
          coverage.expiringSoon.length === 0
            ? 'Nothing is about to age out unreviewed. The oldest edge of the window is covered.'
            : 'Everything the server flagged has already passed its deadline — nothing here can still be saved.',
        ),
      );
      return;
    }

    missionsBody.append(
      h(
        'ul',
        { class: 'gt-missions' },
        ...missions.map((m) => {
          const deadline = m.msUntilGone === null ? 'deadline unknown (GET /api/config failed)' : `${formatCountdown(m.msUntilGone)} left`;
          // Under six hours left: the operator plausibly cannot get to it
          // today at all, so it gets the urgent treatment rather than the
          // same weight as something with days of slack.
          const urgent = m.msUntilGone !== null && m.msUntilGone < 6 * 3600_000;
          return h(
            'li',
            { class: `gt-mission${urgent ? ' urgent' : ''}` },
            h(
              'div',
              { class: 'gt-mission-when' },
              `${formatClock(m.fromIso)} → ${formatClock(m.toIso)}`,
              h('span', { class: 'sub' }, ` · ${formatHeldDuration(m.spanMs)} unreviewed`),
            ),
            h('div', { class: `gt-mission-deadline${urgent ? ' urgent' : ''}` }, deadline),
            h(
              'a',
              {
                class: 'gt-go',
                href: occupancyDeepLinkHash(Date.parse(m.fromIso), Date.parse(m.toIso)),
                'aria-label': `Review ${formatClock(m.fromIso)} to ${formatClock(m.toIso)} on the occupancy timeline`,
              },
              'Go',
            ),
          );
        }),
      ),
    );
  }

  function statBlock(label: string, value: string, sub: string): HTMLElement {
    return h('div', { class: 'stat' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), h('div', { class: 'sub' }, sub));
  }

  async function loadMissions(): Promise<void> {
    refreshMissionsButton.disabled = true;
    try {
      if (retentionConfig === null) {
        try {
          retentionConfig = await apiGet<RetentionConfig>('/api/config');
        } catch {
          // Left null on purpose: an unknown window length is rendered as
          // "deadline unknown", never as a comfortable-looking number.
          retentionConfig = null;
        }
      }
      coverage = await apiGet<CoverageSnapshot>('/api/coverage');
      missionsError = null;
    } catch (err) {
      coverage = null;
      missionsError = errText(err);
    } finally {
      missionsLoaded = true;
      refreshMissionsButton.disabled = false;
      if (!disposed) renderMissions();
    }
  }

  // ==== Keyboard shortcuts ================================================
  function onKeyDown(ev: KeyboardEvent): void {
    const target = ev.target instanceof HTMLElement ? ev.target : null;
    if (
      isShortcutSuppressed({
        tagName: target?.tagName ?? '',
        isContentEditable: target?.isContentEditable ?? false,
        ctrlKey: ev.ctrlKey,
        metaKey: ev.metaKey,
        altKey: ev.altKey,
      })
    ) {
      return;
    }
    if (mode === 'live' && (ev.key === '0' || ev.key === '1' || ev.key === '2')) {
      ev.preventDefault();
      void declare(Number(ev.key) as DeclaredState);
      return;
    }
    if (mode === 'annotate' && (ev.key === 'z' || ev.key === 'Z')) {
      ev.preventDefault();
      void undoLastWrite();
    }
  }
  document.addEventListener('keydown', onKeyDown);

  // Only text updates on this tick, never a full re-render -- re-rendering
  // would blur the context-note / label input mid-typing.
  const timer = setInterval(() => {
    if (disposed) return;
    tickReadoutDuration();
    tickPending();
  }, 1000);

  setMode('live');
  void checkForResume();
  syncLive();
  syncAnnotate();

  return () => {
    disposed = true;
    clearInterval(timer);
    document.removeEventListener('keydown', onKeyDown);
  };
}
