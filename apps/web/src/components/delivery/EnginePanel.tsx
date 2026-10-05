import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { ThreadId, type EnvironmentId, type DeliveryReleaseChannel } from "@t3tools/contracts";
import { useMemo, useRef, useState } from "react";
import { PowerIcon } from "lucide-react";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import {
  controlDeliveryEngine,
  deliveryUpdatePending,
  parseDeliveryEngineHealth,
  requireDeliveryUpdateReceipt,
} from "../../lib/deliveryEngineControl";
import { useEnvironment } from "../../state/environments";
import { useDeliveryAct, useDeliveryRead } from "../../state/delivery";
import { primaryServerKeybindingsAtom, serverEnvironment } from "../../state/server";
import { terminalEnvironment } from "../../state/terminal";
import { useAtomCommand } from "../../state/use-atom-command";
import { TerminalViewport } from "../ThreadTerminalDrawer";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

const ENGINE_THREAD = ThreadId.make("delivery-engine");
const ENGINE_TERMINAL = "engine";

export function EngineDownNotice(props: {
  readonly environmentId: EnvironmentId | null;
  readonly message: string;
  readonly className?: string;
}) {
  return (
    <div className={props.className} data-delivery-engine-down>
      <p className="text-warning">{props.message}</p>
      {props.environmentId ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Open Engine beside the environment picker to inspect or start it.
        </p>
      ) : null}
    </div>
  );
}

export function EnginePanel({
  environmentId,
  compact = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [updateId, setUpdateId] = useState<string | null>(null);
  const health = useDeliveryRead(environmentId, "/api/health", { pollMs: 30_000 });
  const versions = !health.error ? parseDeliveryEngineHealth(health.body).versions : null;
  const updateNotice =
    deliveryUpdatePending(updateId, versions) ||
    versions?.problem ||
    versions?.update?.phase === "failed" ||
    versions?.restartRequired ||
    (versions?.updateAvailable && !versions.deferred);
  return (
    <>
      <Button
        size={compact ? "icon-sm" : "sm"}
        variant="ghost"
        aria-label="PaperClip engine controls"
        title={
          updateNotice
            ? "PaperClip engine: update, restart or inspection needed"
            : "PaperClip engine"
        }
        onClick={() => setOpen(true)}
      >
        <PowerIcon className="size-3.5" />
        {updateNotice ? (
          <span className="size-1.5 rounded-full bg-warning" aria-label="Engine needs attention" />
        ) : null}
        <span className={compact ? "sr-only" : undefined}>Engine</span>
      </Button>
      {open ? (
        <EngineControl
          environmentId={environmentId}
          onClose={() => setOpen(false)}
          updateId={updateId}
          onUpdateAccepted={setUpdateId}
        />
      ) : null}
    </>
  );
}

function EngineControl(props: {
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
  readonly updateId: string | null;
  readonly onUpdateAccepted: (id: string) => void;
}) {
  const { environmentId } = props;
  const environment = useEnvironment(environmentId);
  const command = useEnvironmentSettings(
    environmentId,
    (settings) => settings.delivery.engineCommand,
  );
  const health = useDeliveryRead(environmentId, "/api/health", { pollMs: 5000 });
  const act = useDeliveryAct(environmentId, "engine control");
  const configuration = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const terminalOpen = useAtomCommand(terminalEnvironment.open, { reportFailure: false });
  const terminalWrite = useAtomCommand(terminalEnvironment.write, { reportFailure: false });
  const threadRef = useMemo(() => scopeThreadRef(environmentId, ENGINE_THREAD), [environmentId]);
  const [approval, setApproval] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [terminal, setTerminal] = useState(false);
  const reachable = !health.error && health.body !== null;
  const summary = parseDeliveryEngineHealth(health.body);
  const stopping = reachable && summary.stopping;
  const versions = summary.versions;
  const awaitingUpdate = deliveryUpdatePending(props.updateId, versions);

  const releaseAction = async (
    action: "update" | "later" | "channel",
    channel?: DeliveryReleaseChannel,
  ) => {
    if (inFlight.current || awaitingUpdate || !versions) return;
    inFlight.current = true;
    setBusy(true);
    setProblem(null);
    setNotice(null);
    try {
      const result = await act(
        action === "channel"
          ? "/api/engine/channel"
          : action === "later"
            ? "/api/engine/update/later"
            : "/api/engine/update",
        { key: approval, commit: versions.available?.commit, channel },
      );
      if (!result.ok) throw new Error(result.why);
      if (action === "update") {
        const receipt = requireDeliveryUpdateReceipt(result.body);
        props.onUpdateAccepted(receipt.id);
        setNotice(
          `Update ${receipt.id} accepted for ${receipt.channel} ${receipt.commit.slice(0, 10)}. The supervisor drains work, snapshots state, then verifies the replacement. Acceptance is not completion.`,
        );
      } else
        setNotice(
          action === "later"
            ? "Update deferred. This engine keeps working. You can still update here later."
            : "Release channel saved. No work was stopped and nothing was installed.",
        );
      health.refresh();
    } catch (error) {
      setProblem(
        error instanceof Error
          ? error.message
          : "Update request failed. Inspect the engine terminal; do not retry automatically.",
      );
    } finally {
      setApproval("");
      setBusy(false);
      inFlight.current = false;
    }
  };

  const control = async (action: "start" | "stop" | "restart") => {
    if (inFlight.current || awaitingUpdate) return;
    inFlight.current = true;
    setBusy(true);
    setProblem(null);
    setNotice(null);
    try {
      await controlDeliveryEngine(action, {
        stop: async () => {
          const result = await act("/api/engine/stop", { key: approval });
          if (!result.ok) throw new Error(result.why);
          return result.body;
        },
        start: async () => {
          if (!command || !configuration)
            throw new Error(
              "Set delivery.engineCommand in this environment's server settings before starting it.",
            );
          const opened = await terminalOpen({
            environmentId,
            input: { threadId: ENGINE_THREAD, terminalId: ENGINE_TERMINAL, cwd: configuration.cwd },
          });
          if (opened._tag === "Failure") throw new Error(String(squashAtomCommandFailure(opened)));
          setTerminal(true);
          const written = await terminalWrite({
            environmentId,
            input: { threadId: ENGINE_THREAD, terminalId: ENGINE_TERMINAL, data: `${command}\r` },
          });
          if (written._tag === "Failure")
            throw new Error(
              "The start command was not confirmed. Check the engine terminal before trying again.",
            );
        },
      });
      setNotice(
        action === "stop"
          ? "Engine stopped. Its work is kept for the next start."
          : "Start command sent. Check the terminal and engine health; a command sent is not proof that it started.",
      );
      health.refresh();
    } catch (error) {
      setProblem(
        error instanceof Error
          ? error.message
          : "Engine control failed. Check its terminal before trying again.",
      );
    } finally {
      setApproval("");
      setBusy(false);
      inFlight.current = false;
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) props.onClose();
      }}
    >
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>PaperClip engine</DialogTitle>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3 text-sm">
          <p className={reachable ? "text-muted-foreground" : "text-warning"}>
            {health.isPending
              ? "Checking engine health..."
              : reachable
                ? `${stopping ? "Stopping" : "Running"} on ${environment?.label ?? "the selected environment"}.`
                : `PaperClip is not reachable on ${environment?.label ?? "the selected environment"}. ${health.error ?? "No health reading yet."}`}
          </p>
          {reachable ? (
            <>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                <dt className="text-muted-foreground">Account profile</dt>
                <dd>{summary.profile ?? "Not reported"}</dd>
                <dt className="text-muted-foreground">Process</dt>
                <dd>{summary.pid ?? "Not reported"}</dd>
                <dt className="text-muted-foreground">Installed checkout</dt>
                <dd>{summary.commit?.slice(0, 10) ?? "Not reported"}</dd>
                {versions ? (
                  <>
                    <dt className="text-muted-foreground">Release channel</dt>
                    <dd>{versions.channel}</dd>
                    <dt className="text-muted-foreground">Installation</dt>
                    <dd>
                      {versions.pinned
                        ? "Pinned channel release"
                        : "Workspace checkout, not a pinned release"}
                    </dd>
                    <dt className="text-muted-foreground">Running version</dt>
                    <dd>
                      {versions.running?.commit?.slice(0, 10) ?? "Unknown"}
                      {versions.running?.changed ? " (modified)" : ""}
                    </dd>
                    <dt className="text-muted-foreground">Available version</dt>
                    <dd>
                      {versions.available?.commit.slice(0, 10) ??
                        "No published candidate for this channel"}
                    </dd>
                  </>
                ) : null}
              </dl>
              {versions?.restartRequired ? (
                <p role="status" className="text-warning">
                  The checkout changed after this engine started. Restart when convenient; running
                  code is still the previous version.
                </p>
              ) : null}
              {versions?.installed?.changed ? (
                <p className="text-warning">
                  The installed checkout has uncommitted changes. Channel updates use a separate
                  clean candidate; they do not overwrite these edits.
                </p>
              ) : null}
              {versions?.problem ? (
                <p role="alert" className="text-warning">
                  {versions.problem}
                </p>
              ) : null}
              {versions?.update ? (
                <p
                  role="status"
                  className={
                    versions.update.phase === "failed" ? "text-warning" : "text-muted-foreground"
                  }
                >
                  Last update: {versions.update.phase}.{" "}
                  {versions.update.problem ??
                    (versions.update.phase === "complete"
                      ? "The replacement confirmed its process, profile, home and pinned version."
                      : "Inspect the engine terminal if progress stops.")}
                </p>
              ) : null}
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground">
                  Technical details
                </summary>
                <pre className="mt-2 max-h-40 overflow-auto rounded border p-2 text-xs">
                  {JSON.stringify(health.body, null, 2)}
                </pre>
              </details>
            </>
          ) : null}
          <p className="text-xs text-muted-foreground">
            This controls the task engine, not T3. Stop safely ends PaperClip and keeps its task
            records. Restart starts it again only after a confirmed stop. A lost reply requires
            checking its terminal before trying again.
          </p>
          {reachable ? (
            <>
              <p className="text-xs text-muted-foreground">
                {summary.approval === "passphrase"
                  ? "Use the approval passphrase you set for this PaperClip engine. It survives restarts."
                  : "Use the approval key printed in this engine's terminal."}{" "}
                This is not a T3 pairing code.
              </p>
              <Input
                type="password"
                name="delivery-engine-approval"
                autoComplete="current-password"
                aria-label={
                  summary.approval === "passphrase"
                    ? "PaperClip approval passphrase"
                    : "Engine terminal approval key"
                }
                placeholder={
                  summary.approval === "passphrase"
                    ? "Your PaperClip approval passphrase"
                    : "Engine terminal approval key"
                }
                value={approval}
                onChange={(event) => setApproval(event.target.value)}
                disabled={busy || stopping}
              />
            </>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {!reachable ? (
              <Button
                size="sm"
                disabled={
                  busy ||
                  awaitingUpdate ||
                  health.isPending ||
                  reachable ||
                  !command ||
                  !configuration
                }
                onClick={() => void control("start")}
              >
                Start engine
              </Button>
            ) : null}
            {reachable ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || awaitingUpdate || stopping || !approval}
                  onClick={() => void control("stop")}
                >
                  Stop engine
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    busy || awaitingUpdate || stopping || !approval || !command || !configuration
                  }
                  onClick={() => void control("restart")}
                >
                  Restart engine
                </Button>
              </>
            ) : null}
          </div>
          {awaitingUpdate ? (
            <p role="status" className="text-warning">
              Update accepted. A temporary disconnect is expected. Wait for the matching completion
              receipt; inspect the original engine terminal if it does not return. No second engine
              is started here.
            </p>
          ) : null}
          {reachable && versions ? (
            <div className="space-y-2 rounded border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">Release channel</span>
                <Select
                  value={versions.channel}
                  onValueChange={(value: DeliveryReleaseChannel | null) => {
                    if (value) void releaseAction("channel", value);
                  }}
                  disabled={busy || awaitingUpdate || stopping || !approval}
                >
                  <SelectTrigger size="sm" aria-label="Engine release channel">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {(["dev", "qa", "main"] as const).map((channel) => (
                      <SelectItem key={channel} value={channel}>
                        {channel === "dev"
                          ? "Dev: development candidate"
                          : channel === "qa"
                            ? "QA: checks passed"
                            : "Main: explicitly promoted"}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              <p className="text-xs text-muted-foreground">
                Channels select engine releases, not account profiles. Main accepts only candidates
                promoted through Dev and QA. No merge or channel selection restarts an engine.
              </p>
              {versions.updateAvailable ? (
                <>
                  <p role="status">
                    {versions.deferred ? "Update deferred" : "Update available"}:{" "}
                    {versions.available?.commit.slice(0, 10)}. Your engine home stays the same.{" "}
                    {summary.approval === "passphrase"
                      ? "Your approval passphrase is retained."
                      : "A new approval key is printed in the engine terminal after restart."}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      disabled={
                        busy || awaitingUpdate || stopping || !approval || !versions.managed
                      }
                      onClick={() => void releaseAction("update")}
                    >
                      Update now
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        busy || awaitingUpdate || stopping || !approval || versions.deferred
                      }
                      onClick={() => void releaseAction("later")}
                    >
                      Later, keep working
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Update now stops new work and safely interrupts active seats, preserving
                    resumable records. It snapshots the database and configuration after shutdown,
                    then starts the pinned release. It does not wait for every task to finish.
                  </p>
                </>
              ) : null}
              {!versions.managed ? (
                <p className="text-xs text-muted-foreground">
                  Start this engine with the named workspace launcher to enable snapshot-backed
                  updates.
                </p>
              ) : null}
            </div>
          ) : null}
          {!command ? (
            <p className="text-xs text-muted-foreground">
              Set <code>delivery.engineCommand</code> in this environment's server settings, for
              example <code>pm</code>. Keep passphrases out of that command.
            </p>
          ) : null}
          {notice ? <p role="status">{notice}</p> : null}
          {problem ? (
            <p role="alert" className="text-warning">
              {problem}
            </p>
          ) : null}
          {terminal && configuration ? (
            <div className="h-80 overflow-hidden rounded border">
              <TerminalViewport
                advancedTypography={false}
                threadRef={threadRef}
                threadId={ENGINE_THREAD}
                terminalId={ENGINE_TERMINAL}
                terminalLabel="Delivery engine"
                cwd={configuration.cwd}
                onSessionExited={() => setTerminal(false)}
                focusRequestId={0}
                autoFocus
                visible
                resizeEpoch={0}
                drawerHeight={320}
                keybindings={keybindings}
              />
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Closing this window does not stop the engine.
          </p>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
