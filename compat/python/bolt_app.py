"""An ordinary Bolt for Python app, over Socket Mode or over HTTP.

Nothing here knows it is not talking to Slack, except the API base URL passed to
the WebClient. Run by compat/test/bolt-python.test.ts: with APP_TOKEN it uses
Socket Mode; with SIGNING_SECRET and PORT it serves HTTP on that port.
"""

import os
import re
import threading

import slack_bolt
import slack_sdk
from slack_bolt import App
from slack_bolt.adapter.socket_mode import SocketModeHandler
from slack_sdk import WebClient

client = WebClient(token=os.environ["BOT_TOKEN"], base_url=os.environ["API_URL"])
app = App(client=client, signing_secret=os.environ.get("SIGNING_SECRET"))

CHANNEL_TYPE_EVENT = {
    "channel": "message.channels",
    "group": "message.groups",
    "im": "message.im",
    "mpim": "message.mpim",
}


@app.middleware
def note_delivery(body, next):
    # Report what reaches the app, for the compatibility table.
    event = body.get("event")
    if event:
        name = CHANNEL_TYPE_EVENT.get(event.get("channel_type"), "message") if event["type"] == "message" else event["type"]
    elif "command" in body:
        name = "slash_commands"
    else:
        name = body.get("type", "unknown")
    print(f"DELIVERED {name}", flush=True)
    next()


@app.message("hello")
def greet(message, say):
    say(text=f"Hey there <@{message['user']}>!", thread_ts=message["ts"])


@app.event("app_mention")
def mentioned(event, client):
    client.reactions_add(channel=event["channel"], timestamp=event["ts"], name="eyes")
    info = client.users_info(user=event["user"])
    name = info["user"]["real_name"]
    client.chat_postMessage(
        channel=event["channel"],
        thread_ts=event["ts"],
        text=f"Deploy requested by {name}",
        blocks=[
            {"type": "section", "text": {"type": "mrkdwn", "text": f"*{name}* asked for a deploy."}},
            {
                "type": "actions",
                "block_id": "deploy",
                "elements": [
                    {
                        "type": "button",
                        "action_id": "approve",
                        "style": "primary",
                        "text": {"type": "plain_text", "text": "Approve"},
                        "value": "build-12",
                    }
                ],
            },
        ],
    )


@app.action("approve")
def approve(ack, respond, body, action):
    ack()
    respond(text=f"Approved {action['value']} — thanks <@{body['user']['id']}>", replace_original=True)


@app.command("/pyecho")
def echo(ack, command, respond):
    ack(f"Echo: {command['text']}")
    respond(response_type="in_channel", text=f"<@{command['user_id']}> said: {command['text']}")


@app.message(re.compile("report"))
def report(message, client):
    client.files_upload_v2(
        channel=message["channel"],
        thread_ts=message["ts"],
        filename="report.txt",
        title="Nightly report",
        content="All 1,205 tests passed.\n",
        initial_comment="Here is the report.",
    )


@app.message(re.compile("summarise"))
def summarise(message, client, context):
    client.assistant_threads_setStatus(
        channel_id=message["channel"], thread_ts=message["ts"], status="is reading the channel…"
    )
    history = client.conversations_history(channel=message["channel"], limit=3)
    streamer = client.chat_stream(
        channel=message["channel"],
        thread_ts=message["ts"],
        recipient_team_id=context.team_id,
        recipient_user_id=context.user_id,
    )
    streamer.append(markdown_text=f"I read the last **{len(history['messages'])}** messages. ")
    streamer.append(markdown_text="Nothing is on fire.")
    streamer.stop()


@app.shortcut("file_bug")
def file_bug(ack, shortcut, client):
    ack()
    client.views_open(
        trigger_id=shortcut["trigger_id"],
        view={
            "type": "modal",
            "callback_id": "bug_form",
            "private_metadata": os.environ.get("BUG_CHANNEL", ""),
            "title": {"type": "plain_text", "text": "File a bug"},
            "submit": {"type": "plain_text", "text": "File"},
            "blocks": [
                {
                    "type": "input",
                    "block_id": "title",
                    "label": {"type": "plain_text", "text": "Title"},
                    "element": {"type": "plain_text_input", "action_id": "value"},
                },
                {
                    "type": "input",
                    "block_id": "due",
                    "label": {"type": "plain_text", "text": "Due"},
                    "element": {"type": "datepicker", "action_id": "date"},
                },
            ],
        },
    )


@app.view("bug_form")
def bug_form(ack, view, body, client):
    values = view["state"]["values"]
    title = values["title"]["value"]["value"] or ""
    if len(title) < 5:
        ack(response_action="errors", errors={"title": "Use at least five characters"})
        return
    ack()
    due = values["due"]["date"]["selected_date"]
    client.chat_postMessage(channel=view["private_metadata"], text=f"Bug filed by <@{body['user']['id']}>: {title} (due {due})")


@app.event("app_home_opened")
def home_opened(event, client):
    client.views_publish(
        user_id=event["user"],
        view={"type": "home", "blocks": [{"type": "section", "text": {"type": "mrkdwn", "text": "*Hello from Python*"}}]},
    )


if __name__ == "__main__":
    versions = f"VERSIONS slack_bolt {slack_bolt.version.__version__}, slack_sdk {slack_sdk.version.__version__}"
    if os.environ.get("APP_TOKEN"):
        handler = SocketModeHandler(app, os.environ["APP_TOKEN"])
        handler.connect()
        print(versions, flush=True)
        print("READY", flush=True)
        threading.Event().wait()
    else:
        # Bolt's built-in development server; it starts listening right after READY is printed.
        print(versions, flush=True)
        print("READY", flush=True)
        app.start(port=int(os.environ["PORT"]), path="/slack/events")
