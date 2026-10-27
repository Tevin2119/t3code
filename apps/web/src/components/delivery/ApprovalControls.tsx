import type { EnvironmentId } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { minutesLeft, parseDeliveryEngineHealth } from "../../lib/deliveryEngineControl";
import {
  useDeliveryAct,
  useDeliveryEnabled,
  useDeliveryEnvironmentId,
  useDeliveryRead,
  useMinuteClock,
  usePersonName,
} from "../../state/delivery";
import { useEnvironment } from "../../state/environments";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";

/** Sidebar reads only the connected environment whose board is selected. */
export function SidebarApprovalControls() {
  const environmentId = useDeliveryEnvironmentId();
  const enabled = useDeliveryEnabled(environmentId);
  const connected = useEnvironment(environmentId)?.connection.phase === "connected";
  const active = enabled && connected ? environmentId : null;
  const health = useDeliveryRead(active, active ? "/api/health" : null, { pollMs: 30_000 });
  return active ? <ApprovalControls environmentId={active} health={health} sidebar /> : null;
}

/** Shared by the sidebar and the engine dialog; health alone controls the switch. */
export function ApprovalControls({
  environmentId,
  health,
  sidebar = false,
}: {
  readonly sidebar?: boolean;
  readonly environmentId: EnvironmentId;
  readonly health: Pick<ReturnType<typeof useDeliveryRead>, "body" | "error" | "refresh">;
}) {
  if (health.error || health.body === null) return null;
  const summary = parseDeliveryEngineHealth(health.body);
  if (summary.approvalWindow === null && summary.fullAuto === null) return null;
  return (
    <SupportedApprovalControls environmentId={environmentId} health={health} sidebar={sidebar} />
  );
}

function SupportedApprovalControls({
  environmentId,
  health,
  sidebar = false,
}: {
  readonly sidebar?: boolean;
  readonly environmentId: EnvironmentId;
  readonly health: Pick<ReturnType<typeof useDeliveryRead>, "body" | "error" | "refresh">;
}) {
  const person = usePersonName();
  const now = useMinuteClock();
  const act = useDeliveryAct(environmentId, "approval controls");
  const [step, setStep] = useState<"warning" | "key" | null>(null);
  const [hasKey, setHasKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const inFlight = useRef(false);
  const keyInput = useRef<HTMLInputElement>(null);
  const summary = parseDeliveryEngineHealth(health.body, person);
  const clear = () => {
    if (keyInput.current) keyInput.current.value = "";
    setHasKey(false);
    setStep(null);
  };
  const send = async (path: string, key?: string) => {
    if (inFlight.current || !person.trim()) return;
    inFlight.current = true;
    setBusy(true);
    setProblem(null);
    // The input is cleared before awaiting. No passphrase is kept in React state.
    if (keyInput.current) keyInput.current.value = "";
    setHasKey(false);
    // The engine request settles into a result, so cleanup can follow the await.
    const result = await act(path, {
      by: person,
      ...(key === undefined ? {} : { key, confirmed: true }),
    });
    if (!result.ok) setProblem(result.why);
    clear();
    inFlight.current = false;
    setBusy(false);
    health.refresh();
  };
  if (health.error || health.body === null) return null;
  const window = summary.approvalWindow;
  const auto = summary.fullAuto;
  const ownWindow = window?.open && window.by === person && minutesLeft(window.until, now) > 0;
  const showAuto = auto !== null && !(sidebar && window?.open && window.by !== person && !auto.on);
  if (!ownWindow && !showAuto) return null;
  return (
    <div className="flex flex-col gap-2 text-xs">
      {ownWindow ? (
        <div
          data-delivery-approval-window
          className="flex flex-wrap items-center gap-2 rounded-lg bg-sidebar-control-surface px-2 py-1.5"
        >
          <span role="status">Approvals open · {minutesLeft(window.until, now)} minutes left</span>
          <Button
            size="xs"
            variant="outline"
            disabled={busy || !person.trim()}
            data-approval-end
            onClick={() => void send("/api/approval/window/end")}
          >
            End now
          </Button>
        </div>
      ) : null}
      {showAuto && auto ? (
        <div
          data-delivery-full-auto
          className={
            sidebar
              ? "flex items-center gap-2 rounded-lg bg-sidebar-control-surface px-2 py-1.5"
              : "flex flex-wrap items-center gap-2 rounded-lg bg-sidebar-control-surface px-2 py-1.5"
          }
        >
          <span role="status" className="shrink-0 whitespace-nowrap">
            Full auto {auto.on ? "on" : "off"}
          </span>
          <Switch
            size="sm"
            aria-label="Full auto"
            checked={auto.on}
            disabled={busy || !person.trim()}
            onCheckedChange={(checked) => {
              if (checked) {
                setProblem(null);
                setStep("warning");
              } else void send("/api/engine/auto/off");
            }}
          />
          {!sidebar && auto.on && (auto.by || auto.since) ? (
            <span className="min-w-0 wrap-break-word">
              {auto.by ? `Turned on by ${auto.by}` : null}
              {auto.by && auto.since ? ", " : null}
              {auto.since ? `since ${new Date(auto.since).toLocaleString()}` : null}
            </span>
          ) : null}
        </div>
      ) : null}
      {!person.trim() ? <p>Set your name on the board first.</p> : null}
      {problem ? <p role="alert">{problem}</p> : null}
      <Dialog
        open={step !== null}
        onOpenChange={(open) => {
          if (!open) clear();
        }}
      >
        {step !== null ? (
          <DialogPopup data-full-auto-dialog>
            <DialogHeader>
              <DialogTitle>Turn on Full auto</DialogTitle>
            </DialogHeader>
            <DialogPanel>
              {step === "warning" ? (
                <p data-full-auto-warning>
                  Danger: the engine signs off by itself, in effect bypassing approvals. Most tasks
                  go straight to pull requests. Full auto stays on until you turn it off. It never
                  merges, closes or moves work.
                </p>
              ) : (
                <Input
                  key="fresh-passphrase"
                  ref={keyInput}
                  type="password"
                  autoComplete="off"
                  aria-label="Full auto passphrase"
                  placeholder="Approval passphrase"
                  onChange={(event) => setHasKey(Boolean(event.target.value))}
                  autoFocus
                  disabled={busy || !person.trim()}
                />
              )}
            </DialogPanel>
            <DialogFooter>
              <Button variant="outline" onClick={clear}>
                Cancel
              </Button>
              {step === "warning" ? (
                <Button
                  variant="destructive"
                  data-full-auto-continue
                  onClick={() => setStep("key")}
                >
                  Continue
                </Button>
              ) : (
                <Button
                  variant="destructive"
                  disabled={busy || !person.trim() || !hasKey}
                  data-full-auto-on
                  onClick={() => {
                    const key = keyInput.current?.value;
                    if (key) void send("/api/engine/auto", key);
                  }}
                >
                  Turn on Full auto
                </Button>
              )}
            </DialogFooter>
          </DialogPopup>
        ) : null}
      </Dialog>
    </div>
  );
}
