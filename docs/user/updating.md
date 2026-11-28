# Updating T3 Code

T3 Code clients and servers can run on different machines and must share a compatible orchestration protocol. When a server or provider is behind, the sidebar update button and **Settings → Environments** handle updates.

## Update everything at once

Click the **Update** button at the bottom of the sidebar (web or desktop) to update outdated providers, behind servers, and the desktop app in one step.

- Hover to preview what will update; click while running to view per-machine progress or retry failures.
- Confirmation dialogs show which machines are skipped (offline or manual-only) and how many active threads will pause/resume.
- Choose **Later** on the desktop restart countdown to restart when ready.

## Switch between Stable and Nightly

In the desktop app, change **Settings → About → Update track** to switch connected machines together.

- Moving a background service to an older Stable release requires running `t3 update --channel stable --allow-downgrade` on that host.
- A switch is blocked if the machine's database has schema changes the target track doesn't support yet. macOS desktop apps must switch on that Mac.

## Continue threads after restarts

**Settings → Maintenance → Continue threads after restarts** is enabled by default. After an update, crash, or reboot (once T3 Code starts again), supported active threads automatically resume—and threads waiting on subagents or monitors are woken and notified that background work stopped.

- Threads waiting for your approval/answer/secret—or archived, snoozed, or settled—are not auto-resumed.
- After 3 consecutive crash recoveries of an unfinished turn, the thread waits for your next message.
- Updating from V1? Read [Threads from older T3 Code versions](./thread-migration.md).

## Update a connected server manually

| Situation                           | Action                                                                                                |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Background service / desktop server | Click **Update server** in **Settings → Environments** (desktop hosts relaunch automatically).        |
| Installed `t3` CLI                  | Run `t3 update <version>` on the host (then `t3 service restart` if you declined the restart prompt). |
| `npx` server                        | Stop the server and relaunch with `npx t3@<version>` and your usual flags.                            |
| Package manager (Nix, AUR)          | Update via your package manager.                                                                      |

Each server checks npm/Homebrew/pnpm using its own local registry and proxy settings.

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

## Update providers

Open **Settings → Providers** and click **Update now** on individual providers or **Update all** across connected environments. Running chats keep using their current CLI until they end; new sessions and model catalogs refresh automatically. (Provider update checks in **Settings → Maintenance** must be enabled to fetch model catalog updates.)

## Mobile updates

- Update connected environments and providers from **Settings → Environments** on mobile.
- Update the mobile app via the App Store or Google Play (background over-the-air updates apply on next app switch and preserve drafts/queued messages).

## Troubleshooting

- **Version mismatch**: Update whichever side (app or server) the connection notice names.
- **Failed update**: Retry once; confirm you updated the host machine (not just the client) and that only one server owns the T3 home directory.
- **macOS Alpha → Beta**: Open `/Applications/T3 Code (Beta).app` manually and re-pin it to the Dock.
- **Desktop won't start**: Use the recovery window's **Update** button, install the linked last-working version, or **Copy details** for a bug report.

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

For a Firebase Hosting site, choose the **Firebase Hosting** adapter. After you
pick the repository and branch, T3 lists the hosting targets the engine read from
`.firebaserc` and `firebase.json` on that branch; choose one, and nothing else is
typed. The engine deploys only that target, with the Firebase sign-in already on
its host. A target the engine cannot deploy is listed with its reason. Live state
is the engine's own reading of the release stamp on the site. A site deployed
before this has no stamp, so choose **Adopt** on a qualified release once to say
what runs there now, either a known commit or "Unknown, accept once".

Other repositories use **Repository commands**: a JSON object of argument arrays,
`qualify`, `deploy` and `verify`, with optional `setup`. Each array begins with
the executable followed by its arguments. Keep secrets out of this
configuration. Leaving commands blank keeps the saved ones. The built-in engine
adapter is offered only for the engine's own checkout in production, when the
engine has it configured. A missing command configuration or a failed check
appears on the deployment rather than being reported as a successful release.

### Link a board and follow a task's deployment

On a custom repository-bound board, open **Board delivery settings → Link deployment**.
The settings also list the board repository's deployments with their releases and
actions, and **Add instance** starts one for that repository. Choose the exact
deployment project for the repository and release environment; its watched
branch must match the board target. Linking an existing project leaves its mode unchanged.
**Create a new project and link** defaults to auto-qualify, with deployment still manual.
If creation fails, inspect Deployments before retrying: the project may have been created
without the board link being saved. Link that existing project's ID rather than creating it again.

An invalid link explains what changed. Explicitly relink or unlink it; T3 never substitutes
another environment. Existing publications retain their original project, environment and run,
even after a board move, retarget or unlink. Open a task's **About → Deployment** for its
host-observed merge commit, candidate, evidence and history. An earlier run's publication is
history, not proof that the current run shipped. Queued, unknown, blocked and stale readings
are not live deployments.

### Automatic merge permission

Use **Engine → Global automatic merge permission**, **Board delivery settings**, or a saved
task's **About → Automatic merge permission** to set On, Off or Inherit. Drafts offer the same
control in their editor. The effective source is shown: exact task, nearest triage ancestor,
board, global, or the default Off. Built-in board summaries are read-only.

Every change requires a saved approval passphrase and your name; On also requires explicit
confirmation. Inherit removes only that override and can reveal inherited On permission.
Policy eligibility is not merge readiness: full-auto mode and the engine's independent merge
checks still apply. Merge permission never enables automatic deployment.

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
