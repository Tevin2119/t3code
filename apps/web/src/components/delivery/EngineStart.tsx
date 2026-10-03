import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { primaryServerKeybindingsAtom, serverEnvironment } from "../../state/server";
import { terminalEnvironment } from "../../state/terminal";
import { useAtomCommand } from "../../state/use-atom-command";
import { TerminalViewport } from "../ThreadTerminalDrawer";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";

/** The engine runs in a terminal of its own, so the approval key it prints stays in that terminal. */
const ENGINE_THREAD_ID = ThreadId.make("delivery-engine");
const ENGINE_TERMINAL_ID = "engine";
/** Time the shell gets to come up before the start command is typed into it. */
const SHELL_SETTLE_MS = 1500;

/** Environments whose start command was already typed, so reopening the dialog never types it twice. */
const typedFor = new Set<string>();

const useEngineStartStore = create<{
  readonly open: EnvironmentId | null;
  readonly show: (environmentId: EnvironmentId) => void;
  readonly hide: () => void;
}>((set) => ({
  open: null,
  show: (environmentId) => set({ open: environmentId }),
  hide: () => set({ open: null }),
}));

/**
 * What is shown where the engine did not answer. With a start command set for the environment it
 * offers to run it; without one it says where to set it.
 */
export function EngineDownNotice(props: {
  readonly environmentId: EnvironmentId | null;
  readonly message: string;
  readonly className?: string;
}) {
  const command = useEnvironmentSettings(
    (props.environmentId ?? "") as EnvironmentId,
    (settings) => settings.delivery?.engineCommand ?? "",
  );
  const show = useEngineStartStore((state) => state.show);
  return (
    <div className={props.className} data-delivery-engine-down>
      <p className="text-warning">{props.message}</p>
      {props.environmentId && command ? (
        <Button
          className="mt-2"
          size="xs"
          data-delivery-start-engine
          onClick={() => show(props.environmentId as EnvironmentId)}
        >
          Start engine
        </Button>
      ) : (
        <p className="mt-1 text-xs text-muted-foreground">
          Set <code>delivery.engineCommand</code> in the server settings, for example{" "}
          <code>pm</code>, to start it from here.
        </p>
      )}
    </div>
  );
}

/**
 * Terminal that runs the start command. It is mounted by the page, not by the notice, so it stays
 * open once the engine answers and the notice goes away: the approval key is printed here once.
 */
export function EngineStartDialog() {
  const environmentId = useEngineStartStore((state) => state.open);
  const hide = useEngineStartStore((state) => state.hide);
  if (!environmentId) return null;
  return <EngineTerminal environmentId={environmentId} onClose={hide} />;
}

function EngineTerminal(props: {
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
}) {
  const { environmentId } = props;
  const command = useEnvironmentSettings(
    environmentId,
    (settings) => settings.delivery?.engineCommand ?? "",
  );
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const runWrite = useAtomCommand(terminalEnvironment.write, { reportFailure: false });
  const threadRef = useMemo(() => scopeThreadRef(environmentId, ENGINE_THREAD_ID), [environmentId]);
  const [typed, setTyped] = useState(typedFor.has(environmentId));

  useEffect(() => {
    if (typedFor.has(environmentId) || !command) return;
    const timer = window.setTimeout(() => {
      typedFor.add(environmentId);
      setTyped(true);
      void runWrite({
        environmentId,
        input: { threadId: ENGINE_THREAD_ID, terminalId: ENGINE_TERMINAL_ID, data: `${command}\r` },
      });
    }, SHELL_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [command, environmentId, runWrite]);

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup className="max-w-3xl" data-delivery-engine-terminal>
        <DialogHeader>
          <DialogTitle>Delivery engine</DialogTitle>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-2 text-sm">
          <p className="text-xs text-muted-foreground">
            {typed ? `Ran \`${command}\`. ` : `Starting \`${command}\`… `}
            The approval key is printed below, once, and only here. Keep it for approving work;
            closing this window leaves the engine running.
          </p>
          <div className="h-80 overflow-hidden rounded-md border">
            {serverConfig ? (
              <TerminalViewport
                advancedTypography={false}
                threadRef={threadRef}
                threadId={ENGINE_THREAD_ID}
                terminalId={ENGINE_TERMINAL_ID}
                terminalLabel="Delivery engine"
                cwd={serverConfig.cwd}
                onSessionExited={() => typedFor.delete(environmentId)}
                focusRequestId={0}
                autoFocus
                visible
                resizeEpoch={0}
                drawerHeight={320}
                keybindings={keybindings}
              />
            ) : null}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
