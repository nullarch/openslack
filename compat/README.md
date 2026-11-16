# Compatibility harness

Runs apps built with the official Slack SDKs against a local server and records what they used. The apps are ordinary Bolt apps; the only setting that differs from running on Slack is the API base URL.

```
pnpm --filter ./compat test     # run the SDK apps; writes exercised.json
pnpm --filter ./compat table    # regenerate docs/COMPATIBILITY.md from it
```

| File | What it is |
|---|---|
| `test/bolt-suite.ts` | A Bolt for JavaScript app and the scenarios it is put through, over Socket Mode and over HTTP |
| `python/bolt_app.py` | The same app in Bolt for Python (Socket Mode), run through `uv`; skipped when `uv` is not installed |
| `test/harness.ts` | Records which Web API methods the SDK called and which payloads the app received |
| `scripts/compat-table.ts` | Compares the SDK's method list with the server's and writes the document |
| `exercised.json` | Output of the last test run, committed so the document can be regenerated without running the SDKs |

The server is started in-process on a free port and each suite gets its own empty workspace. Bolt for Python is the only part that starts a child process; the test stops it by its own process handle.

When a new SDK version changes what is sent, a scenario here fails. When the server gains a method, add a scenario that uses it through an SDK, then regenerate the table.
