import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { addMember, callWithToken, createBot, Session, setupWorkspace, startApp, type Json, type TestApp } from './helpers.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('activity, threads and notification settings', () => {
  let t: TestApp;
  let owner: Session;
  let mina: Session;
  let theo: Session;
  let channel: string;

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    mina = await addMember(t, owner, 'Mina Member');
    theo = await addMember(t, owner, 'Theo Third');
    channel = (await owner.ok('conversations.create', { name: 'activity-test' })).channel.id;
    await owner.ok('conversations.invite', { channel, users: `${mina.userId},${theo.userId}` });
  });
  after(() => t.close());

  const activity = async (session: Session, args: Record<string, unknown> = {}): Promise<Json> => session.ok('client.activity.list', args);

  test('being added to a channel, mentioned and @channel-ed show up in Activity, unread', async () => {
    const minaItems = (await activity(mina)).items as Json[];
    assert.equal(minaItems[0].type, 'invite');
    assert.equal(minaItems[0].actor, owner.userId);
    assert.equal(minaItems[0].channel, channel);

    const stream = await mina.connect();
    const { ts } = await owner.ok('chat.postMessage', { channel, text: `look <@${mina.userId}>` });
    const live = await stream.next((event) => event.type === 'activity_added' && event.item.ts === ts);
    assert.equal(live.item.type, 'mention');
    assert.equal(live.item.message.text, `look <@${mina.userId}>`);
    stream.close();

    await owner.ok('chat.postMessage', { channel, text: 'everyone <!channel>' });
    const theoItems = (await activity(theo)).items as Json[];
    assert.equal(theoItems[0].type, 'mention');
    assert.equal(theoItems[0].broadcast, true);
    // The author is never told about their own message.
    assert.ok(!(await activity(owner)).items.some((item: Json) => item.type === 'mention'));
    assert.ok((await activity(mina)).unread_count >= 3);
  });

  test('a reaction to someone’s message tells them; taking it back removes it', async () => {
    const { ts } = await mina.ok('chat.postMessage', { channel, text: 'shipped the fix' });
    await theo.ok('reactions.add', { channel, timestamp: ts, name: 'tada' });
    let items = (await activity(mina, { types: 'reaction' })).items as Json[];
    assert.equal(items.length, 1);
    assert.equal(items[0].reaction, 'tada');
    assert.equal(items[0].actor, theo.userId);
    await theo.ok('reactions.remove', { channel, timestamp: ts, name: 'tada' });
    items = (await activity(mina, { types: 'reaction' })).items as Json[];
    assert.equal(items.length, 0);
    // Reacting to your own message is not activity.
    await mina.ok('reactions.add', { channel, timestamp: ts, name: 'eyes' });
    assert.equal((await activity(mina, { types: 'reaction' })).items.length, 0);
  });

  test('keywords from preferences match whole words, and Korean anywhere in a word', async () => {
    await theo.ok('client.prefs.set', { prefs: { highlight_words: 'deploy, 배포' } });
    await mina.ok('chat.postMessage', { channel, text: 'the redeployment is unrelated' });
    await mina.ok('chat.postMessage', { channel, text: 'Deploy at five' });
    await mina.ok('chat.postMessage', { channel, text: '배포는 내일입니다' });
    const items = (await activity(theo, { types: 'keyword' })).items as Json[];
    assert.deepEqual(items.map((item) => item.keyword), ['배포', 'deploy']);
  });

  test('reading the channel reads its mentions; marking by hand and all at once', async () => {
    const { ts } = await owner.ok('chat.postMessage', { channel, text: `ping <@${theo.userId}>` });
    const before = (await activity(theo, { unread_only: true })).items as Json[];
    assert.ok(before.some((item) => item.ts === ts));
    await theo.ok('conversations.mark', { channel, ts });
    const afterMark = (await activity(theo, { unread_only: true })).items as Json[];
    assert.ok(!afterMark.some((item) => item.ts === ts));

    const unread = (await activity(theo, { unread_only: true })).items as Json[];
    if (unread.length > 0) {
      const marked = await theo.ok('client.activity.mark', { ids: [unread[0].id] });
      assert.equal(marked.unread_count, unread.length - 1);
    }
    const all = await theo.ok('client.activity.mark', { all: true });
    assert.equal(all.unread_count, 0);
    assert.equal((await theo.ok('client.activity.mark', { all: true, unread: true })).unread_count, (await activity(theo)).items.length);
  });

  test('deleting a message removes the activity about it', async () => {
    const { ts } = await owner.ok('chat.postMessage', { channel, text: `oops <@${mina.userId}>` });
    assert.ok((await activity(mina)).items.some((item: Json) => item.ts === ts));
    await owner.ok('chat.delete', { channel, ts });
    assert.ok(!(await activity(mina)).items.some((item: Json) => item.ts === ts));
  });

  test('threads: the starter and repliers follow, others can follow by hand, unfollowing sticks', async () => {
    const parent = await mina.ok('chat.postMessage', { channel, text: 'thread for following' });
    const minaStream = await mina.connect();
    const reply = await owner.ok('chat.postMessage', { channel, text: 'first reply', thread_ts: parent.ts });
    const unread = await minaStream.next((event) => event.type === 'thread_unread');
    assert.equal(unread.thread_ts, parent.ts);
    minaStream.close();

    let list = await mina.ok('client.threads.list');
    const thread = list.threads.find((item: Json) => item.thread_ts === parent.ts);
    assert.equal(thread.unread, true);
    assert.equal(thread.root.text, 'thread for following');
    assert.equal(thread.latest_replies[0].text, 'first reply');
    assert.ok(list.unread.some((item: Json) => item.thread_ts === parent.ts));
    assert.ok((await activity(mina, { types: 'thread_reply' })).items.some((item: Json) => item.ts === reply.ts));

    // The replier follows and has read their own reply.
    const ownerThread = (await owner.ok('client.threads.list')).threads.find((item: Json) => item.thread_ts === parent.ts);
    assert.equal(ownerThread.unread, false);
    // Slack's fields on the parent, for the person asking.
    const replies = await mina.ok('conversations.replies', { channel, ts: parent.ts });
    assert.equal(replies.messages[0].subscribed, true);
    assert.equal(replies.messages[0].last_read, '0000000000.000000');

    await mina.ok('client.threads.mark', { channel, thread_ts: parent.ts, ts: reply.ts });
    list = await mina.ok('client.threads.list');
    assert.equal(list.threads.find((item: Json) => item.thread_ts === parent.ts).unread, false);
    assert.equal((await mina.ok('conversations.replies', { channel, ts: parent.ts })).messages[0].last_read, reply.ts);

    // Theo is not in the thread until mentioned in it, then follows.
    assert.ok(!(await theo.ok('client.threads.list')).threads.some((item: Json) => item.thread_ts === parent.ts));
    await owner.ok('chat.postMessage', { channel, text: `your view <@${theo.userId}>?`, thread_ts: parent.ts });
    assert.ok((await theo.ok('client.threads.list')).threads.some((item: Json) => item.thread_ts === parent.ts));

    // Unfollowing sticks, even after replying again.
    await mina.ok('client.threads.setSubscription', { channel, thread_ts: parent.ts, subscribed: false });
    await mina.ok('chat.postMessage', { channel, text: 'one more from me', thread_ts: parent.ts });
    assert.ok(!(await mina.ok('client.threads.list')).threads.some((item: Json) => item.thread_ts === parent.ts));
    assert.equal((await mina.ok('conversations.replies', { channel, ts: parent.ts })).messages[0].subscribed, false);
    await mina.ok('client.threads.setSubscription', { channel, thread_ts: parent.ts, subscribed: true });
    assert.ok((await mina.ok('client.threads.list')).threads.some((item: Json) => item.thread_ts === parent.ts));
  });

  test('notification level per conversation is saved and comes back in boot', async () => {
    const changed = await mina.ok('client.conversations.setNotify', { channel, level: 'all' });
    assert.equal(changed.channel.notify_level, 'all');
    const boot = await mina.ok('client.boot');
    assert.equal(boot.channels.find((item: Json) => item.id === channel).notify_level, 'all');
    assert.equal((await mina.call('client.conversations.setNotify', { channel, level: 'loud' })).error, 'invalid_arguments');
    const priv = (await owner.ok('conversations.create', { name: 'notify-private', is_private: true })).channel.id;
    assert.equal((await mina.call('client.conversations.setNotify', { channel: priv, level: 'all' })).error, 'channel_not_found');
  });

  test('attention boot carries the counts the sidebar needs', async () => {
    const boot = await mina.ok('client.attention.boot');
    assert.equal(typeof boot.activity_unread, 'number');
    assert.ok(Array.isArray(boot.unread_threads));
    assert.equal(boot.dnd.self.snooze_enabled, false);
    assert.deepEqual(boot.message_policy, { msg_edit_window_mins: -1, allow_message_deletion: 'everyone' });
  });
});

describe('Do Not Disturb', () => {
  let t: TestApp;
  let owner: Session;
  let mina: Session;

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    mina = await addMember(t, owner, 'Mina Member');
  });
  after(() => t.close());

  test('snoozing shows for the person, and as a window to everyone else', async () => {
    const ownerStream = await owner.connect();
    const snooze = await mina.ok('dnd.setSnooze', { num_minutes: 30 });
    assert.equal(snooze.snooze_enabled, true);
    assert.ok(snooze.snooze_remaining > 1790 && snooze.snooze_remaining <= 1800);
    const self = await mina.ok('dnd.info');
    assert.equal(self.snooze_enabled, true);
    assert.equal(self.snooze_endtime, snooze.snooze_endtime);
    const seen = await owner.ok('dnd.info', { user: mina.userId });
    assert.equal(seen.snooze_enabled, undefined);
    assert.equal(seen.dnd_enabled, true);
    assert.ok(seen.next_dnd_start_ts <= Date.now() / 1000 && seen.next_dnd_end_ts === snooze.snooze_endtime);
    const event = await ownerStream.next((item) => item.type === 'dnd_updated_user' && item.user === mina.userId);
    assert.equal(event.dnd_status.next_dnd_end_ts, snooze.snooze_endtime);
    ownerStream.close();
    const team = await owner.ok('dnd.teamInfo', { users: `${mina.userId},${owner.userId}` });
    assert.equal(team.users[mina.userId].dnd_enabled, true);
    assert.equal(team.users[owner.userId].dnd_enabled, false);

    const ended = await mina.ok('dnd.endSnooze');
    assert.equal(ended.snooze_enabled, false);
    assert.equal((await mina.call('dnd.endSnooze')).error, 'snooze_not_active');
  });

  test('a daily schedule in the person’s time zone, ended early with dnd.endDnd', async () => {
    // A window that is open right now: from an hour ago to an hour from now, every day.
    const tz = (await mina.ok('users.info', { user: mina.userId })).user.tz as string;
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
    const [hour, minute] = parts.split(':').map(Number) as [number, number];
    const clock = (offset: number): string => {
      const total = (((hour * 60 + minute + offset) % 1440) + 1440) % 1440;
      return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
    };
    const set = await mina.ok('client.dnd.setSchedule', { enabled: true, start: clock(-60), end: clock(60), days: [0, 1, 2, 3, 4, 5, 6] });
    assert.equal(set.schedule.enabled, true);
    const now = Date.now() / 1000;
    const info = await owner.ok('dnd.info', { user: mina.userId });
    assert.ok(info.next_dnd_start_ts <= now && now < info.next_dnd_end_ts, 'inside the window');
    await mina.ok('dnd.endDnd');
    const after = await owner.ok('dnd.info', { user: mina.userId });
    assert.ok(after.next_dnd_start_ts > now, 'the next window is tomorrow');
    assert.equal((await mina.call('client.dnd.setSchedule', { start: '25:00' })).error, 'invalid_arguments');
  });

  test('“notify anyway” reaches someone whose notifications are paused, only from the author of the message', async () => {
    await mina.ok('dnd.setSnooze', { num_minutes: 10 });
    const dm = (await owner.ok('conversations.open', { users: mina.userId })).channel.id;
    const { ts } = await owner.ok('chat.postMessage', { channel: dm, text: 'urgent: the build is red' });
    const minaStream = await mina.connect();
    const result = await owner.ok('client.dnd.notifyAnyway', { channel: dm, ts });
    assert.deepEqual(result.notified, [mina.userId]);
    const override = await minaStream.next((item) => item.type === 'dnd_override');
    assert.equal(override.ts, ts);
    minaStream.close();
    assert.equal((await mina.call('client.dnd.notifyAnyway', { channel: dm, ts })).error, 'message_not_found');
  });
});

describe('scheduled messages and reminders', () => {
  let t: TestApp;
  let owner: Session;
  let mina: Session;
  let general: string;

  before(async () => {
    t = await startApp();
    owner = await setupWorkspace(t);
    mina = await addMember(t, owner, 'Mina Member');
    general = (await owner.ok('client.boot')).channels.find((item: Json) => item.is_general).id;
  });
  after(() => t.close());

  test('chat.scheduleMessage validates the time, lists, deletes and posts when due', async () => {
    const now = Math.floor(Date.now() / 1000);
    assert.equal((await owner.call('chat.scheduleMessage', { channel: general, text: 'x', post_at: now - 10 })).error, 'time_in_past');
    assert.equal((await owner.call('chat.scheduleMessage', { channel: general, text: 'x', post_at: now + 121 * 86_400 })).error, 'time_too_far');
    assert.equal((await owner.call('chat.scheduleMessage', { channel: general, text: '', post_at: now + 60 })).error, 'no_text');

    const later = await owner.ok('chat.scheduleMessage', { channel: general, text: 'standup in ten', post_at: now + 3600 });
    assert.match(later.scheduled_message_id, /^Q/);
    assert.equal(later.message.type, 'delayed_message');
    const soon = await owner.ok('chat.scheduleMessage', { channel: general, text: 'posted by the scheduler', post_at: now + 1 });
    const list = await owner.ok('chat.scheduledMessages.list', { channel: general });
    assert.deepEqual(
      list.scheduled_messages.map((item: Json) => item.id),
      [soon.scheduled_message_id, later.scheduled_message_id],
    );
    assert.equal((await mina.ok('chat.scheduledMessages.list')).scheduled_messages.length, 0, 'only your own');

    await owner.ok('chat.deleteScheduledMessage', { channel: general, scheduled_message_id: later.scheduled_message_id });
    assert.equal(
      (await owner.call('chat.deleteScheduledMessage', { channel: general, scheduled_message_id: later.scheduled_message_id })).error,
      'invalid_scheduled_message_id',
    );

    const stream = await mina.connect();
    const posted = await stream.next((event) => event.type === 'message' && event.text === 'posted by the scheduler', 4000);
    assert.equal(posted.user, owner.userId);
    stream.close();
    assert.equal((await owner.ok('chat.scheduledMessages.list')).scheduled_messages.length, 0);
  });

  test('a scheduled message survives a restart and posts once the server is back', async () => {
    const data = await startApp({ keepData: true });
    const boss = await setupWorkspace(data);
    const channel = (await boss.ok('client.boot')).channels.find((item: Json) => item.is_general).id;
    await boss.ok('chat.scheduleMessage', { channel, text: 'sent after a restart', post_at: Math.floor(Date.now() / 1000) + 1 });
    const dir = data.app.ctx.config.dataDir;
    await data.close();
    await sleep(1200);
    const again = await startApp({ dataDir: dir });
    try {
      const signedIn = new Session(again.base);
      await signedIn.ok('client.signin', { email: 'owner@acme.test', password: 'correct horse battery' });
      let found = false;
      for (let i = 0; i < 20 && !found; i += 1) {
        const history = await signedIn.ok('conversations.history', { channel, limit: 5 });
        found = history.messages.some((message: Json) => message.text === 'sent after a restart');
        if (!found) await sleep(100);
      }
      assert.ok(found);
    } finally {
      await again.close();
    }
  });

  test('reminders from words or timestamps, delivered by the reminder bot, completed or deleted', async () => {
    assert.equal((await mina.call('reminders.add', { text: 'x', time: 'whenever' })).error, 'cannot_parse');
    const weekly = await mina.ok('reminders.add', { text: 'Standup', time: 'every weekday at 9am' });
    assert.equal(weekly.reminder.recurring, true);
    assert.deepEqual(weekly.reminder.recurrence.weekdays, ['monday', 'tuesday', 'wednesday', 'thursday', 'friday']);
    assert.equal(weekly.reminder.time, undefined);
    assert.equal((await mina.call('reminders.complete', { reminder: weekly.reminder.id })).error, 'cannot_complete_recurring');

    const structured = await mina.ok('reminders.add', { text: 'Plants', time: String(Math.floor(Date.now() / 1000) + 7200), recurrence: { frequency: 'weekly', weekdays: ['monday'] } });
    assert.deepEqual(structured.reminder.recurrence, { frequency: 'weekly', weekdays: ['monday'] });

    const stream = await mina.connect();
    const soon = await mina.ok('reminders.add', { text: 'drink water', time: '1' });
    assert.equal(soon.reminder.recurring, false);
    const delivered = await stream.next((event) => event.type === 'message' && /^Reminder: drink water\.$/.test(event.text), 4000);
    const bot = (await mina.ok('users.info', { user: delivered.user })).user;
    assert.equal(bot.is_bot, true);
    assert.equal(bot.real_name, 'Reminders');
    assert.equal(delivered.channel_type, 'im');
    stream.close();

    const info = await mina.ok('reminders.info', { reminder: soon.reminder.id });
    assert.equal(info.reminder.complete_ts, 0);
    await mina.ok('reminders.complete', { reminder: soon.reminder.id });
    assert.ok((await mina.ok('reminders.info', { reminder: soon.reminder.id })).reminder.complete_ts > 0);
    assert.equal((await owner.call('reminders.info', { reminder: soon.reminder.id })).error, 'not_found');
    await mina.ok('reminders.delete', { reminder: weekly.reminder.id });
    const list = await mina.ok('reminders.list');
    assert.deepEqual(list.reminders.map((item: Json) => item.text).sort(), ['Plants', 'drink water']);

    // Someone else can be reminded; a bot cannot.
    const forOwner = await mina.ok('reminders.add', { text: 'Review the plan', time: 'tomorrow at 10am', user: owner.userId });
    assert.equal(forOwner.reminder.user, owner.userId);
    assert.equal(forOwner.reminder.creator, mina.userId);
    const bot2 = createBot(t, ['chat:write']);
    assert.equal((await mina.call('reminders.add', { text: 'x', time: 'in 5 minutes', user: bot2.userId })).error, 'cannot_add_bot');
  });

  test('saved for later: add, move between states, remove, and a reminder about the message', async () => {
    const { ts } = await owner.ok('chat.postMessage', { channel: general, text: 'read this later' });
    const saved = await mina.ok('client.saved.add', { channel: general, ts });
    assert.equal(saved.item.state, 'in_progress');
    assert.equal(saved.item.message.text, 'read this later');
    await mina.ok('client.saved.update', { channel: general, ts, state: 'completed' });
    assert.equal((await mina.ok('client.saved.list')).items.length, 0);
    assert.equal((await mina.ok('client.saved.list', { state: 'completed' })).items[0].ts, ts);
    assert.equal((await mina.call('client.saved.update', { channel: general, ts, state: 'later' })).error, 'invalid_arguments');
    const boot = await mina.ok('client.attention.boot');
    assert.deepEqual(boot.saved, [{ channel: general, ts, state: 'completed' }]);

    const stream = await mina.connect();
    await mina.ok('client.saved.remind', { channel: general, ts, time: '1' });
    const reminder = await stream.next((event) => event.type === 'message' && /^Reminder: Look at this message/.test(event.text), 4000);
    assert.match(reminder.text, /\/archives\/C[A-Z0-9]+\/p\d{16}\|View the message>$/);
    stream.close();
    await mina.ok('client.saved.remove', { channel: general, ts });
    assert.equal((await mina.call('client.saved.remove', { channel: general, ts })).error, 'not_found');
  });

  test('bot tokens can schedule too', async () => {
    const bot = createBot(t, ['chat:write']);
    const scheduled = await callWithToken(t.base, bot.token, 'chat.scheduleMessage', { channel: general, text: 'from the bot', post_at: String(Math.floor(Date.now() / 1000) + 600) });
    assert.equal(scheduled.ok, true);
    assert.equal(scheduled.message.bot_id, bot.botId);
  });
});
