import './style.css';
import { clearToken, getToken, setToken } from './api.js';
import { clear, h } from './dom.js';
import { liveSocket } from './ws.js';
import { renderOverview } from './views/overview.js';
import { renderWaterfall } from './views/waterfall.js';
import { renderHealth } from './views/health.js';
import { renderOccupancy } from './views/occupancy.js';
import { renderFeatures } from './views/features.js';
import { renderLogs } from './views/logs.js';
import { renderRecording } from './views/recording.js';
import { renderTraining } from './views/training.js';

type ViewRenderer = (container: HTMLElement) => () => void;
interface ViewDef {
  path: string;
  label: string;
  render: ViewRenderer;
}

/**
 * The eight views grouped into the three natural workflows they fall into
 * (brief B18 information architecture pass), rather than one flat,
 * undifferentiated row: live monitoring (what's happening right now),
 * analysis (reviewing/correcting what the system already recorded), and
 * ground truth (declaring what actually happened, for training). `VIEWS`
 * below is derived from this, so the router/dispatch logic still only has
 * to know about one flat list.
 */
const NAV_GROUPS: Array<{ label: string; views: ViewDef[] }> = [
  {
    label: 'Live monitoring',
    views: [
      { path: 'overview', label: 'Overview', render: renderOverview },
      { path: 'waterfall', label: 'Live CSI waterfall', render: renderWaterfall },
      { path: 'health', label: 'Node & link health', render: renderHealth },
    ],
  },
  {
    label: 'Analysis',
    views: [
      { path: 'occupancy', label: 'Occupancy timeline', render: renderOccupancy },
      { path: 'features', label: 'Feature inspector', render: renderFeatures },
      { path: 'logs', label: 'Log tail', render: renderLogs },
    ],
  },
  {
    label: 'Ground truth',
    views: [
      { path: 'recording', label: 'Recording controls', render: renderRecording },
      { path: 'training', label: 'Training mode', render: renderTraining },
    ],
  },
];

const VIEWS: ViewDef[] = NAV_GROUPS.flatMap((g) => g.views);

const app = document.getElementById('app');
if (!app) throw new Error('missing #app root element');

let activeCleanup: (() => void) | null = null;

function currentPath(): string {
  const hash = location.hash.replace(/^#\/?/, '');
  return hash || 'overview';
}

function renderShell(): void {
  clear(app as HTMLElement);

  if (!getToken()) {
    app!.append(renderTokenGate());
    return;
  }

  // `id`/`tabindex="-1"` make <main> a real, programmatically focusable
  // landmark: the skip link below moves focus here directly, and each view
  // renders into it without needing to manage focus itself.
  const main = h('main', { id: 'main-content', tabindex: -1 });

  // The connection badge flips (connecting/live/disconnected) on every
  // reconnect, including brief, expected churn while the WebSocket backs
  // off and retries -- turning that into an `aria-live="assertive"`
  // announcement would interrupt a screen reader user every few seconds
  // during a flaky link, which is worse than saying nothing. `role="status"`
  // (implicit `aria-live="polite"`) is the deliberate middle ground: a
  // change is still queued and read out, but only at the next pause, and
  // never cuts off whatever is currently being read.
  const connBadge = h('span', { class: 'conn-badge bad', role: 'status' }, 'connecting…');
  liveSocket.onStateChange((state) => {
    connBadge.className = `conn-badge ${state === 'open' ? 'ok' : 'bad'}`;
    connBadge.textContent = state === 'open' ? 'live' : state === 'connecting' ? 'connecting…' : 'disconnected';
  });

  const path = currentPath();
  // Grouped into the three workflows in NAV_GROUPS (live monitoring /
  // analysis / ground truth) rather than one flat row of eight -- each
  // group is its own `role="group"` with an accessible name, so assistive
  // tech gets the same structure a sighted user sees via the divider/label
  // in CSS. See the `@media (max-width: 640px)` block in style.css for how
  // this collapses on a phone (the training-mode use case this whole pass
  // was partly motivated by).
  const nav = h(
    'nav',
    { class: 'tabs', 'aria-label': 'Dashboard views' },
    ...NAV_GROUPS.map((group) =>
      h(
        'div',
        { class: 'tab-group', role: 'group', 'aria-label': group.label },
        // `aria-hidden`: the group `div` already carries this same text as
        // its `aria-label`, so assistive tech announces it once (as the
        // group's accessible name) rather than twice (name + duplicate
        // visible text node inside it). Sighted users still see it.
        h('span', { class: 'tab-group-label', 'aria-hidden': 'true' }, group.label),
        ...group.views.map((v) =>
          h(
            'a',
            {
              href: `#/${v.path}`,
              class: v.path === path ? 'active' : '',
              'aria-current': v.path === path ? 'page' : undefined,
            },
            v.label,
          ),
        ),
      ),
    ),
  );

  const header = h(
    'header',
    { class: 'app-header' },
    h('h1', {}, 'Home CSI'),
    nav,
    connBadge,
    h(
      'button',
      {
        title: 'Forget the stored API token',
        onclick: () => {
          liveSocket.disconnect();
          clearToken();
          renderShell();
        },
      },
      'Log out',
    ),
  );

  // Skip link: the first focusable element on the page, invisible until
  // focused, jumping straight past the header/nav to the view content.
  // Without it, a keyboard/screen-reader user has to tab through the header
  // and all eight (grouped) nav links on every single page load. Click is
  // handled manually (rather than relying on the plain `href="#main-content"`
  // anchor jump) because this app's own router treats EVERY hash change as
  // a view navigation (see `currentPath`/`hashchange` below) -- letting the
  // browser set `location.hash = '#main-content'` natively would fire that
  // listener, fail to match any view path, and silently bounce the user
  // back to the first view instead of just moving focus.
  const skipLink = h(
    'a',
    {
      href: '#main-content',
      class: 'skip-link',
      onclick: (ev: Event) => {
        ev.preventDefault();
        main.focus();
      },
    },
    'Skip to main content',
  );

  app!.append(skipLink, header, main);

  const view = VIEWS.find((v) => v.path === path) ?? VIEWS[0];
  activeCleanup?.();
  activeCleanup = view!.render(main);

  liveSocket.connect();
}

function renderTokenGate(): HTMLElement {
  const input = h('input', {
    type: 'password',
    placeholder: 'server.apiToken from config.yaml',
    autocomplete: 'off',
  }) as HTMLInputElement;

  const submit = (): void => {
    const value = input.value.trim();
    if (!value) return;
    setToken(value);
    renderShell();
  };

  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') submit();
  });

  return h(
    'div',
    { class: 'token-gate panel' },
    h('h2', {}, 'Home CSI debug console'),
    h('p', {}, 'Enter the API bearer token to continue. It is stored only in this browser (localStorage).'),
    h('div', { class: 'controls' }, h('label', {}, 'API token', input), h('button', { onclick: submit }, 'Continue')),
  );
}

window.addEventListener('hashchange', renderShell);
renderShell();
