// Shown by the app when a server's page cannot load (Capacitor's errorPath):
// a way to try again, the way back to the list, and the recent messages the
// web client saved in the app's storage (apps/web/src/lib/native.ts), to read.

const TEXT = {
  en: {
    title: "Can't reach the server",
    lead: (server) => `${server} is not answering. Check your connection.`,
    retry: 'Try again',
    servers: 'Servers',
    saved: 'Saved for reading',
    when: (date) => `As of ${date}. New messages appear once you are back online.`,
    files: 'Files',
  },
  ko: {
    title: '서버에 연결할 수 없어요',
    lead: (server) => `${server} 서버가 응답하지 않아요. 연결을 확인하세요.`,
    retry: '다시 시도',
    servers: '서버 목록',
    saved: '저장해 둔 메시지',
    when: (date) => `${date} 기준이에요. 다시 연결되면 새 메시지가 보여요.`,
    files: '파일',
  },
  ja: {
    title: 'サーバーに接続できません',
    lead: (server) => `${server} が応答しません。接続を確認してください。`,
    retry: '再試行',
    servers: 'サーバー一覧',
    saved: '保存済みのメッセージ',
    when: (date) => `${date} 時点の内容です。再接続すると新しいメッセージが表示されます。`,
    files: 'ファイル',
  },
};

const language = (navigator.languages || [navigator.language || 'en']).map((tag) => tag.slice(0, 2)).find((tag) => tag in TEXT) || 'en';
const t = TEXT[language];
document.documentElement.lang = language;

let server = '';
try {
  server = localStorage.getItem('last-server') || '';
} catch {
  server = '';
}

document.getElementById('title').textContent = t.title;
document.getElementById('lead').textContent = t.lead(server.replace(/^https?:\/\//, '') || '');
document.getElementById('retry').textContent = t.retry;
document.getElementById('servers').textContent = t.servers;
document.getElementById('saved-title').textContent = t.saved;
document.getElementById('retry').addEventListener('click', () => {
  window.location.href = server ? `${server}/` : 'index.html';
});

function time(ts) {
  return new Date(Number(ts) * 1000).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' });
}

async function show() {
  const preferences = window.Capacitor?.Plugins?.Preferences;
  if (!preferences || !server) return;
  let snapshot = null;
  try {
    const { value } = await preferences.get({ key: `offline:${server}` });
    snapshot = value ? JSON.parse(value) : null;
  } catch {
    snapshot = null;
  }
  if (!snapshot || !Array.isArray(snapshot.conversations) || snapshot.conversations.length === 0) return;
  document.getElementById('saved-when').textContent = t.when(new Date(snapshot.saved).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' }));
  const holder = document.getElementById('conversations');
  snapshot.conversations.forEach((entry, index) => {
    const details = document.createElement('details');
    details.className = 'saved-conversation';
    if (index === 0) details.open = true;
    const summary = document.createElement('summary');
    summary.textContent = entry.direct ? entry.name : `#${entry.name}`;
    details.append(summary);
    const list = document.createElement('ol');
    list.className = 'saved-messages';
    for (const message of entry.messages) {
      const item = document.createElement('li');
      const head = document.createElement('p');
      head.className = 'saved-head';
      const who = document.createElement('strong');
      who.textContent = message.user;
      const when = document.createElement('time');
      when.textContent = time(message.ts);
      head.append(who, ' ', when);
      const body = document.createElement('p');
      body.className = 'saved-text';
      body.textContent = message.text;
      item.append(head, body);
      if (message.files?.length) {
        const files = document.createElement('p');
        files.className = 'saved-files';
        files.textContent = `${t.files}: ${message.files.join(', ')}`;
        item.append(files);
      }
      list.append(item);
    }
    details.append(list);
    holder.append(details);
  });
  document.getElementById('saved').hidden = false;
}

void show();
