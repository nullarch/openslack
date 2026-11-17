# Moving a team from Slack

This takes an afternoon for a small team. The order matters: set up first, import second, invite people third, repoint bots last.

## 1. Export from Slack

A workspace owner or admin exports from **Workspace settings → Import/Export Data → Export**. Slack emails a link to a `.zip` when it is ready.

What the export contains depends on your Slack plan and on Slack's approval: a standard export covers public channels; private channels and direct messages need a plan or an approval that allows them. Check Slack's help page "Export your workspace data" for what your plan includes before you plan the move.

## 2. Start the server and create the workspace

```bash
npx openslack                     # or docker compose up -d
```

Open the address it prints and create the workspace. Use the **same email address** you use on Slack: the import recognises you by it and merges your Slack account into the owner account you just made.

## 3. Import

Stop the server (or plan to restart it afterwards), then:

```bash
openslack import-slack ./slack-export.zip
openslack import-slack ./slack-export.zip --download-files   # also copy the files
```

The import keeps Slack's ids for people, channels and messages, so `@mentions`, `#channel` links and threads still resolve. Running it again is safe: anything already imported is skipped, so you can import a fresh export on the day you switch.

At the end it prints what it could not carry over exactly, one line per item, for example a reply whose thread starter was not in the export.

**Files.** With `--download-files` each file is fetched from the address recorded in the export. Those addresses stop working after a while; if downloads fail, export again and import again (already-imported messages are skipped). Without the flag, messages keep a link to the file in Slack.

## 4. Invite people

Send invite links from **Invite people**. Someone who was in the Slack export accepts an invite **with the same email address**; they get their existing account, with their messages, DMs and channel memberships already in place.

## 5. Repoint bots and agents

Apps built on Slack's SDKs keep working with one changed setting. Create each app under **Administration → Apps** to get its tokens, then:

| What you run | Change |
|---|---|
| Bolt for JavaScript | `new App({ …, clientOptions: { slackApiUrl: 'https://chat.example.com/api/' } })` |
| Bolt for Python | `App(client=WebClient(token=…, base_url="https://chat.example.com/api/"))` |
| `@slack/web-api` / `slack_sdk` directly | the same `slackApiUrl` / `base_url` option |
| OpenClaw | `SLACK_API_URL=https://chat.example.com/api/` ([details](../compat/openclaw/README.md)) |
| Incoming webhooks | Create a webhook under the app and replace the old `hooks.slack.com` URL |
| HTTP (Events API) apps | Set the app's events and interactivity URLs under **Administration → Apps**, and use the new signing secret |

Socket Mode apps are the easiest: nothing on your side needs to be reachable from the server.

[`COMPATIBILITY.md`](COMPATIBILITY.md) lists exactly which API methods and events are supported. If an app calls a method that is missing, the call fails with `unknown_method`, as Slack's API does for a method it does not know, and the server counts it; admins can list those counts with the `client.apps.unknownMethods` API method.

Apps that Slack or a vendor runs for you (installed from the Slack Marketplace, or a vendor's hosted bot) cannot be repointed, because you cannot change where they send requests.

## What does not come across

- Canvases, lists, workflows, huddle recordings and clips.
- Custom emoji (they are not part of a Slack export); add them again under **Administration → Custom emoji**.
- Slack Connect channels shared with other organisations.
- Each person's preferences, sidebar sections, saved items and reminders.

## Coming from Mattermost

Export with `mmctl export create` (add the flag for attachments if you want files), download the zip, then:

```bash
openslack import-mattermost ./export.zip
```

Teams fold into the one workspace; channels whose names collide across teams get the team's name in front (`eng-town-square`). Messages, replies, reactions, direct and group messages and attached files come across; Markdown is converted. As with Slack, people claim their account by accepting an invite with the same email address, and running the import again adds only what is new.

The importer follows Mattermost's documented bulk format. It has been tested with a hand-written export in that format, not yet with a real `mmctl` export; the documentation does not describe where attachments sit inside the zip, so the importer looks for each path as written, under the export file's folder and under `data/`.

## Coming from Discord

Discord has no export of a whole server, so use [DiscordChatExporter](https://github.com/Tyrrrz/DiscordChatExporter) to export the channels you want as **JSON**, ideally with media downloaded alongside, then:

```bash
openslack import-discord ./exports/                    # a folder of .json files (or one file, or a .zip)
openslack import-discord ./exports/ --download-files   # also fetch attachments that are still Discord links
```

Text channels come across as channels; threads become threads under the message that started them; forum posts become threads in a channel named after the forum; replies become messages that link to what they answer; reactions, pins and edits are kept. Discord's markdown and mentions are converted.

Discord exports contain no email addresses, so the authors are kept as deactivated "former member" accounts that carry their names on the history; people join with new accounts. Direct messages are not imported. Running the import again adds only what is new.

## Running both for a while

You can keep Slack running while the team tries the new workspace, and import again just before switching: the second import adds only what is new.
