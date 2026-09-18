# Hermes

T3 Code runs the Hermes Agent CLI as an ACP agent on your selected environment.
Hermes is off by default; enable it in **Settings → Providers** before it appears
in the model picker.

Hermes is a front end for another inference provider — DeepSeek on a default
install — so it holds its own API key and model choice. T3 Code stores neither.

## Set up Hermes

Install Hermes on the environment that runs your project so `hermes` is on its
`PATH`, or set **Binary path** in provider settings.

Sign-in happens in Hermes' own wizard, not in T3 Code. Run this in a terminal on
that environment:

```bash
hermes acp --setup
```

It asks for an inference provider and a model, and stores the credential in
Hermes' config. Back in T3 Code, enable Hermes and choose **Check credentials**;
the provider card reports which provider Hermes is configured with once it can
read one.

**Auto-approve shell hooks** decides what happens the first time Hermes meets a
project's shell hooks. Hermes normally asks about them on a terminal, which a T3
Code session has no way to answer, so leave this off unless you want those hooks
to run unattended.

## Models and threads

The model list comes from Hermes' own configuration: T3 Code offers the provider
and model that `hermes acp` will run, written the way Hermes writes it
(`deepseek:deepseek-v4-pro`). Picking a different model is possible once Hermes
reports one for the session; otherwise every thread runs on Hermes' configured
default. Change it with `hermes model` on the environment.

Hermes cannot rewind its conversation: reverting a thread or editing and
resubmitting an earlier turn is unavailable. Continue with a follow-up message or
start a new thread.

Tool approvals follow [Permission modes](./permission-modes.md).

### A slow first session

Hermes loads every configured MCP server, plugin and tool before it answers the
first request of a session. On an environment with a large Hermes configuration
this takes a long time, and T3 Code shows the thread as starting throughout. If a
thread never finishes starting, trim that configuration — `hermes config show`
lists what it loads — or start Hermes' MCP servers on demand rather than at boot.

### A separate Hermes config for T3 Code

**HERMES_HOME path** in provider settings points the instance at a different
Hermes home, so T3 Code can run Hermes with its own `config.yaml` while the one
you use in a terminal stays as it is. Leave it empty to use Hermes' default home.

This is the fix when threads hang at starting because Hermes' memory provider
is enabled: copy your Hermes home to a new directory, set `memory.provider: ''`
in that copy's `config.yaml`, and enter the directory here. The credential check
and model list read from the same home, so run `hermes acp --setup` with
`HERMES_HOME` set to that directory if the copy has no credential yet.

## Accounts and removal

| Action  | Effect                                                          |
| ------- | --------------------------------------------------------------- |
| Disable | Stops the instance's sessions and keeps Hermes' own credential. |
| Log out | `hermes logout` on the environment, outside T3 Code.            |

Both keep thread history and workspace files.

Add a Hermes provider instance per configuration in **Settings → Providers**.
Instances share the machine's Hermes credential, so point them at different
binaries or environments if they should differ.
