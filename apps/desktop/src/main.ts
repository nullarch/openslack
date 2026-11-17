import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND } from '@app/shared';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, type MenuItemConstructorOptions } from 'electron';

/**
 * The desktop app: the server's own web client in a window of its own, plus
 * what a browser tab cannot do well — a dock/taskbar badge with the unread
 * count, a deep-link scheme, several servers side by side (each with its own
 * cookies), and links to other sites opening in the default browser.
 */

interface Server {
  url: string;
  name: string;
}

interface State {
  servers: Server[];
  current: string | null;
}

const SCHEME = BRAND.slug;

// Tests and portable installs point the profile somewhere else.
if (process.env.APP_USER_DATA) app.setPath('userData', process.env.APP_USER_DATA);

const stateFile = (): string => join(app.getPath('userData'), 'servers.json');

function loadState(): State {
  try {
    const parsed = JSON.parse(readFileSync(stateFile(), 'utf8')) as State;
    if (Array.isArray(parsed.servers)) return { servers: parsed.servers, current: parsed.current ?? null };
  } catch {
    // First run.
  }
  return { servers: [], current: null };
}

function saveState(state: State): void {
  mkdirSync(app.getPath('userData'), { recursive: true });
  writeFileSync(stateFile(), JSON.stringify(state, null, 2));
}

/** Each server keeps its own cookies and storage. */
function partitionFor(url: string): string {
  return `persist:server-${createHash('sha256').update(url).digest('hex').slice(0, 16)}`;
}

/** Normalise and check an address the person typed: it must answer like one of our servers. */
async function probe(input: string): Promise<Server> {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`);
  } catch {
    throw new Error('That is not a web address.');
  }
  const origin = url.origin;
  const response = await fetch(`${origin}/api/client.status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => null);
  const status = response?.ok ? ((await response.json()) as { ok?: boolean; team?: { name?: string } | null }) : null;
  if (!status?.ok) throw new Error(`No ${BRAND.name} server answered at ${origin}.`);
  return { url: origin, name: status.team?.name ?? new URL(origin).host };
}

let state: State;
let window: BrowserWindow | null = null;
const views = new Map<string, BrowserWindow>();
let pendingDeepLink: string | null = null;

function setBadge(count: number): void {
  app.setBadgeCount(count);
  if (process.platform === 'darwin') app.dock?.setBadge(count > 0 ? String(count) : '');
}

/** The web client puts the unread count in the title as "(3) …". */
function watchTitle(target: BrowserWindow): void {
  target.webContents.on('page-title-updated', (_event, title) => {
    if (target !== window) return;
    const match = /^\((\d+)\)/.exec(title);
    setBadge(match ? Number(match[1]) : 0);
  });
}

/** Links to other sites open in the default browser; the window only ever shows its server. */
function keepToServer(target: BrowserWindow, origin: string): void {
  target.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && new URL(url).origin !== origin) void shell.openExternal(url);
    else if (url.startsWith(origin)) void target.loadURL(url);
    return { action: 'deny' };
  });
  target.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('file:')) return;
    if (new URL(url).origin !== origin) {
      event.preventDefault();
      if (/^https?:/i.test(url)) void shell.openExternal(url);
    }
  });
}

function showServer(server: Server, path = '/'): void {
  let view = views.get(server.url);
  if (!view) {
    view = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 420,
      minHeight: 500,
      title: server.name,
      show: false,
      webPreferences: { partition: partitionFor(server.url), contextIsolation: true, sandbox: true, spellcheck: true },
    });
    keepToServer(view, server.url);
    watchTitle(view);
    view.on('close', (event) => {
      // Closing a window hides it; the app keeps running for notifications (like a chat app should).
      if (!quitting && process.platform === 'darwin') {
        event.preventDefault();
        view?.hide();
      }
    });
    view.on('closed', () => views.delete(server.url));
    views.set(server.url, view);
    void view.loadURL(`${server.url}${path}`);
  } else if (path !== '/') {
    void view.loadURL(`${server.url}${path}`);
  }
  for (const [url, other] of views) if (url !== server.url) other.hide();
  window = view;
  view.show();
  view.focus();
  state.current = server.url;
  saveState(state);
  buildMenu();
}

async function addServer(): Promise<void> {
  const prompt = new BrowserWindow({
    width: 460,
    height: 300,
    resizable: false,
    title: 'Add a server',
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  await prompt.loadFile(join(__dirname, 'add-server.html'));
}

ipcMain.handle('add-server', async (event, input: string) => {
  try {
    const server = await probe(input);
    if (!state.servers.some((entry) => entry.url === server.url)) state.servers.push(server);
    saveState(state);
    BrowserWindow.fromWebContents(event.sender)?.close();
    showServer(server);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('brand', () => ({ name: BRAND.name }));

function removeServer(server: Server): void {
  state.servers = state.servers.filter((entry) => entry.url !== server.url);
  views.get(server.url)?.destroy();
  views.delete(server.url);
  if (state.current === server.url) state.current = state.servers[0]?.url ?? null;
  saveState(state);
  const next = state.servers[0];
  if (next) showServer(next);
  else void addServer();
  buildMenu();
}

function buildMenu(): void {
  const serverItems: MenuItemConstructorOptions[] = state.servers.map((server, index) => ({
    label: server.name,
    sublabel: server.url,
    type: 'radio',
    checked: server.url === state.current,
    accelerator: index < 9 ? `CmdOrCtrl+Shift+${index + 1}` : undefined,
    click: () => showServer(server),
  }));
  const current = state.servers.find((server) => server.url === state.current);
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    {
      label: 'Servers',
      submenu: [
        ...serverItems,
        { type: 'separator' },
        { label: 'Add a server…', accelerator: 'CmdOrCtrl+Shift+N', click: () => void addServer() },
        ...(current ? [{ label: `Remove ${current.name}`, click: () => current && removeServer(current) }] : []),
      ],
    },
    { role: 'windowMenu' },
    { role: 'help', submenu: [{ label: `About ${BRAND.name}`, click: () => void shell.openExternal(BRAND.repo) }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * `<scheme>://<host>/<path>` opens that path on that server, e.g. a message
 * permalink handed out as `<scheme>://chat.example.com/archives/C…/p…`.
 */
function openDeepLink(link: string): void {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return;
  }
  if (url.protocol !== `${SCHEME}:`) return;
  const server = state.servers.find((entry) => new URL(entry.url).host === url.host);
  if (!server) {
    void dialog.showMessageBox({ message: `${url.host} is not one of your servers. Add it first.` });
    return;
  }
  const path = `${url.pathname}${url.search}` || '/';
  showServer(server, path.startsWith('/') ? path : `/${path}`);
}

let quitting = false;
app.on('before-quit', () => {
  quitting = true;
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const link = argv.find((arg) => arg.startsWith(`${SCHEME}://`));
    if (link) openDeepLink(link);
    else window?.show();
  });
  app.on('open-url', (event, link) => {
    event.preventDefault();
    if (app.isReady()) openDeepLink(link);
    else pendingDeepLink = link;
  });
  if (!process.env.APP_USER_DATA) app.setAsDefaultProtocolClient(SCHEME);

  void app.whenReady().then(async () => {
    state = loadState();
    // A server can be given on the command line or in the environment (first run, kiosks, tests).
    const given = process.env.APP_SERVER_URL ?? process.argv.find((arg) => /^https?:\/\//.test(arg));
    if (given && !state.servers.some((entry) => entry.url === new URL(given).origin)) {
      try {
        state.servers.push(await probe(given));
        state.current = new URL(given).origin;
        saveState(state);
      } catch (error) {
        console.error(error);
      }
    }
    buildMenu();
    const current = state.servers.find((server) => server.url === state.current) ?? state.servers[0];
    if (current) showServer(current);
    else await addServer();
    const link = pendingDeepLink ?? process.argv.find((arg) => arg.startsWith(`${SCHEME}://`));
    if (link) openDeepLink(link);
    if (process.platform === 'darwin') app.dock?.setIcon(nativeImage.createEmpty());
  });

  app.on('activate', () => {
    if (window) window.show();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
