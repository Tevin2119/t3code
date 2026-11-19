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
  useBoardStore,
} from "../../state/delivery";
import { useEnvironment } from "../../state/environments";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { type DeliveryApprovalSubmission, DeliveryApprovalDialog } from "./DeliveryApprovalDialog";

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
  // The same browser-wide name the Board writes on moves and approvals, editable here because the
  // engine dialog is where a person first meets a control that needs it.
  const personRaw = useBoardStore((state) => state.person);
  const setPerson = useBoardStore((state) => state.setPerson);
  const now = useMinuteClock();
  const act = useDeliveryAct(environmentId, "approval controls");
  // Each turn-on attempt mounts a fresh dialog, so it starts again at the warning.
  const [attempt, setAttempt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const inFlight = useRef(false);
  const summary = parseDeliveryEngineHealth(health.body, person);
  // Ending the window and turning auto off send no key, so they stay outside the dialog.
  const send = async (path: string) => {
    if (inFlight.current || !person.trim()) return;
    inFlight.current = true;
    setBusy(true);
    setProblem(null);
    // The engine request settles into a result, so cleanup can follow the await.
    const result = await act(path, { by: person });
    if (!result.ok) setProblem(result.why);
    inFlight.current = false;
    setBusy(false);
    health.refresh();
  };
  const turnOn = async ({ by, key }: DeliveryApprovalSubmission) => {
    setBusy(true);
    const result = await act("/api/engine/auto", { by, key, confirmed: true });
    setBusy(false);
    health.refresh();
    return result;
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
                setAttempt((count) => (count ?? 0) + 1);
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
      {!person.trim() ? (
        <label className="flex items-center gap-2" data-approval-person>
          <span className="shrink-0">Your name</span>
          <Input
            aria-label="Your name"
            placeholder="Written on what you decide here"
            size="compact"
            value={personRaw}
            onChange={(event) => setPerson(event.target.value)}
          />
        </label>
      ) : null}
      {problem ? <p role="alert">{problem}</p> : null}
      {attempt !== null ? (
        <DeliveryApprovalDialog
          key={attempt}
          title="Turn on Full auto"
          warning={
            <p data-full-auto-warning>
              Danger: the engine signs off by itself, in effect bypassing approvals. Most tasks go
              straight to pull requests. Full auto stays on until you turn it off. It never merges,
              closes or moves work.
            </p>
          }
          person={person}
          keyLabel="Full auto passphrase"
          keyPlaceholder="Approval passphrase"
          submitLabel="Turn on Full auto"
          continueProps={{ "data-full-auto-continue": true }}
          submitProps={{ "data-full-auto-on": true }}
          onSubmit={turnOn}
          onDone={() => setAttempt(null)}
          onClose={() => setAttempt(null)}
        />
      ) : null}
    </div>
  );
}
