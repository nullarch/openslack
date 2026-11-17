import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { after, before, describe, test } from 'node:test';
import bolt from '@slack/bolt';
import { setupWorkspace, startApp, type Json, type Session, type TestApp } from '@app/server/test/helpers.ts';
import { createPlatformApp } from '@app/server/test/platform-helpers.ts';
import { recordTokenCalls, saveExercised } from './harness.ts';

const { App, LogLevel } = bolt;
const require = createRequire(import.meta.url);
const boltVersion = (JSON.parse(readFileSync(require.resolve('@slack/bolt/package.json'), 'utf8')) as { version: string }).version;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A custom workflow step implemented the way it is on Slack: an official Bolt
 * app with `app.function(callback_id, …)`, called from a workflow, finishing
 * with `complete()` or `fail()`.
 */
describe('an official Bolt app implementing a custom workflow step', { timeout: 30_000 }, () => {
  let t: TestApp;
  let owner: Session;
  let app: InstanceType<typeof App> | undefined;
  let general: string;
  let called: Set<string>;
  const delivered = new Set<string>();
  const seenInputs: Json[] = [];

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    general = (await owner.ok('client.boot')).channels.find((channel: Json) => channel.is_general).id;
    const creds = await createPlatformApp(owner, 'Ticket Bot');
    await owner.ok('client.apps.update', {
      app: creds.id,
      functions: [
        {
          callback_id: 'create_ticket',
          title: 'Create a ticket',
          input_parameters: [
            { name: 'summary', type: 'slack#/types/string', is_required: true },
            { name: 'reporter', type: 'slack#/types/user_id' },
          ],
          output_parameters: [{ name: 'ticket_id', type: 'slack#/types/string' }],
        },
      ],
    });
    called = recordTokenCalls(t);
    app = new App({ token: creds.botToken, appToken: creds.appToken, socketMode: true, clientOptions: { slackApiUrl: `${t.base}/api/` }, logLevel: LogLevel.ERROR });
    app.use(async ({ body, next }) => {
      const type = (body as Json).event?.type ?? (body as Json).type;
      if (type) delivered.add(type);
      await next();
    });
    app.function('create_ticket', async ({ inputs, complete, fail, client }) => {
      seenInputs.push(inputs);
      if (String(inputs.summary).includes('fail')) {
        await fail({ error: 'the ticket system is down' });
        return;
      }
      // The step's own token works for ordinary calls while the step runs.
      const me = await client.auth.test();
      await complete({ outputs: { ticket_id: `T-${me.user_id === undefined ? 'x' : String(inputs.summary).length}` } });
    });
    await app.start();
    await sleep(200);
  });
  after(async () => {
    await app?.stop().catch(() => undefined);
    saveExercised('bolt-js-function', `@slack/bolt ${boltVersion}`, called, delivered);
    await t.close();
  });

  const runWorkflow = async (summary: string): Promise<Json> => {
    const name = `Ticket ${summary}`;
    const apps = (await owner.ok('client.workflows.stepTypes')).apps;
    const ticketApp = apps.find((entry: Json) => entry.app_name === 'Ticket Bot');
    const saved = await owner.ok('client.workflows.save', {
      name,
      trigger: { type: 'shortcut' },
      steps: [
        { id: 'ticket', type: 'app', app_id: ticketApp.app_id, callback_id: 'create_ticket', inputs: { summary, reporter: '{{trigger.user}}' } },
        { id: 'say', type: 'message', destination: { to: 'channel', channel: general }, text: 'Opened {{steps.ticket.ticket_id}}' },
      ],
    });
    await owner.ok('client.workflows.publish', { workflow: saved.workflow.id });
    const entry = (await owner.ok('client.shortcuts.list')).shortcuts.find((item: Json) => item.name === name);
    await owner.ok('client.shortcuts.run', { app: entry.app_id, callback_id: entry.callback_id });
    for (let i = 0; i < 100; i += 1) {
      const run = (await owner.ok('client.workflows.runs', { workflow: saved.workflow.id })).runs[0];
      if (run && (run.status === 'completed' || run.status === 'failed')) return run;
      await sleep(50);
    }
    throw new Error('the run did not finish');
  };

  test('function_executed reaches app.function with typed inputs; complete() continues the workflow', async () => {
    const run = await runWorkflow('printer jam');
    assert.equal(run.status, 'completed', JSON.stringify(run));
    assert.deepEqual(seenInputs.at(-1), { summary: 'printer jam', reporter: owner.userId });
    const latest = (await owner.ok('conversations.history', { channel: general, limit: 1 })).messages[0];
    assert.equal(latest.text, 'Opened T-11');
    assert.ok(delivered.has('function_executed'));
  });

  test('fail() stops the workflow with the app’s message', async () => {
    const run = await runWorkflow('please fail');
    assert.equal(run.status, 'failed');
    assert.match(run.error, /the ticket system is down/);
  });
});
