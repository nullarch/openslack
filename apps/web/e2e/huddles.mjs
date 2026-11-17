// Huddles in a real browser against a real LiveKit media server.
//
//   LIVEKIT_SERVER_BIN=/path/to/livekit-server pnpm --filter @app/web e2e:huddles
//
// Two Chrome profiles with fake camera and microphone join a huddle, hear each
// other, see a camera, share a screen, send reactions, post in the huddle's
// thread, and leave. Without a LiveKit binary the run is skipped, not failed.
import assert from 'node:assert/strict';
import { findLiveKit, startLiveKit } from './livekit.mjs';
import { browserName, freePort, openChannel, run, shot, sideItem, signIn, skip, startServer, step, watch, wide } from './lib.mjs';

/** The LiveKit client's view of the call in this page. */
const state = (page) => page.evaluate(() => (window.__huddleState ? window.__huddleState() : { connected: false }));

async function until(page, predicate, label, timeout = 20_000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    last = await state(page);
    if (predicate(last)) return last;
    await page.waitForTimeout(250);
  }
  throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

const remote = (snapshot, identity) => (snapshot.remote ?? []).find((participant) => participant.identity === identity);

if (!findLiveKit()) {
  skip('huddles', 'livekit-server not found; set LIVEKIT_SERVER_BIN');
  process.exit(0);
}

/** Start LiveKit and a seeded server wired to it. */
async function startStack() {
  const port = await freePort();
  const livekit = await startLiveKit({ webhookUrl: `http://127.0.0.1:${port}/livekit/webhook` });
  return startServer({
    seed: true,
    port,
    env: {
      LIVEKIT_URL: livekit.url,
      LIVEKIT_API_KEY: livekit.apiKey,
      LIVEKIT_API_SECRET: livekit.apiSecret,
      HUDDLE_RECONCILE_MS: '2000',
      HUDDLE_JOIN_GRACE_MS: '6000',
    },
  });
}

const apiCall = (page, method, args) =>
  page.evaluate(
    async ([name, body]) => {
      const response = await fetch(`/api/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!result.ok) throw new Error(`${name}: ${result.error}`);
      return result;
    },
    [method, args],
  );

if (browserName === 'webkit') {
  // Playwright's WebKit build gathers no ICE candidates at all (two RTCPeerConnections in one page never
  // connect), so no media can flow through LiveKit. What can be checked here is that the huddle UI renders.
  skip('huddles: audio, video, screen share, reactions', "Playwright's WebKit build cannot make WebRTC connections (no ICE candidates)");
  await run(async (browser) => {
    const { base } = await startStack();
    const maya = watch(await (await browser.newContext({ ...wide, colorScheme: 'light' })).newPage());
    const daniel = watch(await (await browser.newContext({ ...wide })).newPage());
    await signIn(maya, base, 'maya@example.com');
    await signIn(daniel, base, 'daniel@example.com');

    await step('the huddle button, header pill, sidebar marker and cards render (joined without media)', async () => {
      await openChannel(maya, 'engineering');
      await openChannel(daniel, 'engineering');
      await maya.locator('[data-huddle-start]').waitFor();
      const channel = new URL(daniel.url()).pathname.split('/').pop();
      await apiCall(daniel, 'client.huddles.join', { channel });
      await maya.locator('[data-huddle-pill] button', { hasText: 'Join' }).waitFor();
      await sideItem(maya, 'engineering').locator('.side-huddle', { hasText: '1' }).waitFor();
      await maya.locator('[data-huddle-card="live"]').waitFor();
      await shot(maya, 'huddle-webkit-live');
      await apiCall(daniel, 'client.huddles.leave', { channel });
      await maya.locator('[data-huddle-card="ended"]').waitFor();
      await maya.locator('[data-huddle-pill]').waitFor({ state: 'detached' });
      assert.match(await maya.locator('[data-huddle-card="ended"]').last().innerText(), /Lasted/);
    });
  });
  process.exit(process.exitCode ?? 0);
}

await run(
  async (browser) => {
    const { base } = await startStack();

    const context = (scheme) =>
      // Only Chromium takes camera and microphone permissions here; Firefox uses the prefs above.
      browser.newContext({ ...wide, colorScheme: scheme, ...(browserName === 'chrome' ? { permissions: ['microphone', 'camera'] } : {}) });
    const mayaContext = await context('dark');
    let danielContext = await context('light');
    const maya = watch(await mayaContext.newPage(), /getDisplayMedia|NotAllowedError|Permission denied/);
    let daniel = watch(await danielContext.newPage(), /getDisplayMedia|NotAllowedError|Permission denied/);
    await signIn(maya, base, 'maya@example.com');
    await signIn(daniel, base, 'daniel@example.com');
    let mayaId;
    let danielId;

    await step('starting a huddle connects to LiveKit and shows it everywhere', async () => {
      await openChannel(maya, 'engineering');
      await openChannel(daniel, 'engineering');
      await maya.locator('[data-huddle-start]').click();
      await maya.locator('[data-huddle-dock][data-status="connected"]').waitFor({ timeout: 20_000 });
      const mine = await until(maya, (s) => s.connected && s.local?.audio, 'Maya connected with a microphone');
      mayaId = mine.local.identity;
      // Daniel sees it in the header, the sidebar and as a message in the channel.
      await daniel.locator('[data-huddle-pill]').waitFor();
      await sideItem(daniel, 'engineering').locator('.side-huddle', { hasText: '1' }).waitFor();
      await daniel.locator('[data-huddle-card="live"]').waitFor();
    });

    await step('a second person joins and each hears the other', async () => {
      await daniel.locator('[data-huddle-pill] button', { hasText: 'Join' }).click();
      const theirs = await until(daniel, (s) => s.connected && remote(s, mayaId)?.audio, "Daniel receiving Maya's audio");
      danielId = theirs.local.identity;
      await until(maya, (s) => remote(s, danielId)?.audio, "Maya receiving Daniel's audio");
      await sideItem(maya, 'engineering').locator('.side-huddle', { hasText: '2' }).waitFor();
      assert.equal(await maya.locator('.huddle-dock-person').count(), 2);
      // Remote audio is actually playing through an <audio> element.
      assert.ok(await daniel.evaluate(() => document.querySelectorAll('audio').length >= 1));
    });

    await step('a camera turned on is seen by the other person as live video', async () => {
      await daniel.locator('[data-control="camera"]').click();
      await until(maya, (s) => remote(s, danielId)?.camera, "Daniel's camera at Maya");
      await maya.locator('[data-huddle-dock] [data-control="expand"]').click();
      await maya.locator('[data-huddle-stage]').waitFor();
      const video = maya.locator(`[data-tile="${danielId}"][data-source="camera"] video`);
      await video.waitFor();
      await maya.waitForFunction(
        (id) => {
          const element = document.querySelector(`[data-tile="${id}"][data-source="camera"] video`);
          return element instanceof HTMLVideoElement && element.videoWidth > 0 && element.readyState >= 2;
        },
        danielId,
        { timeout: 20_000 },
      );
    });

    await step('reactions float over the other person’s stage', async () => {
      await daniel.locator('[data-huddle-dock] [data-control="react"]').click();
      await daniel.locator('.huddle-reaction-choice', { hasText: '🎉' }).click();
      await maya.locator('[data-huddle-stage] .huddle-reaction', { hasText: '🎉' }).waitFor({ timeout: 5000 });
      await shot(maya, 'huddle-stage-dark');
    });

    await step('screen sharing reaches the other person', async () => {
      await maya.locator('[data-huddle-stage] [data-control="screen"]').click();
      try {
        await until(daniel, (s) => remote(s, mayaId)?.screen, "Maya's screen at Daniel", 15_000);
      } catch (error) {
        throw new Error(`screen share did not arrive (${error.message})`);
      }
      await daniel.locator('[data-huddle-dock] [data-control="expand"]').click();
      await daniel.waitForFunction(
        (id) => {
          const element = document.querySelector(`[data-tile="${id}"][data-source="screen"] video`);
          return element instanceof HTMLVideoElement && element.videoWidth > 0;
        },
        mayaId,
        { timeout: 20_000 },
      );
      await shot(daniel, 'huddle-stage-screen-light');
      await maya.locator('[data-huddle-stage] [data-control="screen"]').click();
      await until(daniel, (s) => !remote(s, mayaId)?.screen, 'screen share stopped');
      await daniel.locator('[data-huddle-stage] [data-control="expand"]').click();
      await maya.locator('[data-huddle-stage] [data-control="expand"]').click();
    });

    await step('messages posted in the huddle thread land there', async () => {
      await maya.locator('[data-huddle-dock] [data-control="thread"]').click();
      const panel = maya.locator('.panel');
      await panel.locator('[data-huddle-card]').waitFor();
      const input = panel.locator('.composer-input');
      await input.fill('Agenda for this call: https://example.com/agenda');
      await input.press('Enter');
      await panel.locator('.msg', { hasText: 'Agenda for this call' }).waitFor();
      // Daniel sees the reply count grow on the huddle message.
      await daniel.locator('.message-scroll .msg', { has: daniel.locator('[data-huddle-card]') }).locator('.thread-summary').waitFor();
      await shot(daniel, 'huddle-card-light');
    });

    await step('captions: words spoken in one browser appear for the other, only while unmuted', async () => {
      // A stand-in for the browser's speech recognition, driven by the test.
      const fake = () => {
        class FakeRecognition {
          constructor() {
            window.__recognizers = [...(window.__recognizers ?? []), this];
          }
          start() {
            this.running = true;
          }
          stop() {
            this.running = false;
            this.onend?.();
          }
        }
        window.SpeechRecognition = FakeRecognition;
        window.webkitSpeechRecognition = FakeRecognition;
        window.__say = (text, isFinal) => {
          const live = (window.__recognizers ?? []).filter((recognizer) => recognizer.running);
          for (const recognizer of live) recognizer.onresult?.({ resultIndex: 0, results: [{ isFinal, 0: { transcript: text } }] });
          return live.length;
        };
      };
      await maya.evaluate(fake);
      await daniel.evaluate(fake);
      await maya.locator('[data-huddle-dock] [data-control="captions"]').click();
      await maya.locator('.toast', { hasText: 'saved as a transcript' }).waitFor();
      await daniel.locator('[data-huddle-dock] [data-control="captions"]').click();
      assert.equal(await maya.evaluate(() => window.__say('we ship on', false)), 1);
      await daniel.locator('[data-huddle-captions] .huddle-caption.is-interim', { hasText: 'we ship on' }).waitFor();
      await maya.evaluate(() => window.__say('We ship on Friday.', true));
      await daniel.locator('[data-huddle-captions] .huddle-caption:not(.is-interim)', { hasText: 'We ship on Friday.' }).waitFor();
      await daniel.locator('[data-huddle-captions] .huddle-caption.is-interim').waitFor({ state: 'detached' });
      await shot(daniel, 'huddle-captions-dock');
      // Muted: this browser stops listening; unmuted: it listens again.
      await maya.locator('[data-huddle-dock] [data-control="mic"]').click();
      await maya.waitForFunction(() => window.__say('muted words', true) === 0);
      await maya.locator('[data-huddle-dock] [data-control="mic"]').click();
      await maya.waitForFunction(() => (window.__recognizers ?? []).some((recognizer) => recognizer.running));
      await daniel.locator('[data-huddle-dock] [data-control="expand"]').click();
      await maya.evaluate(() => window.__say('And the notes go in the thread.', true));
      await daniel.locator('[data-huddle-stage] [data-huddle-captions] .huddle-caption', { hasText: 'And the notes go in the thread.' }).waitFor();
      await shot(daniel, 'huddle-captions-stage');
      await daniel.locator('[data-huddle-stage] [data-control="expand"]').click();
    });

    await step('a tab that closes without telling the server is dropped by LiveKit’s webhook', async () => {
      // Suppress the leave request a closing tab sends, so only LiveKit can tell the server.
      await daniel.evaluate(() => {
        navigator.sendBeacon = () => true;
      });
      await danielContext.close();
      await maya.waitForFunction(() => document.querySelectorAll('.huddle-dock-person').length === 1, null, { timeout: 15_000 });
      await sideItem(maya, 'engineering').locator('.side-huddle', { hasText: '1' }).waitFor();
      danielContext = await context('light');
      daniel = watch(await danielContext.newPage(), /getDisplayMedia|NotAllowedError|Permission denied/);
      await signIn(daniel, base, 'daniel@example.com');
      await openChannel(daniel, 'engineering');
    });

    await step('someone who joins but never connects to the media server is dropped after a grace period', async () => {
      // A join through the API alone: listed at once, but LiveKit never sees them.
      await daniel.evaluate(async (channel) => {
        const response = await fetch('/api/client.huddles.join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel }) });
        if (!(await response.json()).ok) throw new Error('join failed');
      }, new URL(daniel.url()).pathname.split('/').pop());
      await sideItem(maya, 'engineering').locator('.side-huddle', { hasText: '2' }).waitFor();
      // Grace 6 s, comparison every 2 s.
      await sideItem(maya, 'engineering').locator('.side-huddle', { hasText: '1' }).waitFor({ timeout: 15_000 });
    });

    await step('leaving ends the huddle and leaves a summary in the channel', async () => {
      await maya.locator('[data-huddle-dock] [data-control="leave"]').click();
      await maya.locator('[data-huddle-dock]').waitFor({ state: 'detached' });
      const card = daniel.locator('[data-huddle-card="ended"]').last();
      await card.waitFor({ timeout: 10_000 });
      const text = await card.innerText();
      assert.match(text, /Huddle ended/);
      assert.match(text, /Lasted (less than a minute|\d+ minutes?)/);
      assert.match(text, /Maya/);
      assert.match(text, /Daniel/);
      await daniel.locator('[data-huddle-pill]').waitFor({ state: 'detached' });
      assert.equal(await sideItem(daniel, 'engineering').locator('.side-huddle').count(), 0);
      await shot(daniel, 'huddle-ended-light');
      // The captions became a transcript file in the huddle thread.
      await daniel.locator('.message-scroll .msg', { has: daniel.locator('[data-huddle-card="ended"]') }).last().locator('.thread-summary').click();
      const panel = daniel.locator('.panel');
      await panel.locator('.msg', { hasText: 'Transcript of the huddle' }).waitFor({ timeout: 10_000 });
      await panel.getByText(/Huddle transcript \d{4}-\d{2}-\d{2}\.txt/).first().waitFor();
    });

    await step('without LiveKit configured there is no huddle button', async () => {
      const plain = await startServer({ seed: true });
      const page = watch(await mayaContext.newPage());
      await signIn(page, plain.base, 'maya@example.com');
      await openChannel(page, 'engineering');
      await page.waitForTimeout(500);
      assert.equal(await page.locator('[data-huddle-start]').count(), 0);
      await page.close();
    });
  },
  {
    chrome: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--auto-select-desktop-capture-source=Entire screen',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
    // Firefox's own fake camera and microphone, with no permission prompt.
    firefox: {
      firefoxUserPrefs: {
        'media.navigator.streams.fake': true,
        'media.navigator.permission.disabled': true,
        'media.autoplay.default': 0,
      },
    },
  },
);
