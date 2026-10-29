# Updating T3 Code

The app you use and the server running your agents can be on different machines.
When a server is behind your web or desktop app, the update button at the bottom
of the sidebar and **Settings → Environments** offer to update it.

## Update everything at once

The update button at the bottom of the sidebar updates every connected machine
in one step. It updates outdated providers, then servers that are behind, then
the desktop app you are using. Servers move to the
version your desktop app is installing, or to your web app's version. A
background service stays on its current release channel. A remote desktop app
installs the latest release from its own channel. Hover the button to see what
it will update.

While it runs, the button widens to show progress. It names a machine that is
taking longer than usual, and offers **Retry** for a server that failed. Click
it to see every machine. The desktop app restarts once each server has started
its own restart, after a short countdown. Choose **Later** to keep working and
restart from the update button when you are ready. A server still restarting
finishes on its own, and the button keeps showing it after the desktop app
restarts.

Remote desktop apps never wait for npm. When the desktop app offers the update,
background services update right away too. Other servers, including older
background services, update only after that version is published to npm. The
confirmation lists each machine it skips and why, such as a machine that is
offline or needs a manual update. Use **Settings → Environments** for those.

If a desktop app restarts on its old version, T3 Code tells you the update did
not apply. It does not install that version again on its own, even when another
device asks. Use the update button on that machine to retry.

The confirmation counts the running threads that the restarts will interrupt,
and how many can resume afterwards. See **Continue threads after restarts**
below.

## Switch between Stable and Nightly

In the desktop app, change **Settings → About → Update track**. T3 Code shows each
connected machine it will move and each one it skips, then moves them in one
step. Remote servers install the latest release on the new track. Remote desktop
apps reinstall on the new track. This app reinstalls last. Your threads,
settings, and data stay.

A background service cannot move to an older release remotely. When Stable is
older than its Nightly, run `t3 update --channel stable --allow-downgrade` on
that machine.

A switch is blocked for a machine whose database already has changes the
target release does not support, or when T3 Code cannot confirm that it does.
The dialog says why: update a machine on its current track first when its
release is too old to check, or wait until the target track includes the
changes. A Mac running the desktop app must switch on that Mac.

Each machine keeps the new track even if its switch did not finish, but it
moves to that track only through a switch. **Update track** shows how many
machines still run the other track. **Review** opens the same dialog with fresh
checks.

## Before you update

Server updates restart the connection and can interrupt active agents and
terminal commands. Saved threads, settings, and project files remain.

**Settings → Maintenance → Continue threads after restarts** is on by default.
It resumes supported active threads after an update, crash, or machine
restart. Changes are saved to connected environments that support this setting;
update older servers first. If a supported environment was offline or has a
different value, use **Apply to all** in Settings after it connects.
T3 Code must start again on that machine;
the setting does not enable automatic startup. Terminal commands may still be
interrupted, and threads without saved provider resume state need a new message.
A thread that finished its turn to wait on a subagent, a background task, or a
command or monitor the agent said it was waiting on is woken and told that this work
stopped. Other background shells and monitors, such as a dev server and its
watchdog, do not wake it; the thread learns about them with your next message.
A thread is not resumed while it waits for your approval, answer, or secret, or
while it is archived, snoozed, or settled. After three automatic resumes in a row,
the thread waits for your next message.

Updates from the previous orchestration system preserve conversation transcripts but cannot carry
every kind of runtime history forward. Read [Threads from older T3 Code versions](./thread-migration.md)
before continuing an important older thread.

## When versions don't match

A client and server must speak the same orchestration protocol. If they do not, the connection is
refused rather than running half-upgraded:

- An app newer than the server is blocked before connecting, with a notice telling you to update
  T3 Code on the machine named in the notice.
- A server newer than your app refuses the connection with an update message.

Update the side the notice names, then reconnect.

## Update a connected server

The offered action depends on how the server runs:

| Action                     | What to do                                                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Update server**          | Keep the client open while it installs and reconnects. Supported background services update remotely. For a desktop-hosted server, this also closes and relaunches the desktop app on the host. |
| **Update the desktop app** | Update the desktop app on the machine running the server, then reopen it if needed.                                                                                                             |
| **Copy update command**    | Run the command on the named host to update the detected global npm install, then restart the server with your usual options.                                                                   |
| **Copy relaunch command**  | Stop the command-line server on its host and relaunch with the copied command, keeping your usual subcommand and options. This does not update an installed `t3` command.                       |

On the host, run:

```sh
t3 update <client-version>
```

Replace `<client-version>` with the version shown in the notice. The command
asks before restarting the background service; if you decline, run
`t3 service restart` when you are ready. For a server you started by hand,
stop it and start it again afterwards with your usual options such as `--host`
or `--tailscale-serve`.

If you run the server with `npx` rather than an installed `t3`, there is
nothing to update on the host: stop the server and relaunch it as
`npx t3@<client-version>` with the same subcommand and options.

## Update a server running from a git checkout

When you run T3 Code from a cloned repository with `vp run dev`, the checkout
supervisor watches the branch for new commits. When the remote branch moves
ahead, the sidebar shows an **Update and restart** notification. Clicking it
pulls the new commits, installs dependencies if a lockfile changed, rebuilds,
and restarts the server. The browser reloads automatically once the server is
back.

This is the recommended way to run from source on any platform where you want
automatic updates from your own repository. It works on macOS, Linux, and
Windows.

### Choosing between the desktop app and `vp run dev`

|                   | Desktop app                                                  | `vp run dev` + browser                                 |
| ----------------- | ------------------------------------------------------------ | ------------------------------------------------------ |
| **Auto-update**   | Released builds only (from GitHub Releases)                  | Any commit on your branch, including your own merges   |
| **Update flow**   | Downloads new binary, installs, restarts                     | Git pull, install, rebuild, restart, shown in the UI   |
| **Remote access** | Server embedded in app; killing the app kills the connection | Server runs independently; browser tabs are disposable |
| **Native chrome** | Full OS window, system tray, notifications                   | Browser tab                                            |
| **Best for**      | End users on a released build                                | Developers running from source, especially remote      |

If you access T3 Code remotely (from a phone, tablet, or another machine), `vp run dev` is more
resilient: the server process survives browser disconnects and does not depend on an Electron
window staying alive. Start it with `--share` for Tailscale access.

The desktop app bundles its own server, so its auto-updater only applies to released builds
downloaded from GitHub Releases or a package manager. Running the desktop app from a source
checkout does not give it the checkout supervisor, so it will not detect or offer code updates.

### Start `vp run dev` on boot (Windows)

Create a shortcut in your Startup folder (`shell:startup`) that runs:

```
pwsh -WindowStyle Minimized -Command "Set-Location C:\path\to\t3code; npx vp run dev"
```

Or register it as a scheduled task that starts at logon. The dev server prints
its URL on startup; connect to it from any browser.

## If an update fails

Keep the client open until it reconnects or reports a failure. A failed service
update can roll back to the previous version. If the update still fails:

1. Retry the offered action once.
2. Check that you updated the server's machine, not only the device you are using.
3. For a command-line server, stop it and relaunch the exact version shown in the notice.

Only one server can use a T3 home directory at a time. If startup reports that
another server owns it, stop that server before retrying, or use a separate home
directory and pair with the running server.

## If the desktop app does not start

If the desktop app's server keeps failing at startup, T3 Code shows a "T3 Code
could not start" window instead of the app. If a newer version is available,
choose **Update** to install it. If not, the window links to the last version
that started on your computer. Download and install it to go back. Use **Copy
details** to include the error in a bug report.

## Update providers

**Settings → Providers** shows provider updates for the selected environment.
**Update all** updates every outdated provider on every connected environment
at once. Hover it to see which providers it will update. Providers that only
offer a manual update command are not included.

After a successful provider CLI update, T3 Code refreshes model discovery for
every enabled instance of that provider using its own configuration. Connected
clients receive the refreshed catalogs automatically. Provider update checks
must be enabled to download the latest T3 Code model catalog.

Provider updates do not restart running chats. An existing session can keep
using the previous CLI until it ends. If discovery fails, check the provider
status and refresh it again.

## Mobile updates

To update an environment from your phone, open **Settings → Environments** and
select it. **Check for updates** finds the latest release on that environment's
current release channel. Keep the app open while the environment updates and
reconnects. Hosts that cannot update remotely show instructions for updating on
the machine instead.

The same page lets you refresh provider status and update supported providers.
These controls require a connected environment and permission to operate it.
Provider update checks and restart continuation preferences are in
**Settings → Maintenance**. If provider update checks are disabled, enable them
there before refreshing to find newer versions. The same setting controls whether
T3 Code downloads model catalog updates, so with it off new models may not appear
until you enable it and refresh provider status.

Install App Store or Google Play releases as usual. The mobile app can also
download updates in the background and apply them when you next leave the app.
It saves drafts and queued messages before restarting. If you keep the app open
for a long time, it may ask to install immediately; choosing **Later** leaves the
update queued for the next suitable moment.

## Track merged commits through deployment

When Delivery is enabled, open **Deployments** in the sidebar to compare each
repository's latest merged revision with the revision running in each release
environment. A matching revision is not a health check; a failed live check is
shown first. Choose **Add deployment**, then pick a repository, branch and
release environment from the lists. A T3 project or folder the engine does not
know yet is added to the engine when you choose it. Use **Discover commits** to
create release candidates. Their revisions stay pinned while they are
qualified, deployed and verified.

Start with **Manual** mode to approve each step. **Auto-qualify** checks new
candidates and waits before deployment. **Full auto** also deploys and verifies;
changing to it requires explicit consent. Dependencies can require another
release to be live first. Every deployment change asks for the engine's approval
passphrase, even while an approval window is open. While one release for an
environment is running, the others there can only be cancelled.

New deployments use **Repository commands**: a JSON object of argument arrays,
`qualify`, `deploy` and `verify`, with optional `setup`. Each array begins with
the executable followed by its arguments. Keep secrets out of this
configuration. Leaving commands blank keeps the saved ones. The built-in engine
adapter is offered only for the engine's own checkout in production, when the
engine has it configured. A missing command configuration or a failed check
appears on the deployment rather than being reported as a successful release.

## Fork baseline: nightly integration for delivery work

The `integrate/nightly-20261028-deployment-board` branch combines the fork's deployment
board at `7a9abca8df` with upstream tag `v0.1.4-nightly.20261028.3814`, commit
`ce66aab13fabde01b82deac4b4b3eaae53641988`. This is a fork built from that nightly's source,
not a switch to the stock nightly update channel. The running checkout follows the fork's
configured remote and branch. Integrating an upstream tag does not install it or restart T3.

Delivery tasks that reuse native T3 code should use this integrated baseline once it is merged.
In particular:

- Web and mobile provider clients now share `packages/client-runtime/src/providerClients.ts`.
  Kimi, Hermes and DeepSeek belong there alongside the upstream providers. Web's
  `providerDriverMeta.ts` reexports that registry; do not build another provider list there.
- Existing mobile thread settings read their thread and draft state in
  `ThreadSettingsSheet.tsx`. Delivery binding and model-lock checks follow that route. The
  composer no longer passes an ephemeral settings-session object through navigation.
- Sidebar project grouping uses the upstream sidebar. Keep the Board, Deployments and
  profile navigation entries when reusing its layout.
- Core WebSocket handlers are split by method prefix. Delivery handlers remain in the
  fork RPC group, with the same server authorization middleware. Keep both groups when
  adding native interactions.
- The active PM profile uses `~/Projects/t3code-board/.t3/userdata/statev2.sqlite`.
  `~/.t3/userdata` is a different home. Read the configured profile and running server's
  descriptor before inspecting data. Code worktrees and installed releases do not determine
  which database is active.

The nightly adds migrations 068 through 072, including message search and peer links.
Migration 067 is already upstream and must not be renumbered. Preserve the old database and
provider resume artifacts: successful V2 transcript import is not permission to delete them.
Validate upgrades on a consistent SQLite backup without starting agent recovery on the copy.
Keep a pre-upgrade backup for rollback rather than assuming an older executable can undo newer
migrations. Attachments and provider-owned resume files retain their own formats.

### Context for queued and completed native-reuse work

The first verified integration is `b092ce8a949c2cb27b93eb15a8d8c7c6cd867a9a`.
On 2026-10-28, the engine's repository notes for `t3-code-fork` and `delivery-engine`
were updated through the existing repository-notes API. Those notes are included in each
new seat attempt. This reaches queued tasks and later attempts on existing runs without
rewriting task history, changing acceptance criteria or moving pinned candidates.

Audit #1197 is historical evidence, not a current file map. Its native-reuse follow-ups
include Markdown and previews (#1269), provider/model pickers (#1270), Combobox controls
(#1271), composer drafts (#1273), toasts (#1274), and Settings (#1275). Recheck their
component paths and findings against the integration before accepting an older candidate.
The same applies to native update notifications (#1337, #1611), delegation identities
(#1347), and sync verification (#1827). Completed upstream-sync work (#1242, #1596)
remains part of the fork; this local integration does not change its configured schedule,
remote branch or publication permissions.

The separate completed responsive-web orchestrator/team-chat changes were integrated as
T3 commit `81eac5bee6d08b2d42cbe9e5e649b12b11b11094` and engine commit
`694480474331ded8921d9b924d3c9e7c386441c2`. The integrated checks passed 121 web tests,
web typecheck and production build, 30 engine flow tests, and 21 upstream-sync helper tests.
React Native and live blocked-draft recovery were not verified. The UI port retains existing
lint findings rather than bundling unrelated cleanup. Keep those original uncommitted edits until their owner
reconciles them with the integrated commits. A task marked completed, code committed,
a release published and a version running are separate facts; report each independently.
