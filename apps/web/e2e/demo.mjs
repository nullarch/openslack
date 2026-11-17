// Records the launch demo: one command, a familiar screen, one changed line in
// an existing Bolt app, and the agent answering in a thread. Everything shown
// runs for real: a seeded server, the built client, examples/hello-agent.
//
//   pnpm --filter @app/web build && pnpm --filter @app/web demo
//   → demo.mp4 and demo.gif in SHOTS_DIR (default apps/web/e2e/shots)
import { execFileSync, spawn } from 'node:child_process';
import { readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { root, run, shots, sideItem, sleep, startServer, track } from './lib.mjs';

const brand = readFileSync(join(root, 'packages/shared/src/brand.ts'), 'utf8');
const NAME = /name: '([^']+)'/.exec(brand)[1];
const SLUG = /slug: '([^']+)'/.exec(brand)[1];
const REPO = /repo: '([^']+)'/.exec(brand)[1].replace(/^https:\/\//, '');
const SIZE = { width: 1280, height: 800 };

const CARD_STYLE = `
  html { background: #101114; }
  body { margin: 0; height: 100vh; display: grid; place-items: center; background: #101114; color: #e9e9ee;
         font-family: 'Figtree', system-ui, -apple-system, sans-serif; }
  .wrap { width: 880px; }
  h1 { font-size: 46px; margin: 0 0 28px; letter-spacing: -0.02em; font-weight: 700; }
  h1 em { font-style: normal; color: #f5b83d; }
  .term { background: #1b1c21; border: 1px solid #2c2d35; border-radius: 14px; padding: 26px 30px;
          font: 22px/1.65 'JetBrains Mono', ui-monospace, Menlo, monospace; white-space: pre; }
  .dim { color: #8b8d98; } .ok { color: #7ee2a8; } .hl { background: #3b3216; color: #ffd76a; border-radius: 4px; }
  .prompt { color: #f5b83d; } .cursor { display: inline-block; width: 11px; height: 24px; background: #e9e9ee;
          vertical-align: -4px; animation: b 1s steps(1) infinite; } @keyframes b { 50% { opacity: 0 } }
`;

async function card(page, html, holdMs) {
  // A navigation, not setContent: on a fresh page Chrome's recording otherwise keeps an unpainted strip.
  const doc = `<!doctype html><meta charset="utf-8"><style>${CARD_STYLE}</style><div class="wrap">${html}</div>`;
  await page.goto(`data:text/html;base64,${Buffer.from(doc).toString('base64')}`);
  await sleep(holdMs);
}

async function typeSlowly(locator, text) {
  await locator.pressSequentially(text, { delay: 45 });
}

async function main(browser) {
  const { base } = await startServer({ seed: true });

  // An admin creates the app; its bot joins #random.
  let cookie = '';
  const call = async (method, args = {}) => {
    const response = await fetch(`${base}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(args),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const result = await response.json();
    if (!result.ok) throw new Error(`${method}: ${JSON.stringify(result)}`);
    return result;
  };
  await call('client.signin', { email: 'maya@example.com', password: 'demo-password' });
  const created = await call('client.apps.create', { name: 'Hello Agent', description: 'Built with Bolt' });
  const random = (await call('client.boot')).channels.find((channel) => channel.name === 'random');
  await call('conversations.invite', { channel: random.id, users: created.app.bot_user_id });

  let agentOutput = '';
  const agent = track(
    spawn(process.execPath, [join(root, 'examples/hello-agent/app.mjs')], {
      env: { ...process.env, BOT_TOKEN: created.bot_token, APP_TOKEN: created.app_token, API_URL: `${base}/api/` },
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
  agent.stdout.on('data', (data) => (agentOutput += data));
  for (let i = 0; i < 100 && !agentOutput.includes('connected'); i += 1) await sleep(100);
  if (!agentOutput.includes('connected')) throw new Error(`agent did not connect: ${agentOutput}`);

  const videoDir = join(shots, 'demo-raw');
  rmSync(videoDir, { recursive: true, force: true });
  const context = await browser.newContext({ viewport: SIZE, colorScheme: 'dark', recordVideo: { dir: videoDir, size: SIZE } });
  const page = await context.newPage();

  // 1. One command.
  await card(
    page,
    `<h1>Open-source Slack. <em>One command.</em></h1>
     <div class="term"><span class="prompt">$</span> npx ${SLUG}
<span class="dim">${NAME} 0.1.0</span>
<span class="dim">  open     </span><span class="ok">http://localhost:3000</span>
<span class="dim">  data     ~/.${SLUG}</span>   <span class="dim"># one SQLite file, nothing else to install</span>
<span class="cursor"></span></div>`,
    3800,
  );

  // 2. A screen people already know.
  await page.goto(base);
  await page.waitForURL('**/signin');
  await typeSlowly(page.locator('input[type="email"]'), 'maya@example.com');
  await page.fill('input[type="password"]', 'demo-password');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.sidebar .side-item');
  await sideItem(page, 'engineering').click();
  await page.locator('.message-scroll .msg', { hasText: 'checkout test started failing' }).last().locator('.thread-summary').click();
  await page.locator('.panel .md .code-block').first().waitFor();
  // Park the pointer where it highlights nothing.
  await page.mouse.move(640, 14);
  await sleep(3200);

  // 3. One line in an existing Bolt app.
  await card(
    page,
    `<h1>Your Slack bots already speak it.</h1>
     <div class="term"><span class="dim">// an unmodified Bolt app</span>
const app = new App({
  token, appToken, socketMode: true,
  <span class="hl">clientOptions: { slackApiUrl: 'http://localhost:3000/api/' },</span>
});</div>`,
    4200,
  );

  // 4. The agent answers in a thread: status, streamed Markdown, buttons.
  await page.goto(base);
  await page.waitForSelector('.sidebar .side-item');
  await sideItem(page, 'random').click();
  await page.waitForSelector('.conv-name:text-is("random")');
  const composer = page.locator('.conversation .composer-input');
  await typeSlowly(composer, '@Hello');
  await page.locator('.suggest-item', { hasText: 'Hello Agent' }).first().waitFor();
  await sleep(400);
  await composer.press('Enter');
  await typeSlowly(composer, 'what has been going on in here?');
  await sleep(300);
  await composer.press('Enter');
  const mention = page.locator('.message-scroll .msg', { hasText: 'what has been going on in here?' }).last();
  await mention.locator('.thread-summary').click({ timeout: 15_000 });
  await page.mouse.move(640, 14);
  const confirm = page.locator('.panel').getByRole('button', { name: 'Looks right' });
  await confirm.waitFor({ timeout: 20_000 });
  await sleep(1800);
  await confirm.hover();
  await sleep(500);
  await confirm.click();
  await page.locator('.panel .msg', { hasText: 'Confirmed by' }).waitFor({ timeout: 10_000 });
  await page.mouse.move(640, 14);
  await sleep(2200);

  // 5. Where to get it.
  await card(
    page,
    `<h1>${NAME}</h1>
     <div class="term"><span class="prompt">$</span> npx ${SLUG}
<span class="dim">${REPO} · Apache-2.0 · no user cap, no paid edition</span></div>`,
    3000,
  );

  await context.close();

  const raw = readdirSync(videoDir).find((file) => file.endsWith('.webm'));
  const webm = join(shots, 'demo.webm');
  renameSync(join(videoDir, raw), webm);
  rmSync(videoDir, { recursive: true, force: true });
  const mp4 = join(shots, 'demo.mp4');
  const gif = join(shots, 'demo.gif');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '23', '-movflags', '+faststart', mp4]);
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error', '-i', webm,
    '-vf', 'fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4',
    gif,
  ]);
  console.log(`demo recorded:\n  ${mp4}\n  ${gif}`);
}

// run() launches Chrome, and stops the server and the agent (by PID) when done.
await run(main);
