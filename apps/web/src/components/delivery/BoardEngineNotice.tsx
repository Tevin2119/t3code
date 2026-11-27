import { Link } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";
import { useGT } from "gt-react";
import type { ComponentProps, ReactNode } from "react";
import { useState } from "react";
import { deliveryEnvironment, useDeliveryAct, usePersonName } from "../../state/delivery";
import { useEnvironmentQuery } from "../../state/query";
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
import { EngineDownNotice } from "./EnginePanel";

export function BoardEngineNotice(props: ComponentProps<typeof EngineDownNotice>) {
  return (
    <BoardNotice summary="Delivery engine not reachable. Tap for details.">
      <EngineDownNotice {...props} />
    </BoardNotice>
  );
}

/**
 * Says so when this server holds no board approval key: without it no task links to a thread and
 * no step runs here. Silent on a server too old to tell.
 */
export function BoardApprovalKeyNotice(props: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const status = useEnvironmentQuery(
    deliveryEnvironment.boardApprovalKey({ environmentId: props.environmentId, input: {} }),
  );
  if (status.data?.source !== "none") return null;
  return (
    <BoardNotice summary={gt("Board approval key not set: tasks can't run in T3.")}>
      <p
        role="status"
        className="flex flex-wrap items-baseline gap-x-2 px-4 pt-2 text-sm text-warning"
        data-board-approval-key-missing
      >
        <span>{gt("Board approval key not set: tasks can't run in T3.")}</span>
        <Button
          size="xs"
          variant="link"
          render={<Link to="/settings/threads" search={{ machine: props.environmentId }} />}
        >
          {gt("Set it in Settings")}
        </Button>
      </p>
    </BoardNotice>
  );
}

export function BoardNotice({
  summary,
  children,
}: {
  readonly summary: string;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="hidden md:contents">{children}</div>
      <div className="min-w-0 shrink-0 px-4 pt-2 md:hidden">
        <Button
          size="xs"
          variant="ghost"
          className="max-w-full"
          onClick={() => setOpen(true)}
          aria-label="Read engine notice"
        >
          <span className="truncate">{summary}</span>
        </Button>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Engine notice</DialogTitle>
          </DialogHeader>
          <DialogPanel>{children}</DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}

/**
 * Closes one engine notice, with the approval passphrase. The engine opens it again by itself if
 * the problem comes back, so closing only clears what has stopped happening.
 */
export function CloseNoticeButton({
  environmentId,
  notice,
  onClosed,
}: {
  readonly environmentId: EnvironmentId;
  readonly notice: { readonly key: string; readonly text: string };
  readonly onClosed: () => void;
}) {
  const act = useDeliveryAct(environmentId, "close engine notice");
  const person = usePersonName();
  const [open, setOpen] = useState(false);
  const [approval, setApproval] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const close = async () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const result = await act("/api/notices/close", {
      notice: notice.key,
      key: approval,
      why: person ? `closed by ${person}` : "closed by a person",
    });
    // The key is dropped after every use, whether it worked or not.
    setApproval("");
    setBusy(false);
    if (!result.ok) {
      setProblem(result.why);
      return;
    }
    setOpen(false);
    onClosed();
  };

  return (
    <>
      <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
        Close
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setApproval("");
            setProblem(null);
          }
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Close engine notice</DialogTitle>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <p className="text-sm">{notice.text}</p>
            <p className="text-xs text-muted-foreground">
              The engine shows it again if this happens again. Use this environment's approval
              passphrase, or its terminal key if no passphrase is set. T3 does not save it.
            </p>
            <Input
              type="password"
              name="delivery-notice-approval"
              autoComplete="current-password"
              aria-label="Approval passphrase or terminal key"
              placeholder="Approval passphrase or terminal key"
              value={approval}
              onChange={(event) => setApproval(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && approval) void close();
              }}
              disabled={busy}
            />
            {problem ? <p className="text-xs text-destructive">{problem}</p> : null}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={() => void close()} disabled={busy || !approval}>
              Close notice
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
