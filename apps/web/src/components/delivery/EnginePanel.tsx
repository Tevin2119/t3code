import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { useMemo, useRef, useState } from "react";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { controlDeliveryEngine } from "../../lib/deliveryEngineControl";
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

export function EnginePanel({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Engine
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
          <DialogTitle>This environment's engine</DialogTitle>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3 text-sm">
          <p className={reachable ? "text-muted-foreground" : "text-warning"}>
            {health.isPending
              ? "Checking engine health..."
              : reachable
                ? "Engine answers in this environment."
                : `Engine not reachable. ${health.error ?? "No health reading yet."}`}
          </p>
          {reachable ? (
            <pre className="max-h-40 overflow-auto rounded border p-2 text-xs">
              {JSON.stringify(health.body, null, 2)}
            </pre>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Stop drains running work and keeps it for the next start. Restart starts nothing unless
            this engine confirms it stopped. A lost reply needs inspection, not an automatic retry.
            Your approval passphrase survives restarts; without one, the new terminal shows a new
            key.
          </p>
          <Input
            type="password"
            name="delivery-engine-approval"
            autoComplete="current-password"
            aria-label="Approval passphrase or terminal key"
            placeholder="Approval passphrase or terminal key"
            value={approval}
            onChange={(event) => setApproval(event.target.value)}
            disabled={busy}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={busy || health.isPending || reachable || !command || !configuration}
              onClick={() => void control("start")}
            >
              Start engine
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !reachable || !approval}
              onClick={() => void control("stop")}
            >
              Stop engine
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !reachable || !approval || !command || !configuration}
              onClick={() => void control("restart")}
            >
              Restart engine
            </Button>
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
