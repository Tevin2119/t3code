# pi

T3 Code runs the `pi` coding agent on your selected environment over its own RPC
mode. pi is off by default; enable it in **Settings → Providers** before it appears
in the model picker.

## Set up pi

Install pi on the environment that runs your project so `pi` is on its `PATH`, or
set **Binary path** in provider settings.

pi fronts several model backends and stores one credential per backend, so set
**Provider** to the backend you want T3 Code to use. It defaults to `kimi-coding`.
The model list and the sign-in check both follow this setting.

### Sign in

**pi signs in from its own terminal UI.** It has no headless login command, so
T3 Code cannot start the flow for you. On the environment, run:

```bash
pi
```

then use `/login <provider>` — for example `/login kimi-coding` — and follow the
prompts. Use `/logout` in the same place to sign out.

Back in T3 Code, choose **Sign in to pi** in provider settings. That re-reads pi's
stored credential (refreshing an expired OAuth token along the way) and reports
whether the configured backend is ready. It does not start a sign-in.

You can also supply credentials without signing in, by setting the backend's API
key environment variable on the environment or writing it to `~/.pi/agent/auth.json`.
See pi's own provider documentation for the key names.

## Models and threads

Models come from `pi --list-models` for the configured backend, using pi's
`provider/model` slugs.

pi has no per-tool approval protocol and no sandbox, so its tools run with the
server's permissions and T3 Code's [permission modes](./permission-modes.md)
cannot gate them. Route work that needs gated tool use to another provider.

pi also cannot rewind its conversation: reverting a thread or editing and
resubmitting an earlier turn is unavailable.

## Accounts

Disabling a pi instance stops its sessions and keeps its credentials. Thread
history and workspace files are kept. Add a pi provider instance per backend or
account in **Settings → Providers**.
