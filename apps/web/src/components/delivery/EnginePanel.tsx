import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { useMemo, useRef, useState } from "react";
import { PowerIcon } from "lucide-react";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { controlDeliveryEngine, parseDeliveryEngineHealth } from "../../lib/deliveryEngineControl";
import { useEnvironment } from "../../state/environments";
import { useDeliveryAct, useDeliveryRead } from "../../state/delivery";
import { primaryServerKeybindingsAtom, serverEnvironment } from "../../state/server";
import { terminalEnvironment } from "../../state/terminal";
import { useAtomCommand } from "../../state/use-atom-command";
import { TerminalViewport } from "../ThreadTerminalDrawer";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";

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
  return (
    <>
      <Button
        size={compact ? "icon-sm" : "sm"}
        variant="ghost"
        aria-label="PaperClip engine controls"
        title="PaperClip engine"
        onClick={() => setOpen(true)}
      >
        <PowerIcon className="size-3.5" />
        <span className={compact ? "sr-only" : undefined}>Engine</span>
      </Button>
      {open ? <EngineControl environmentId={environmentId} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function EngineControl(props: {
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
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

  const control = async (action: "start" | "stop" | "restart") => {
    if (inFlight.current) return;
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
                <dt className="text-muted-foreground">Code version</dt>
                <dd>{summary.commit?.slice(0, 10) ?? "Not reported"}</dd>
              </dl>
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
                disabled={busy || health.isPending || reachable || !command || !configuration}
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
                  disabled={busy || stopping || !approval}
                  onClick={() => void control("stop")}
                >
                  Stop engine
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || stopping || !approval || !command || !configuration}
                  onClick={() => void control("restart")}
                >
                  Restart engine
                </Button>
              </>
            ) : null}
          </div>
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
