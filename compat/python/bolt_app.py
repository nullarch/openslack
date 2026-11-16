"""An ordinary Bolt for Python app over Socket Mode.

Nothing here knows it is not talking to Slack, except the API base URL passed to
the WebClient. Run by compat/test/bolt-python.test.ts.
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
app = App(client=client)

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


if __name__ == "__main__":
    handler = SocketModeHandler(app, os.environ["APP_TOKEN"])
    handler.connect()
    print(f"VERSIONS slack_bolt {slack_bolt.version.__version__}, slack_sdk {slack_sdk.version.__version__}", flush=True)
    print("READY", flush=True)
    threading.Event().wait()
