// Browser test for clips: record a video clip from Chrome's fake camera and
// microphone with captions from a stand-in speech recognizer, send it, and
// see the captions, the transcript and search for what was said, as the
// sender and as someone else.
//
//   pnpm --filter @app/web build && node e2e/clips.mjs
import assert from 'node:assert/strict';
import { composer, openChannel, row, run, shot, signIn, startServer, step, watch, wide } from './lib.mjs';

/** A stand-in for the browser's speech recognition, driven by the test through window.__say. */
function fakeSpeech() {
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
}

async function main(browser) {
  const { base } = await startServer({ seed: true });
  const maya = watch(await (await browser.newContext({ ...wide })).newPage());
  const daniel = watch(await (await browser.newContext({ ...wide })).newPage());
  await maya.addInitScript(fakeSpeech);
  await signIn(maya, base, 'maya@example.com');
  await signIn(daniel, base, 'daniel@example.com');
  await openChannel(maya, 'engineering');
  await openChannel(daniel, 'engineering');

  await step('record a video clip with captions and send it with a message', async () => {
    await maya.locator('[data-clip-button]').first().click();
    await maya.locator('.menu-item', { hasText: 'Video clip' }).click();
    const dialog = maya.locator('.modal.clip-recorder');
    await dialog.locator('[data-clip-stop]').waitFor();
    await dialog.getByText('Captions are made from what you say').waitFor();
    await maya.waitForFunction(() => document.querySelector('.clip-recorder video')?.readyState >= 2);
    await maya.waitForTimeout(700);
    assert.equal(await maya.evaluate(() => window.__say('here is the new', false)), 1);
    await maya.waitForTimeout(600);
    await maya.evaluate(() => window.__say('Here is the new onboarding flow.', true));
    await maya.waitForTimeout(800);
    await shot(maya, 'clip-recording');
    await dialog.locator('[data-clip-stop]').click();
    await dialog.locator('video[controls]').waitFor();
    await dialog.getByText('Here is the new onboarding flow.').waitFor();
    await shot(maya, 'clip-review');
    await dialog.locator('[data-clip-use]').click();
    await dialog.waitFor({ state: 'detached' });
    await maya.locator('.upload-chip').first().waitFor();
    await composer(maya).fill('Walkthrough of the new flow');
    await maya.waitForFunction(() => !document.querySelector('.send-btn')?.disabled);
    await maya.locator('.send-btn').first().click();
    await row(maya, 'Walkthrough of the new flow').locator('video').waitFor();
  });

  await step('someone else sees the clip with captions and the transcript, and finds it by what was said', async () => {
    const message = row(daniel, 'Walkthrough of the new flow');
    const video = message.locator('video');
    await video.waitFor();
    const track = await video.locator('track').getAttribute('src');
    assert.ok(track, 'a captions track');
    const vtt = await daniel.evaluate(async (src) => (await fetch(src)).text(), track);
    assert.match(vtt, /^WEBVTT\n\n\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}\.\d{3}\nHere is the new onboarding flow\./);
    // The captions load into the player.
    await daniel.waitForFunction(() => {
      const element = document.querySelector('.file-media video');
      return element?.textTracks?.[0]?.cues?.length > 0 || element?.textTracks?.[0]?.mode === 'showing';
    });
    await message.locator('.file-transcript summary').click();
    await message.locator('.file-transcript p', { hasText: 'Here is the new onboarding flow.' }).waitFor();
    await shot(daniel, 'clip-message');
    const found = await daniel.evaluate(async () => {
      const response = await fetch('/api/search.files', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'onboarding flow' }) });
      return (await response.json()).files.total;
    });
    assert.equal(found, 1);
  });

  await step('an audio clip without captions in a browser that cannot make them', async () => {
    await maya.evaluate(() => {
      delete window.SpeechRecognition;
      delete window.webkitSpeechRecognition;
    });
    await maya.locator('[data-clip-button]').first().click();
    await maya.locator('.menu-item', { hasText: 'Audio clip' }).click();
    const dialog = maya.locator('.modal.clip-recorder');
    await dialog.getByText('can’t make captions').waitFor();
    await maya.waitForTimeout(1200);
    await dialog.locator('[data-clip-stop]').click();
    await dialog.locator('audio[controls]').waitFor();
    await dialog.locator('[data-clip-use]').click();
    await maya.waitForFunction(() => !document.querySelector('.send-btn')?.disabled);
    await maya.locator('.send-btn').first().click();
    await daniel.locator('.msg .file-media.is-audio audio').last().waitFor();
    assert.equal(await daniel.locator('.msg .file-media.is-audio').last().locator('.file-transcript').count(), 0);
  });
}

await run(main, {
  chrome: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] },
});
