// The app's own page: the servers this person uses. Choosing one loads that
// server's web client in the app; the web client offers the way back here
// ("Switch server"). Plain JavaScript, no build step.

const STORE = 'servers';
const LAST = 'last-server';

const TEXT = {
  en: {
    title: 'Your servers',
    lead: "Add the address of your team's server.",
    address: 'Server address',
    add: 'Add and open',
    checking: 'Checking…',
    remove: 'Remove',
    unreachable: 'No server answered at that address. Check it and your connection.',
    invalid: 'Enter an address such as chat.example.com.',
  },
  ko: {
    title: '내 서버',
    lead: '팀 서버 주소를 추가하세요.',
    address: '서버 주소',
    add: '추가하고 열기',
    checking: '확인하는 중…',
    remove: '삭제',
    unreachable: '그 주소에서 응답하는 서버가 없어요. 주소와 연결을 확인하세요.',
    invalid: 'chat.example.com 같은 주소를 입력하세요.',
  },
  ja: {
    title: 'サーバー',
    lead: 'チームのサーバーのアドレスを追加してください。',
    address: 'サーバーのアドレス',
    add: '追加して開く',
    checking: '確認しています…',
    remove: '削除',
    unreachable: 'そのアドレスで応答するサーバーがありません。アドレスと接続を確認してください。',
    invalid: 'chat.example.com のようなアドレスを入力してください。',
  },
};

const language = (navigator.languages || [navigator.language || 'en']).map((tag) => tag.slice(0, 2)).find((tag) => tag in TEXT) || 'en';
const t = TEXT[language];
document.documentElement.lang = language;

function load() {
  try {
    const list = JSON.parse(localStorage.getItem(STORE) || '[]');
    return Array.isArray(list) ? list.filter((entry) => entry && typeof entry.url === 'string') : [];
  } catch {
    return [];
  }
}

function save(list) {
  try {
    localStorage.setItem(STORE, JSON.stringify(list));
  } catch {
    // Storage refused: the list lasts until the app closes.
  }
}

/** `chat.example.com` → `https://chat.example.com`; a path or trailing slash is dropped. */
function normalise(input) {
  let value = input.trim();
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

/** Ask the server who it is, natively (the server sends no CORS headers for this page). */
async function probe(origin) {
  const http = window.Capacitor?.Plugins?.CapacitorHttp;
  try {
    if (http) {
      const answer = await http.get({ url: `${origin}/manifest.webmanifest`, connectTimeout: 8000, readTimeout: 8000 });
      const data = typeof answer.data === 'string' ? JSON.parse(answer.data) : answer.data;
      return answer.status === 200 ? String(data?.name || origin) : null;
    }
    const response = await fetch(`${origin}/manifest.webmanifest`);
    return response.ok ? String((await response.json()).name || origin) : null;
  } catch {
    return null;
  }
}

function open(origin) {
  try {
    localStorage.setItem(LAST, origin);
  } catch {
    // Not remembered: the list shows next time.
  }
  window.location.href = `${origin}/`;
}

function render() {
  document.getElementById('title').textContent = t.title;
  document.getElementById('lead').textContent = t.lead;
  document.getElementById('address-label').textContent = t.address;
  document.getElementById('submit').textContent = t.add;
  const list = document.getElementById('servers');
  list.replaceChildren();
  for (const server of load()) {
    const item = document.createElement('li');
    item.className = 'server';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'open';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = server.name || server.url;
    const address = document.createElement('span');
    address.className = 'address';
    address.textContent = server.url.replace(/^https:\/\//, '');
    button.append(name, address);
    button.addEventListener('click', () => open(server.url));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove';
    remove.textContent = t.remove;
    remove.setAttribute('aria-label', `${t.remove}: ${server.name || server.url}`);
    remove.addEventListener('click', () => {
      save(load().filter((entry) => entry.url !== server.url));
      render();
    });
    item.append(button, remove);
    list.append(item);
  }
}

document.getElementById('add').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = document.getElementById('error');
  const submit = document.getElementById('submit');
  const origin = normalise(document.getElementById('address').value);
  error.hidden = true;
  if (!origin) {
    error.textContent = t.invalid;
    error.hidden = false;
    return;
  }
  submit.disabled = true;
  submit.textContent = t.checking;
  const name = await probe(origin);
  submit.disabled = false;
  submit.textContent = t.add;
  if (!name) {
    error.textContent = t.unreachable;
    error.hidden = false;
    return;
  }
  save([...load().filter((entry) => entry.url !== origin), { url: origin, name }]);
  open(origin);
});

/**
 * A server to open, from a link (`<scheme>://open?server=https://chat.example.com`)
 * or from the web client (`?open=` on this page): added to the list once it
 * answers, then opened.
 */
async function openFromLink(server) {
  const origin = normalise(server || '');
  if (!origin) return false;
  if (!load().some((entry) => entry.url === origin)) {
    const name = await probe(origin);
    if (!name) {
      const error = document.getElementById('error');
      error.textContent = t.unreachable;
      error.hidden = false;
      document.getElementById('address').value = origin;
      return true;
    }
    save([...load(), { url: origin, name }]);
  }
  open(origin);
  return true;
}

function serverInLink(link) {
  try {
    const url = new URL(link);
    return url.host === 'open' || url.pathname.replace(/^\/+/, '') === 'open' ? url.searchParams.get('server') : null;
  } catch {
    return null;
  }
}

async function start() {
  render();
  const params = new URLSearchParams(window.location.search);
  if (params.has('open') && (await openFromLink(params.get('open')))) return;
  const app = window.Capacitor?.Plugins?.App;
  if (app) {
    app.addListener('appUrlOpen', (event) => void openFromLink(serverInLink(event.url)));
    const launched = await app.getLaunchUrl().catch(() => null);
    if (launched?.url && (await openFromLink(serverInLink(launched.url)))) return;
  }
  // Straight back to the server used last, unless the person came here to switch.
  let last = null;
  try {
    last = localStorage.getItem(LAST);
  } catch {
    last = null;
  }
  if (!params.has('switch') && last && load().some((entry) => entry.url === last)) open(last);
}

void start();
