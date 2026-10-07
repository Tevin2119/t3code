# Updating T3 Code

The app you use and the server running your agents can be on different machines.
When a server is behind your web or desktop app, an update notice appears in the
conversation and **Settings → Connections**. Update the machine named in that
notice.

## Before you update

Server updates restart the connection and can interrupt active agents and
terminal commands. Saved threads, settings, and project files remain.

**Settings → General → Continue threads after restarts** is off by default.
Enable it to resume supported active threads after an update, crash, or machine
restart. Changes are saved to connected environments that support this setting;
update older servers first. If a supported environment was offline or has a
different value, use **Apply to all** in Settings after it connects.
T3 Code must start again on that machine;
the setting does not enable automatic startup. Terminal commands may still be
interrupted, and threads without saved provider resume state need a new message.
If you previously enabled continuation for updates, enable this setting once
to allow recovery without a connected client.

## Update a connected server

The offered action depends on how the server runs:

| Action                     | What to do                                                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Update server**          | Keep the client open while it installs and reconnects. Supported background services update remotely. For a desktop-hosted server, this also closes and relaunches the desktop app on the host. |
| **Update the desktop app** | Update the desktop app on the machine running the server, then reopen it if needed.                                                                                                             |
| **Copy update command**    | Stop the command-line server on its host and relaunch with the copied command, keeping your usual startup options.                                                                              |

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

## If an update fails

Keep the client open until it reconnects or reports a failure. A failed service
update can roll back to the previous version. If the update still fails:

1. Retry the offered action once.
2. Check that you updated the server's machine, not only the device you are using.
3. For a command-line server, stop it and relaunch the exact version shown in the notice.

## PaperClip engine updates

PaperClip is a separate task engine. Updating T3 Code does not update or restart it.
Open **Engine** beside the board's environment picker for the selected machine and account profile.
Its version summary distinguishes the code running in the process, the installed checkout, and
the candidate available on its selected update channel. The Engine button shows a notice when
a new candidate or a restart is needed.

Engine channels are **Dev** for development candidates, **QA** for candidates whose engine checks
passed, and **Main** for explicitly promoted QA candidates. They are not account profiles.
Changing the channel only changes which update is offered. A merge alone does not publish a release;
the machine's maintainer must publish a candidate to its local catalogue first.

For engines started through the named workspace launcher, **Update now** uses that engine's
approval passphrase or terminal key. It stops new work, safely interrupts active seats, snapshots
the database and configuration after a confirmed stop, then starts and verifies the pinned release.
It preserves the account environment, data home and approval passphrase. It does not wait for every
task to finish. **Later, keep working** leaves the engine running and keeps the update available
in its controls.

A temporary engine disconnect during an update is expected. An accepted request is not proof of
completion: wait for the matching completion receipt and running version. If the engine does not
return, inspect its original terminal; do not automatically issue another start or update.
The snapshot is retained after failure. Database rollback is a separate recovery decision, not
an automatic update step. An engine started without the workspace launcher still supports its
existing stop/restart controls, but not managed updates.

## Mobile updates

Install App Store or Google Play releases as usual. The mobile app can also
download updates in the background and apply them when you next leave the app.
It saves drafts and queued messages before restarting. If you keep the app open
for a long time, it may ask to install immediately; choosing **Later** leaves the
update queued for the next suitable moment.
