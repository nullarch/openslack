import { parseWhen, splitReminder } from '@app/shared';
import { S } from '../strings';
import { adoptChannel, attempt, go, leaveChannel, sendMessage, toast } from './actions';
import { call } from './api';
import { patchAtt, resumeNotifications, snooze, whenText } from './attention';
import { conversation, conversationName, displayName, get } from './store';

/**
 * Slash commands built into the client, as Slack has them. They take priority
 * over an app command with the same name. Arguments arrive already encoded:
 * people as `<@U…>`, channels as `<#C…>`.
 */

export interface BuiltInContext {
  channel: string;
  threadTs?: string;
  /** Everything after the command, encoded. */
  args: string;
}

export interface BuiltIn {
  command: string;
  usage: string;
  description: string;
  /** Returns false to keep the text in the composer (the command did not run). */
  run(context: BuiltInContext): Promise<boolean>;
}

function userIds(text: string): string[] {
  return [...text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((match) => match[1]!);
}

function channelIds(text: string): string[] {
  return [...text.matchAll(/<#([CDG][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((match) => match[1]!);
}

/** A person named without the composer's autocomplete: "@mina", "mina", "Mina Member". */
function findPerson(word: string): string | undefined {
  const name = word.replace(/^@/, '').toLowerCase();
  if (!name) return undefined;
  return Object.values(get().users).find(
    (user) => !user.deleted && [user.name, user.profile.display_name, user.real_name].some((value) => value?.toLowerCase() === name),
  )?.id;
}

function findChannel(word: string): string | undefined {
  const name = word.replace(/^#/, '').toLowerCase();
  const state = get();
  return [...Object.values(state.channels), ...Object.values(state.others)].find((conv) => conv.is_channel && conv.name === name)?.id;
}

function isChannelConversation(channel: string): boolean {
  const conv = conversation(get(), channel);
  return Boolean(conv?.is_channel);
}

const commands: BuiltIn[] = [
  {
    command: '/status',
    ...S.att.commands.status,
    async run({ args }) {
      const match = /^\s*(:[a-z0-9_+'-]+:)?\s*([\s\S]*)$/i.exec(args) ?? [];
      const emoji = match[1] ?? '';
      const text = (match[2] ?? '').trim();
      const result = await attempt(() =>
        call('users.profile.set', { profile: { status_text: text, status_emoji: emoji || (text ? ':speech_balloon:' : ''), status_expiration: 0 } }),
      );
      if (result) toast(text || emoji ? S.att.commands.statusSet : S.att.commands.statusCleared);
      return Boolean(result);
    },
  },
  {
    command: '/away',
    ...S.att.commands.away,
    async run() {
      const state = get();
      const away = state.presence[state.self?.id ?? ''] !== 'active';
      const result = await attempt(() => call('users.setPresence', { presence: away ? 'auto' : 'away' }));
      if (result) toast(away ? S.att.commands.nowActive : S.att.commands.nowAway);
      return Boolean(result);
    },
  },
  {
    command: '/dnd',
    ...S.att.commands.dnd,
    async run({ args }) {
      const text = args.trim().toLowerCase();
      if (text === 'off' || text === 'end' || text === 'stop') {
        await resumeNotifications();
        toast(S.att.commands.dndOff);
        return true;
      }
      let minutes = 60;
      const number = /^(\d+)\s*(m|min|mins|minutes?|h|hr|hrs|hours?)?$/.exec(text);
      if (number) minutes = Number(number[1]) * (number[2]?.startsWith('h') ? 60 : 1);
      else if (text) {
        const tz = get().self?.tz ?? 'UTC';
        const when = parseWhen(text.replace(/^until /, ''), Date.now(), tz) ?? parseWhen(`in ${text}`, Date.now(), tz);
        if (!when) {
          toast(S.errors.cannot_parse, 'error');
          return false;
        }
        minutes = Math.max(1, Math.round((when.time - Date.now()) / 60_000));
      }
      await snooze(minutes);
      toast(S.att.commands.dndOn(minutes));
      return true;
    },
  },
  {
    command: '/invite',
    ...S.att.commands.invite,
    async run({ channel, args }) {
      const people = userIds(args);
      const words = args.replace(/<[@#][^>]+>/g, ' ').trim().split(/\s+/).filter(Boolean);
      for (const word of words) {
        if (word.startsWith('#')) continue;
        const id = findPerson(word);
        if (id) people.push(id);
      }
      const target = channelIds(args)[0] ?? words.filter((word) => word.startsWith('#')).map(findChannel).find(Boolean) ?? channel;
      if (people.length === 0) {
        toast(S.att.commands.unknownPerson, 'error');
        return false;
      }
      const result = await attempt(() => call('conversations.invite', { channel: target, users: people.join(',') }));
      if (result) {
        const state = get();
        toast(S.att.commands.invited(people.map((id) => displayName(state.users[id])).join(', '), `#${conversationName(state, conversation(state, target))}`));
      }
      return Boolean(result);
    },
  },
  {
    command: '/leave',
    ...S.att.commands.leave,
    async run({ channel }) {
      if (!isChannelConversation(channel)) return false;
      await leaveChannel(channel);
      return true;
    },
  },
  {
    command: '/topic',
    ...S.att.commands.topic,
    async run({ channel, args }) {
      return Boolean(await attempt(() => call('conversations.setTopic', { channel, topic: args.trim() })));
    },
  },
  {
    command: '/purpose',
    ...S.att.commands.purpose,
    async run({ channel, args }) {
      return Boolean(await attempt(() => call('conversations.setPurpose', { channel, purpose: args.trim() })));
    },
  },
  {
    command: '/rename',
    ...S.att.commands.rename,
    async run({ channel, args }) {
      const result = await attempt(() => call('conversations.rename', { channel, name: args.trim() }));
      if (result) adoptChannel(result.channel);
      return Boolean(result);
    },
  },
  {
    command: '/me',
    ...S.att.commands.me,
    async run({ channel, threadTs, args }) {
      const text = args.trim();
      if (!text) return false;
      // Slack's me_message has no thread form; in a thread it is sent as italic text.
      if (threadTs) {
        void sendMessage({ channel, threadTs, text: `_${text}_` });
        return true;
      }
      return Boolean(await attempt(() => call('chat.meMessage', { channel, text })));
    },
  },
  {
    command: '/shrug',
    ...S.att.commands.shrug,
    async run({ channel, threadTs, args }) {
      void sendMessage({ channel, threadTs, text: `${args.trim()} ¯\\_(ツ)_/¯`.trim() });
      return true;
    },
  },
  {
    command: '/remind',
    ...S.att.commands.remind,
    async run({ args }) {
      const state = get();
      const text = args.trim();
      if (/^(list|help)?$/i.test(text)) {
        if (/^list$/i.test(text)) go({ name: 'view', view: 'later' });
        else toast(S.att.remind.usage);
        return true;
      }
      let target = state.self?.id ?? '';
      let rest = text;
      const who = /^(me|<@([UW][A-Z0-9]+)(?:\|[^>]*)?>|@\S+)\s+/i.exec(text);
      if (who) {
        rest = text.slice(who[0].length);
        if (who[2]) target = who[2];
        else if (who[1]!.toLowerCase() !== 'me') {
          const person = findPerson(who[1]!);
          if (!person) {
            toast(S.att.commands.unknownPerson, 'error');
            return false;
          }
          target = person;
        }
      }
      const parts = splitReminder(rest, Date.now(), state.self?.tz ?? 'UTC');
      if (!parts) {
        toast(S.att.remind.usage, 'error');
        return false;
      }
      const result = await attempt(() => call('reminders.add', { text: parts.what, time: parts.when, user: target }));
      if (!result) return false;
      const when = result.reminder.recurring ? parts.when : whenText(result.reminder.time);
      toast(target === state.self?.id ? S.att.remind.set(parts.what, when) : S.att.remind.setFor(displayName(state.users[target]), parts.what, when));
      return true;
    },
  },
  {
    command: '/msg',
    ...S.att.commands.msg,
    async run({ args }) {
      const match = /^\s*(<[@#][A-Z0-9]+(?:\|[^>]*)?>|[@#]\S+)\s*([\s\S]*)$/.exec(args);
      if (!match) {
        toast(S.att.commands.needTarget, 'error');
        return false;
      }
      const token = match[1]!;
      const body = match[2]!.trim();
      let channel: string | undefined;
      const person = userIds(token)[0] ?? (token.startsWith('@') ? findPerson(token) : undefined);
      if (person) {
        const opened = await attempt(() => call('conversations.open', { users: person, return_im: true }));
        if (!opened) return false;
        adoptChannel(opened.channel);
        channel = opened.channel.id;
      } else {
        channel = channelIds(token)[0] ?? (token.startsWith('#') ? findChannel(token) : undefined);
      }
      if (!channel) {
        toast(token.startsWith('@') ? S.att.commands.unknownPerson : S.att.commands.unknownChannel, 'error');
        return false;
      }
      if (!body) {
        go({ name: 'conversation', id: channel });
        return true;
      }
      const result = await attempt(() => call('chat.postMessage', { channel, text: body }));
      if (result) toast(S.att.commands.sentTo(conversationName(get(), conversation(get(), channel)) || token));
      return Boolean(result);
    },
  },
  {
    command: '/search',
    ...S.att.commands.search,
    async run({ args }) {
      go({ name: 'search', query: args.trim() });
      return true;
    },
  },
  {
    command: '/collapse',
    ...S.att.commands.collapse,
    async run({ channel }) {
      patchAtt((att) => ({ collapsed: { ...att.collapsed, [channel]: true } }));
      toast(S.att.commands.collapsed);
      return true;
    },
  },
  {
    command: '/expand',
    ...S.att.commands.expand,
    async run({ channel }) {
      patchAtt((att) => {
        const collapsed = { ...att.collapsed };
        delete collapsed[channel];
        return { collapsed };
      });
      toast(S.att.commands.expanded);
      return true;
    },
  },
];

export const BUILT_INS: readonly BuiltIn[] = commands;

export function findBuiltIn(name: string): BuiltIn | undefined {
  return commands.find((command) => command.command === name.toLowerCase());
}
