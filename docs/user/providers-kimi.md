# Kimi

T3 Code runs Moonshot's Kimi Code CLI as an ACP agent on your selected environment.
Kimi is off by default; enable it in **Settings → Providers** before it appears in
the model picker.

## Set up Kimi

Install the Kimi Code CLI on the environment that runs your project so `kimi` is on
its `PATH`, or set **Binary path** in provider settings. Then enable Kimi and
choose **Sign in to Kimi**.

Kimi keeps separate credentials per region. Pick **Sign-in region** — Global
(`kimi.ai`) or Mainland China (`kimi.com`) — before signing in; changing it later
means signing in again.

### Complete the device-code sign-in

Kimi signs in with a device code rather than a browser redirect. T3 Code shows a
sign-in link and a short code. Open the link on any device, enter the code, and
approve the request. There is nothing to paste back into T3 Code — the CLI is
polling and finishes on its own, and T3 Code re-reads the credential before it
reports success. The code expires after 30 minutes; start sign-in again if it does.

Because the code travels with you, this works the same from a phone or a second
computer as it does on the environment itself.

You can also run `kimi login` in a terminal on the environment. T3 Code picks the
credential up on its next provider status refresh.

## Models and threads

The model list comes from `kimi provider list` on the environment, so it reflects
your Moonshot account. Kimi cannot rewind its conversation: reverting a thread or
editing and resubmitting an earlier turn is unavailable. Continue with a follow-up
message or start a new thread.

Tool approvals follow [Permission modes](./permission-modes.md).

## Accounts and removal

| Action           | Effect                                                          |
| ---------------- | --------------------------------------------------------------- |
| Disable          | Stops the instance's sessions and keeps its Kimi sign-in.       |
| Sign out of Kimi | Stops the instance's sessions and removes its saved credential. |

Both keep thread history and workspace files. Sending `/logout` by itself in a
thread signs out its instance, including stopping that instance's other sessions.

Add a Kimi provider instance per Moonshot account in **Settings → Providers**.
Each instance has its own sign-in.
