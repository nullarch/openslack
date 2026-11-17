// Second browser test: the paths around files, people and apps that the smoke
// test does not reach — media previews, paste upload, profile photos, member
// administration, and the Apps screen (webhooks, token rotation, deletion).
//
//   pnpm --filter @app/web build && node apps/web/e2e/files-people-apps.mjs
//
// See lib.mjs for the environment variables. Video needs `ffmpeg` on PATH.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  attach,
  browserName,
  composer,
  composerText,
  errors,
  modifier,
  openChannel,
  row,
  run,
  send,
  shot,
  sideItem,
  signIn,
  skip,
  startServer,
  step,
  watch,
  wide,
} from './lib.mjs';

// ── Test media, made here rather than checked in ────────────────────────────

/** A sine tone as 16-bit mono PCM in a WAV container. */
function wav(seconds, hertz, rate = 8000) {
  const samples = Math.floor(seconds * rate);
  const data = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hertz * index) / rate) * 12000), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** A one-page PDF with a line of text and a correct cross-reference table. */
function pdf(text) {
  const stream = `BT /F1 18 Tf 24 72 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** A one-second test-pattern clip, or null with the reason when ffmpeg cannot make one. */
function video() {
  const dir = mkdtempSync(join(tmpdir(), 'chat-e2e-video-'));
  const attempts = [
    { name: 'clip.mp4', type: 'video/mp4', codec: ['-c:v', 'libx264', '-movflags', '+faststart'] },
    { name: 'clip.webm', type: 'video/webm', codec: ['-c:v', 'libvpx', '-b:v', '200k'] },
  ];
  let reason = 'ffmpeg is not on PATH';
  try {
    for (const attempt of attempts) {
      const path = join(dir, attempt.name);
      try {
        execFileSync(
          'ffmpeg',
          ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=15', '-pix_fmt', 'yuv420p', ...attempt.codec, '-y', path],
          { stdio: ['ignore', 'ignore', 'pipe'] },
        );
        return { file: { name: attempt.name, mimeType: attempt.type, buffer: readFileSync(path) } };
      } catch (error) {
        if (error.code === 'ENOENT') break;
        reason = `ffmpeg could not encode a clip: ${String(error.stderr ?? error.message).trim().split('\n').at(-1)}`;
      }
    }
    return { reason };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A solid-colour PNG of the given size, drawn by the browser. */
async function png(page, width, height, color) {
  const base64 = await page.evaluate(
    ({ width: w, height: h, color: fill }) => {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const context = canvas.getContext('2d');
      context.fillStyle = fill;
      context.fillRect(0, 0, w, h);
      return canvas.toDataURL('image/png').split(',')[1];
    },
    { width, height, color },
  );
  return Buffer.from(base64, 'base64');
}

/** Every response for uploaded files this page asked for, so a step can check nothing was refused. */
function recordFileResponses(page) {
  const seen = [];
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/files-pri/')) seen.push({ path: decodeURIComponent(url.pathname), status: response.status(), type: response.headers()['content-type'] });
  });
  return seen;
}

function apiCaller(base) {
  return async (method, args = {}, token) => {
    const response = await fetch(`${base}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(args),
    });
    return response.json();
  };
}

async function openAdmin(page, tab) {
  await page.locator('.team-btn').click();
  await page.locator('.menu-item', { hasText: 'Administration' }).click();
  await page.locator('.admin-modal .tabs button', { hasText: tab }).click();
}

function adminRow(page, name) {
  return page.locator('.admin-body .admin-list > li', { has: page.locator('.admin-name', { hasText: name }) });
}

async function main(browser) {
  const server = await startServer({ seed: true });
  const api = apiCaller(server.base);

  const mayaContext = await browser.newContext({ ...wide, colorScheme: 'light' });
  // Only Chrome lets a test grant clipboard access; elsewhere the paste step uses a synthetic paste event.
  if (browserName === 'chrome') await mayaContext.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: server.base });
  const maya = watch(await mayaContext.newPage());
  const daniel = watch(await (await browser.newContext({ ...wide, colorScheme: 'light' })).newPage());
  const mayaFiles = recordFileResponses(maya);
  const danielFiles = recordFileResponses(daniel);

  await signIn(maya, server.base, 'maya@example.com');
  await signIn(daniel, server.base, 'daniel@example.com');
  await openChannel(maya, 'random');
  await openChannel(daniel, 'random');

  const refused = (list) => list.filter((entry) => entry.status >= 400);
  // Carried from the rotation step to the deletion step.
  let rotatedToken = '';
  let webhookUrl = '';

  await step('audio: a WAV plays inline for both people', async () => {
    const tone = wav(0.5, 440);
    await attach(maya, { name: 'tone.wav', mimeType: 'audio/wav', buffer: tone });
    await composer(maya).fill('Audio check');
    await composer(maya).press('Enter');
    for (const page of [maya, daniel]) {
      const player = row(page, 'tone.wav').locator('.file-media.is-audio audio');
      await player.waitFor();
      const state = await player.evaluate(
        (audio) =>
          new Promise((resolve) => {
            const done = () => resolve({ duration: audio.duration, error: audio.error?.code ?? null, ready: audio.readyState });
            if (audio.readyState >= 1 || audio.error) done();
            else {
              audio.addEventListener('loadedmetadata', done, { once: true });
              audio.addEventListener('error', done, { once: true });
            }
          }),
      );
      assert.equal(state.error, null, 'the audio element reports no error');
      assert.ok(Math.abs(state.duration - 0.5) < 0.05, `duration read from the bytes, got ${state.duration}`);
    }
    // It actually plays, to the end of the half-second clip.
    const played = await row(maya, 'tone.wav')
      .locator('audio')
      .evaluate(async (audio) => {
        audio.muted = true;
        const ended = new Promise((resolve) => audio.addEventListener('ended', () => resolve(true), { once: true }));
        await audio.play();
        return Promise.race([ended, new Promise((resolve) => setTimeout(() => resolve(false), 5000))]);
      });
    assert.equal(played, true, 'playback reached the end');
    assert.deepEqual(refused([...mayaFiles, ...danielFiles]), []);
  });

  await step('pdf: the preview opens in the browser viewer, and the file opens in a tab', async () => {
    await attach(maya, { name: 'hello.pdf', mimeType: 'application/pdf', buffer: pdf('Hello from a PDF') });
    await composer(maya).fill('PDF check');
    await composer(maya).press('Enter');
    const card = row(daniel, 'hello.pdf').locator('.file-card.is-pdf');
    await card.waitFor();
    assert.equal(await card.locator('iframe').count(), 0, 'nothing is fetched until the preview is asked for');
    const before = errors.length;
    await card.locator('.link-btn', { hasText: 'Preview' }).click();
    const frame = card.locator('iframe.file-pdf');
    await frame.waitFor();
    // The document request succeeded and was served as a PDF…
    for (let attempt = 0; attempt < 50 && !danielFiles.some((entry) => entry.path.endsWith('/hello.pdf')); attempt += 1) {
      await daniel.waitForTimeout(100);
    }
    await daniel.waitForTimeout(500);
    const served = danielFiles.filter((entry) => entry.path.endsWith('/hello.pdf'));
    assert.ok(served.length > 0, 'the viewer requested the file');
    assert.ok(served.every((entry) => entry.status === 200 || entry.status === 206), JSON.stringify(served));
    assert.match(served[0].type, /^application\/pdf/);
    // The rest needs a built-in PDF viewer. Playwright's Firefox has none (it downloads PDFs) and its
    // WebKit does not expose the viewer as a frame, so outside Chrome the check ends here.
    if (browserName !== 'chrome') {
      await card.locator('.link-btn', { hasText: 'Hide preview' }).click();
      await frame.waitFor({ state: 'detached' });
      return;
    }
    // …and the frame shows it, rather than a browser error page or a blocked-frame notice.
    const handle = daniel.frames().find((item) => item.url().includes('/hello.pdf'));
    assert.ok(handle, `a frame holds the PDF; frames: ${daniel.frames().map((item) => item.url()).join(', ')}`);
    assert.deepEqual(errors.slice(before), [], 'no console errors (a refused frame or a content-security-policy block would show here)');
    await shot(daniel, 'preview-pdf');

    // "Open in a new tab" shows the same document on its own.
    const href = await card.locator('a[title="Open in a new tab"]').getAttribute('href');
    const tab = watch(await daniel.context().newPage());
    const response = await tab.goto(new URL(href, server.base).href);
    assert.equal(response.status(), 200);
    assert.match(response.headers()['content-type'], /^application\/pdf/);
    assert.equal(response.headers()['content-disposition'].startsWith('inline'), true);
    await tab.close();
    await card.locator('.link-btn', { hasText: 'Hide preview' }).click();
    await frame.waitFor({ state: 'detached' });
  });

  const clip = video();
  if (clip.file) {
    await step(`video: ${clip.file.name} loads, reports its size and seeks`, async () => {
      await attach(maya, clip.file);
      await composer(maya).fill('Video check');
      await composer(maya).press('Enter');
      for (const page of [maya, daniel]) {
        const player = row(page, clip.file.name).locator('.file-media video');
        await player.waitFor();
        const state = await player.evaluate(
          (element) =>
            new Promise((resolve) => {
              const report = () =>
                resolve({ width: element.videoWidth, height: element.videoHeight, duration: element.duration, error: element.error?.code ?? null });
              if (element.error) return report();
              const seek = () => {
                element.addEventListener('seeked', report, { once: true });
                element.currentTime = 0.5;
              };
              element.addEventListener('error', report, { once: true });
              if (element.readyState >= 1) seek();
              else element.addEventListener('loadedmetadata', seek, { once: true });
            }),
        );
        assert.equal(state.error, null, 'the video element reports no error');
        assert.deepEqual([state.width, state.height], [320, 240]);
        assert.ok(Math.abs(state.duration - 1) < 0.2, `duration read from the bytes, got ${state.duration}`);
      }
      // The player grows once it knows the picture size; the reader is still looking at the newest message.
      for (const page of [maya, daniel]) {
        await page
          .waitForFunction(() => {
            const node = document.querySelector('.message-scroll');
            return node.scrollHeight - node.scrollTop - node.clientHeight < 4;
          }, null, { timeout: 3000 })
          .catch(() => assert.fail('the list did not stay at the bottom after the video loaded'));
        assert.equal(await page.locator('.jump-latest').count(), 0);
      }
      const requests = [...mayaFiles, ...danielFiles].filter((entry) => entry.path.endsWith(`/${clip.file.name}`));
      assert.ok(requests.some((entry) => entry.status === 206), 'the player used byte ranges');
      assert.deepEqual(refused(requests), []);
      await shot(daniel, 'preview-video');
    });
  } else {
    skip('video preview', clip.reason);
  }

  await step('the newest message stays in view while the composer grows', async () => {
    const gap = () => maya.locator('.message-scroll').evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight);
    assert.ok((await gap()) < 4);
    const before = await maya.locator('.message-scroll').evaluate((node) => node.clientHeight);
    await composer(maya).fill('one\ntwo\nthree\nfour\nfive\nsix');
    // The composer grows to show all six lines, taking that room from the list…
    const box = await composer(maya).evaluate((node) => ({ shown: node.clientHeight, needed: node.scrollHeight }));
    assert.ok(box.shown >= box.needed && box.shown > 120, `the composer shows every line (${box.shown} of ${box.needed}px)`);
    await maya.waitForFunction((height) => document.querySelector('.message-scroll').clientHeight < height - 60, before);
    // …and the list keeps its newest message in view (it re-pins as the frame is drawn).
    await maya
      .waitForFunction(() => {
        const node = document.querySelector('.message-scroll');
        return node.scrollHeight - node.scrollTop - node.clientHeight < 4;
      }, null, { timeout: 3000 })
      .catch(async () => assert.fail(`still at the bottom: ${await gap()}px short`));
    await composer(maya).fill('');
    await maya.waitForFunction((height) => document.querySelector('.message-scroll').clientHeight === height, before);
  });

  await step('unknown type: a download card whose link saves the exact bytes', async () => {
    const bytes = Buffer.from(Array.from({ length: 2048 }, (_, index) => (index * 31) % 256));
    await attach(maya, { name: 'firmware.bin', mimeType: 'application/octet-stream', buffer: bytes });
    await composer(maya).press('Enter');
    const card = daniel.locator('.message-scroll .file-card', { hasText: 'firmware.bin' }).last();
    await card.waitFor();
    assert.equal(await card.locator('video, audio, iframe, pre').count(), 0, 'no viewer is attempted for an unknown type');
    assert.match(await card.locator('.file-sub').innerText(), /2\.0 KB/);
    const [download] = await Promise.all([daniel.waitForEvent('download'), card.locator('a[title="Download"]').click()]);
    assert.equal(download.suggestedFilename(), 'firmware.bin');
    assert.deepEqual(readFileSync(await download.path()), bytes);
  });

  await step('public link: the uploader turns one on, it works signed out, and turning it off ends it', async () => {
    const mine = maya.locator('.message-scroll .file-card', { hasText: 'firmware.bin' }).last();
    // Only the uploader sees the control.
    assert.equal(await daniel.locator('.message-scroll .file-card', { hasText: 'firmware.bin' }).last().locator('button[title="Create a public link"]').count(), 0);
    await mine.locator('button[title="Create a public link"]').click();
    const on = mine.locator('.public-link');
    await on.waitFor();
    const fileId = await maya.evaluate(async () => {
      const response = await fetch('/api/files.list', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const body = await response.json();
      return body.files.find((file) => file.name === 'firmware.bin').id;
    });
    const info = await maya.evaluate(async (id) => {
      const response = await fetch('/api/files.info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: id }) });
      return (await response.json()).file;
    }, fileId);
    const publicPath = new URL(info.permalink_public).pathname;
    const signedOut = await fetch(`${server.base}${publicPath}`);
    assert.equal(signedOut.status, 200);
    assert.equal((await signedOut.arrayBuffer()).byteLength, 2048);
    await on.locator('.link-btn').click();
    await mine.locator('button[title="Create a public link"]').waitFor();
    assert.equal((await fetch(`${server.base}${publicPath}`)).status, 404);
  });

  await step('image: the thumbnail opens the full-size viewer', async () => {
    await attach(maya, { name: 'wide.png', mimeType: 'image/png', buffer: await png(maya, 640, 360, '#0e5f77') });
    await composer(maya).press('Enter');
    const thumb = daniel.locator('.message-scroll .file-image').last();
    await thumb.click();
    const full = daniel.locator('.image-viewer img');
    await full.waitFor();
    assert.equal(await full.evaluate((image) => image.decode().then(() => image.naturalWidth)), 640);
    await daniel.keyboard.press('Escape');
    await full.waitFor({ state: 'detached' });
  });

  await step('image: a large photo is shown through a smaller copy the browser made, and opens at full size', async () => {
    await attach(maya, { name: 'large.png', mimeType: 'image/png', buffer: await png(maya, 2400, 1600, '#7a3e9d') });
    await composer(maya).fill('Large photo');
    await composer(maya).press('Enter');
    const preview = row(daniel, 'Large photo').locator('.file-image img');
    await preview.waitFor();
    assert.match(await preview.getAttribute('src'), /^\/files-tmb\//);
    assert.equal(await preview.evaluate((image) => image.decode().then(() => image.naturalWidth)), 720);
    await row(daniel, 'Large photo').locator('.file-image').click();
    const full = daniel.locator('.image-viewer img');
    await full.waitFor();
    assert.equal(await full.evaluate((image) => image.decode().then(() => image.naturalWidth)), 2400);
    await daniel.keyboard.press('Escape');
    await full.waitFor({ state: 'detached' });
  });

  if (browserName === 'firefox') {
    skip('paste: an image on the clipboard becomes an attachment', "Firefox drops files from a synthetic paste event and Playwright's Firefox has no clipboard access");
  } else await step('paste: an image on the clipboard becomes an attachment', async () => {
    const picture = await png(maya, 200, 120, '#f5b63a');
    await composer(maya).click();
    if (browserName === 'chrome') {
      // The real clipboard and a real keyboard shortcut.
      await maya.evaluate(async (base64) => {
        const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })]);
      }, picture.toString('base64'));
      await maya.keyboard.press(`${modifier}+v`);
    } else {
      await composer(maya).evaluate((input, base64) => {
        const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
        const data = new DataTransfer();
        data.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }));
        input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      }, picture.toString('base64'));
    }
    const chip = maya.locator('.upload-chip');
    await chip.locator('.upload-sub', { hasText: /B$/ }).waitFor();
    assert.equal(await chip.locator('img').count(), 1, 'the pending attachment shows a thumbnail');
    await composer(maya).pressSequentially('Pasted from the clipboard');
    await composer(maya).press('Enter');
    const pasted = row(daniel, 'Pasted from the clipboard').locator('.file-image img');
    await pasted.waitFor();
    assert.deepEqual(await pasted.evaluate((image) => image.decode().then(() => [image.naturalWidth, image.naturalHeight])), [200, 120]);
    if (browserName === 'chrome') {
      // Pasting text still pastes text.
      await maya.evaluate(() => navigator.clipboard.writeText('plain words'));
      await composer(maya).click();
      await maya.keyboard.press(`${modifier}+v`);
      assert.equal(await composerText(composer(maya)), 'plain words');
      assert.equal(await maya.locator('.upload-chip').count(), 0);
      await composer(maya).fill('');
    }
  });

  await step('group DM: it becomes a private channel for the same people, history included', async () => {
    // Maya opens a group DM with Daniel and Sofia from the API, then converts it in the UI.
    const mayaCookie = (await maya.context().cookies()).map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    const call = async (method, args) => {
      const response = await fetch(`${server.base}/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: mayaCookie }, body: JSON.stringify(args) });
      return response.json();
    };
    const users = (await call('users.list', {})).members;
    const ids = ['daniel', 'sofia'].map((name) => users.find((user) => user.name.startsWith(name)).id);
    const group = (await call('conversations.open', { users: ids.join(',') })).channel;
    await call('chat.postMessage', { channel: group.id, text: 'Offsite ideas?' });
    await maya.goto(`${server.base}/c/${group.id}`);
    await row(maya, 'Offsite ideas?').waitFor();
    await maya.locator('.conversation button[aria-label="Details"], .conversation button[title="Details"]').first().click();
    await maya.locator('.row-action', { hasText: 'Change to a private channel' }).click();
    const dialog = maya.locator('.modal[role="dialog"]');
    await dialog.locator('input').fill('offsite planning');
    await dialog.locator('button', { hasText: 'Change to a private channel' }).click();
    await maya.locator('.conv-name:text-is("offsite-planning")').waitFor();
    await sideItem(daniel, 'offsite-planning').waitFor();
    await sideItem(daniel, 'offsite-planning').click();
    await row(daniel, 'Offsite ideas?').waitFor();
    await openChannel(maya, 'random');
    await openChannel(daniel, 'random');
  });

  await step('profile photo: an upload replaces the generated avatar for someone else, and removing it brings it back', async () => {
    // Daniel speaks first so that Maya's next message starts a new group and carries her avatar.
    await send(daniel, 'Show us the new photo');
    await row(maya, 'Show us the new photo').waitFor();
    await send(maya, 'Look at my avatar');
    const theirs = row(daniel, 'Look at my avatar').locator('.msg-avatar img');
    await theirs.waitFor();
    const kind = async () => (await fetch(new URL(await theirs.getAttribute('src'), server.base))).headers.get('content-type');
    assert.equal(await kind(), 'image/svg+xml', 'before: initials drawn by the server');

    await maya.locator('.me-strip').click();
    await maya.locator('.menu-item', { hasText: 'Edit profile' }).click();
    await maya.locator('.profile-edit-photo input[type="file"]').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: await png(maya, 96, 96, '#c9353b') });
    const loaded = (page, selector, width) =>
      page.waitForFunction(
        ({ selector: query, width: wanted }) => {
          const image = document.querySelector(query);
          return image instanceof HTMLImageElement && image.complete && image.naturalWidth === wanted;
        },
        { selector, width },
      );
    await loaded(maya, '.profile-edit-photo .avatar img', 96);
    await loaded(maya, '.me-strip .avatar img', 96);
    const avatar = `.message-scroll .msg[data-ts="${await row(daniel, 'Look at my avatar').getAttribute('data-ts')}"] .msg-avatar img`;
    await loaded(daniel, avatar, 96);
    assert.equal(await kind(), 'image/png');
    await shot(daniel, 'profile-photo');

    await maya.locator('.profile-edit-photo .link-btn', { hasText: 'Remove photo' }).click();
    await daniel.waitForFunction(async (selector) => {
      const image = document.querySelector(selector);
      if (!(image instanceof HTMLImageElement)) return false;
      const response = await fetch(image.src);
      return response.headers.get('content-type') === 'image/svg+xml';
    }, avatar);
    await maya.keyboard.press('Escape');
  });

  await step('administration: a role change takes effect in the other person’s open tab', async () => {
    await daniel.locator('.team-btn').click();
    await daniel.locator('.menu-item', { hasText: 'Administration' }).click();
    await daniel.locator('.admin-body', { hasText: 'Only workspace admins can manage members.' }).waitFor();

    await openAdmin(maya, 'Members');
    await adminRow(maya, 'Daniel Okafor').locator('select').selectOption('admin');
    // Daniel's dialog, already open, turns into the member list without a reload.
    await adminRow(daniel, 'Maya Chen').waitFor();
    assert.equal(await adminRow(daniel, 'Daniel Okafor').locator('.admin-role').innerText(), 'Admin');
    await maya.waitForFunction(() => [...document.querySelectorAll('.admin-list select')].some((select) => select.value === 'admin'));
    // An admin may not touch the primary owner.
    assert.equal(await adminRow(daniel, 'Maya Chen').locator('select, .btn').count(), 0);

    await adminRow(maya, 'Daniel Okafor').locator('select').selectOption('member');
    await daniel.locator('.admin-body', { hasText: 'Only workspace admins can manage members.' }).waitFor();
    await daniel.keyboard.press('Escape');
  });

  await step('administration: deactivating someone ends their open session; reactivating lets them back in', async () => {
    // Tom's tab will log the refused reconnect; that is the point of the step, not a defect.
    const tom = watch(await (await browser.newContext(wide)).newPage(), /WebSocket connection to .* failed/);
    await signIn(tom, server.base, 'tom@example.com');
    await openChannel(tom, 'general');

    await adminRow(maya, 'Tom Becker').locator('.btn', { hasText: 'Deactivate' }).click();
    await maya.locator('.modal .btn-danger', { hasText: 'Deactivate' }).click();
    await adminRow(maya, 'Tom Becker').locator('.tag', { hasText: 'Deactivated' }).waitFor();

    // Tom did nothing, yet his tab is back at sign-in.
    await tom.waitForURL('**/signin', { timeout: 10_000 });
    await tom.locator('.auth-card input[type="email"]').waitFor();
    await tom.fill('input[type="email"]', 'tom@example.com');
    await tom.fill('input[type="password"]', 'demo-password');
    await tom.click('button[type="submit"]');
    await tom.locator('.auth-error', { hasText: 'This account has been deactivated.' }).waitFor();
    // Everyone else sees the account marked as such (Tom wrote in #random, where Daniel is).
    await daniel.locator('.message-scroll .msg-author', { hasText: 'Tom' }).first().click();
    await daniel.locator('.panel .profile-facts', { hasText: 'Deactivated account' }).waitFor();
    await daniel.keyboard.press('Escape');

    await adminRow(maya, 'Tom Becker').locator('.btn', { hasText: 'Reactivate' }).click();
    await adminRow(maya, 'Tom Becker').locator('select').waitFor();
    await tom.click('button[type="submit"]');
    await tom.waitForSelector('.sidebar .side-item');
    await tom.context().close();
    await maya.keyboard.press('Escape');
  });

  await step('apps: an incoming webhook posts into its channel', async () => {
    await openChannel(daniel, 'random');
    await openAdmin(maya, 'Apps');
    await maya.locator('.new-app input').first().fill('Hook Bot');
    await maya.locator('.new-app .btn-primary').click();
    await maya.locator('.secrets .copy-row input').first().waitFor();
    await maya.locator('.inline-form select').selectOption({ label: '#random' });
    await maya.locator('.inline-form .btn', { hasText: 'Add webhook' }).click();
    const field = maya.locator('.hook-row .copy-row input');
    await field.waitFor();
    const url = await field.inputValue();
    assert.match(url, new RegExp(`^${server.base}/services/T[A-Z0-9]+/B[A-Z0-9]+/[A-Za-z0-9]+$`));

    const plain = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Deploy finished: *build 1483* is live' }) });
    assert.deepEqual([plain.status, await plain.text()], [200, 'ok']);
    const arrived = row(daniel, 'Deploy finished');
    await arrived.waitFor();
    assert.equal(await arrived.locator('.msg-author').innerText(), 'Hook Bot');
    assert.equal(await arrived.locator('.tag').innerText(), 'App');
    assert.equal(await arrived.locator('strong').innerText(), 'build 1483');

    // The older form-encoded `payload=` body, with a custom name and icon.
    const legacy = await fetch(url, {
      method: 'POST',
      body: new URLSearchParams({ payload: JSON.stringify({ text: 'On air', username: 'Release Radio', icon_emoji: ':radio:' }) }),
    });
    assert.equal(legacy.status, 200);
    const custom = row(daniel, 'On air');
    await custom.waitFor();
    assert.equal(await custom.locator('.msg-author').innerText(), 'Release Radio');
    assert.equal(await custom.locator('.avatar-emoji .emoji').innerText(), '📻');
    assert.equal((await fetch(`${url}x`, { method: 'POST', body: '{}' })).status, 404);
    await shot(daniel, 'webhook-message');
  });

  await step('apps: rotating the bot token shows the new one once and retires the old one', async () => {
    const original = await maya.locator('.secrets .copy-row input').first().inputValue();
    assert.equal((await api('auth.test', {}, original)).ok, true);
    await maya.locator('.token-list .btn', { hasText: 'Rotate bot token' }).click();
    const fresh = maya.locator('.copy-field', { hasText: 'New token — copy it now' }).locator('input');
    await fresh.waitFor();
    const rotated = await fresh.inputValue();
    assert.match(rotated, /^xoxb-/);
    assert.notEqual(rotated, original);
    assert.equal((await api('auth.test', {}, original)).error, 'invalid_auth');
    assert.equal((await api('auth.test', {}, rotated)).ok, true);
    // The token from creation is no longer offered for copying, and the hint is of the new one.
    const offered = () => maya.locator('.copy-row input').evaluateAll((inputs) => inputs.map((input) => input.value));
    assert.ok(!(await offered()).includes(original));
    assert.equal(await maya.locator('.token-list .token-hint').first().innerText(), `${rotated.slice(0, 9)}…${rotated.slice(-4)}`);

    // Shown once: leaving the app and coming back shows no token at all.
    await maya.locator('.back-link').click();
    await maya.locator('.app-row', { hasText: 'Hook Bot' }).click();
    await maya.locator('.token-list').waitFor();
    assert.equal(await maya.locator('.secrets').count(), 0);
    assert.ok(!(await offered()).some((value) => value.startsWith('xox') || value.startsWith('xapp')), 'no token is on screen');
    // The signing secret stays available to an admin, who needs it to configure HTTP delivery.
    assert.match(await maya.locator('.copy-field', { hasText: 'Signing secret' }).locator('input').inputValue(), /^[0-9a-f]{32}$/);
    rotatedToken = rotated;
    webhookUrl = await maya.locator('.hook-row .copy-row input').inputValue();
  });

  await step('apps: deleting an app removes it, its tokens and its webhooks', async () => {
    await maya.locator('.danger-zone .btn-danger').click();
    await maya.locator('.modal .btn-danger', { hasText: 'Delete app' }).last().click();
    await maya.locator('.apps-admin').waitFor();
    assert.equal(await maya.locator('.app-row', { hasText: 'Hook Bot' }).count(), 0);
    assert.equal(await maya.locator('.app-row').count(), 2, 'the two sample apps remain');
    assert.equal((await api('auth.test', {}, rotatedToken)).error, 'invalid_auth');
    assert.equal((await fetch(webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"anyone?"}' })).status, 404);
    await maya.keyboard.press('Escape');
    // Its messages stay, and its bot user shows as deactivated.
    await row(daniel, 'Deploy finished').locator('.msg-author').click();
    await daniel.locator('.panel .profile-facts', { hasText: 'Deactivated account' }).waitFor();
    await daniel.keyboard.press('Escape');
  });

  assert.deepEqual(refused([...mayaFiles, ...danielFiles]), [], 'no file request was refused');
}

await run(main);
