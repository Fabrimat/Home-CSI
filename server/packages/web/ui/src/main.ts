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

type ViewRenderer = (container: HTMLElement) => () => void;

const VIEWS: Array<{ path: string; label: string; render: ViewRenderer }> = [
  { path: 'overview', label: 'Overview', render: renderOverview },
  { path: 'waterfall', label: 'Live CSI waterfall', render: renderWaterfall },
  { path: 'health', label: 'Node & link health', render: renderHealth },
  { path: 'occupancy', label: 'Occupancy timeline', render: renderOccupancy },
  { path: 'features', label: 'Feature inspector', render: renderFeatures },
  { path: 'logs', label: 'Log tail', render: renderLogs },
  { path: 'recording', label: 'Recording controls', render: renderRecording },
];

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

  const main = h('main');
  const connBadge = h('span', { class: 'conn-badge bad' }, 'connecting…');
  liveSocket.onStateChange((state) => {
    connBadge.className = `conn-badge ${state === 'open' ? 'ok' : 'bad'}`;
    connBadge.textContent = state === 'open' ? 'live' : state === 'connecting' ? 'connecting…' : 'disconnected';
  });

  const path = currentPath();
  const nav = h(
    'nav',
    { class: 'tabs' },
    ...VIEWS.map((v) =>
      h(
        'a',
        { href: `#/${v.path}`, class: v.path === path ? 'active' : '' },
        v.label,
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

  app!.append(header, main);

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
