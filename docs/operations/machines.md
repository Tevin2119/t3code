# Machines: how T3 Code and the delivery engine run on each one

The fork runs on several machines. This page is the one place that says what runs where, how it
is started, stopped and reached, and where the per-machine files live. It was written from the
Mac on 2026-11-10; what another machine runs is stated only as far as its own notes say. Nothing
here is a secret: pairing links, tokens and sign-ins stay on the machine that issued them.

Related: the engine's own setup notes live in the Operation-PaperClip repository,
`docs/context/delivery-system/SETUP-WALKTHROUGH.md` (bringing a new machine up) and
`OPERATING.md` (the Windows host). The fork's own development procedures are in
[development.md](./development.md). Keep this page to what runs in production on each machine.

## The pieces, on every machine

| Piece               | What it is                                                                                                                                                       | Talks to                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| T3 Code (this fork) | T3's own server, serving the built web app and its API on one port. Not the dev server.                                                                          | Browsers, phones and other machines on the tailnet. Calls the engine for the Board.  |
| Delivery engine     | Operation-PaperClip, `node delivery/delivery.mjs serve`. Runs tasks through teams of harnesses in worktrees.                                                     | Loopback only. T3 is its window; nothing else reaches it.                            |
| Profiles            | One folder of sign-ins per profile: `main` (personal) and `pm` (the PolyMania team account). An environment variable per harness points at the profile's folder. | `~/.polymania/workspaces.json` names each profile's homes and ports on that machine. |
| Tailscale           | The only network path between machines. T3 listens on the tailnet address only, never Wi-Fi or LAN.                                                              |                                                                                      |

`workspaces.json` is per machine and never committed: it holds the machine id and label, the
engine and T3 checkouts, and for each profile its account folders, T3 home and port, and engine
home, port and repository.

## Machine table

| Machine                     | OS         | Tailnet name         | Profile running | T3 port                                                 | Engine port            | Started by                                                                                                                                    | Notes                                                                                                                                                                    |
| --------------------------- | ---------- | -------------------- | --------------- | ------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tevin's MacBook Pro         | macOS      | `tevins-macbook-pro` | `pm`            | 16231 (tailnet address) and 16232 (loopback, for HTTPS) | 4321                   | launchd jobs, see below                                                                                                                       | The machine this page was written from. Also runs `tailscale serve` for HTTPS.                                                                                           |
| AMD box (`DESKTOP-2K5Q5NJ`) | Windows 11 | `desktop-2k5q5nj-1`  | team            | see its `OPERATING.md`                                  | see its `OPERATING.md` | By hand after sign-in: T3 desktop app from the Start menu, engine from a terminal, test instance by `pwsh delivery/qualification/restart.ps1` | Must run in the signed-in session, never session 0 or a service: Codex's sandbox refuses the desktop there. Documented 2026-09-29 in Operation-PaperClip `OPERATING.md`. |
| Laptops                     |            |                      |                 |                                                         |                        |                                                                                                                                               | Not yet set up. Follow "Bringing a new machine up". Add a row when done.                                                                                                 |

A tailnet address is read with `tailscale ip -4`, not copied from this table: it can change.

## The Mac, in detail

Everything is under the `pm` profile. Personal `main` sign-ins are in the default folders and
are never touched by these jobs.

### Files

| File on the Mac                                      | Copy in this repo                                               | Role                                                                                                                                                                                                                |
| ---------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.local/bin/t3net`                                 | `docs/operations/machines/t3net`                                | Starts T3 under its checkout supervisor on the tailnet address, port 16231, `pm` profile. Resolves the login PATH itself because launchd gives none. Refuses to start while Tailscale is down or the port is taken. |
| `~/.local/bin/pm`                                    | not copied: it is in Operation-PaperClip `SETUP-WALKTHROUGH.md` | Runs a command with the team accounts; with no command, starts the engine for the `pm` profile.                                                                                                                     |
| `~/.local/bin/t3-owner-link`                         | `docs/operations/machines/t3-owner-link`                        | Prints a five-minute owner pairing link from the running T3. Treat the link as a secret.                                                                                                                            |
| `~/.local/bin/t3-tailnet-forward`                    | `docs/operations/machines/t3-tailnet-forward`                   | Allow-listed TCP forwarder for a dev server's port, when Tailscale Serve is not an option. Not used by the production jobs.                                                                                         |
| `~/.local/bin/tstack-sync`                           | `docs/operations/machines/tstack-sync`                          | Copies shared agent skills from `~/Projects/tstack` into every harness's skills folder. Copies, not symlinks: some harnesses skip symlinked folders.                                                                |
| `~/.local/share/t3https/forward.mjs`                 | `docs/operations/machines/t3https-forward.mjs`                  | Forwards `127.0.0.1:16232` to the tailnet address on 16231, so `tailscale serve` (which proxies only to loopback on macOS) can give T3 an `https://…ts.net` address. Phones need HTTPS to install T3 as an app.     |
| `~/Library/LaunchAgents/com.polymania.t3net.plist`   | `docs/operations/machines/com.polymania.t3net.plist`            | Runs `t3net` at login and restarts it if it stops, retrying every 30 seconds while Tailscale is not up.                                                                                                             |
| `~/Library/LaunchAgents/com.polymania.t3https.plist` | `docs/operations/machines/com.polymania.t3https.plist`          | Runs the HTTPS forwarder at login.                                                                                                                                                                                  |

The copies under `docs/operations/machines/` are the Mac's files as they were on 2026-11-10, with
the Mac's absolute paths in them. To install one elsewhere, copy it out and change the paths and
node version it names. The copies are a record and a starting point, not a package.

### launchd jobs

| Label                            | Runs                                     | Log                                       |
| -------------------------------- | ---------------------------------------- | ----------------------------------------- |
| `com.polymania.t3net`            | `~/.local/bin/t3net`                     | `~/.paperclip/polymania/logs/t3net.log`   |
| `com.polymania.t3https`          | the HTTPS forwarder                      | `~/.paperclip/polymania/logs/t3https.log` |
| `com.polymania.engine.pm`        | the delivery engine for the `pm` profile | engine home `~/.paperclip/polymania`      |
| `com.polymania.stay-awake-on-ac` | keeps the Mac awake on mains             |                                           |

```sh
launchctl list | grep polymania                         # what is loaded
launchctl kickstart -k gui/$UID/com.polymania.t3net     # restart T3; back in 20 to 40 seconds
launchctl bootout gui/$UID/com.polymania.t3https        # stop the HTTPS forwarder
lsof -nP -iTCP:16231 -iTCP:16232 -iTCP:4321 -sTCP:LISTEN # who owns the ports
```

T3 updates itself from the fork's configured remote and branch ("Update and restart" in the
app). The engine reads its limits only at start, so a limits change needs an engine restart.

### Reaching the Mac's T3

- From the tailnet: `http://<tailnet address>:16231`. Pair the browser once with the link
  `t3net` prints at start, or a fresh one from `t3-owner-link`.
- Over HTTPS, for phones: `https://tevins-macbook-pro.<tailnet domain>.ts.net`, served by
  `tailscale serve --https=443` proxying to `127.0.0.1:16232`. `tailscale serve status` shows it.
  Undo with `tailscale serve --https=443 off` and booting out `com.polymania.t3https`.
- The engine is loopback only on 4321. Nothing reaches it from another machine; T3 does.

### Known traps

- **PATH under launchd.** launchd starts jobs with `/usr/bin:/bin:/usr/sbin:/sbin`. T3's own
  login-shell PATH probe gives up after two seconds, which fails when the Mac is busy, and then
  updates fail with `spawn pnpm ENOENT` and every provider CLI shows unavailable. `t3net` resolves
  the login PATH itself with no time limit and falls back to known locations. Keep PATH handling
  in `t3net`, not in T3.
- **Hidden controls under load.** When the Mac is overloaded, the web client's session-scope load
  times out and permission-gated controls (pairing links, provider setup, Connections) disappear.
  The sessions still hold every scope. It is load, not auth. The engine's concurrent agent test
  suites are the usual cause; its limits were lowered to global 4, build 2, qa 1 on 2026-10-29.
- **Two engine checkouts.** `t3net` launches through
  `~/Projects/opc-chat-board-placement/delivery/tools/account-workspaces.mjs`, while `pm` and
  `workspaces.json` name `~/Projects/Operation-PaperClip-mac`. Both are checkouts of
  Operation-PaperClip. Before changing the launcher, check which commit each is on.
- **Skills live per harness.** Each harness reads its own skills folder (see the targets in
  `tstack-sync`). Adding a shared skill means editing `~/Projects/tstack` and running
  `tstack-sync`. `~/.polymania/claude/skills/synced` belongs to Claude.ai's own sync. Leave it.
- **Which database is live.** The `pm` profile's T3 home is `~/.polymania/t3-pm`; the fork
  baseline note in [updating.md](../user/updating.md#fork-baseline-nightly-integration-for-delivery-work)
  describes how to find the running server's descriptor. `~/.t3/userdata` is a different home.

## The Windows host, in brief

Operation-PaperClip `docs/context/delivery-system/OPERATING.md` is the authority. The points
that differ from the Mac:

- Nothing starts by itself. After sign-in: T3 desktop app, then the engine from a terminal in
  the same session, then `pwsh delivery/qualification/restart.ps1` for the isolated test
  instance.
- Never a Windows service or a "run whether user is logged on or not" task. Those run in
  session 0, where Codex's sandboxed runner is refused the desktop and exits with `0xC0000142`.
- Locking the desktop keeps everything running. Signing out stops everything and cuts off
  work in progress, which the engine takes up again on the next start.
- Other machines reach its T3 through `t3.host` and `t3.url` in the git-ignored
  `delivery/qualification/settings.local.json`, set to its Tailscale address.

## Bringing a new machine up

1. Follow Operation-PaperClip `SETUP-WALKTHROUGH.md`: Node 24 or later, git, `gh` signed in,
   the harness CLIs, one clean clone each of the engine and this fork, and a profile launcher
   (`pm` on macOS) that points every harness at the team's sign-in folders.
2. Sign each harness in once under the team profile (`pm claude auth login`, `pm codex login`,
   and so on). Sign-ins never leave the machine.
3. Join the tailnet. Note the machine's tailnet name; do not record its address.
4. On macOS, copy `docs/operations/machines/t3net` and its plist, fix the absolute paths and the
   node version, load the job with `launchctl bootstrap gui/$UID <plist>`, and pair the first
   browser with the link in `t3net.log`. On Windows, follow `OPERATING.md`.
5. Run `tstack-sync` (or its equivalent) so every harness has the shared skills.
6. Add the machine's row to the table above, with how it is started and what is unverified.

## Keeping this page right

A change to a launcher, a port, a profile or a job on any machine changes this page in the same
PR, or the next one. A fact nobody has checked on a machine is marked unverified rather than
guessed.
