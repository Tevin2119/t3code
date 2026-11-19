import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { boardDeliveryRequest } from "../../lib/boardDelivery";
import {
  deliveryEnvironment,
  useBoardStore,
  useDeliveryAct,
  usePersonName,
} from "../../state/delivery";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

export function BoardDeliveryApproval(props: {
  environmentId: EnvironmentId;
  title: string;
  description: string;
  path: string;
  body: Record<string, unknown>;
  confirmation?: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const allowed = useAtomValue(deliveryEnvironment.act.permissionAtom(props.environmentId));
  const act = useDeliveryAct(props.environmentId, props.title);
  const person = usePersonName();
  const setPerson = useBoardStore((state) => state.setPerson);
  const [by, setBy] = useState(person);
  const [key, setKey] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const inFlight = useRef(false);
  const submit = async () => {
    if (inFlight.current || !allowed) return;
    inFlight.current = true;
    setBusy(true);
    setProblem(null);
    const result = await Promise.resolve()
      .then(() =>
        act(
          props.path,
          boardDeliveryRequest(props.path, {
            ...props.body,
            by: by.trim(),
            key,
            ...(props.confirmation ? { confirmed } : {}),
          }),
        ),
      )
      .catch(() => ({
        ok: false as const,
        why: "The request could not be confirmed. Refresh and inspect the saved state before retrying.",
      }));
    setKey("");
    setBusy(false);
    inFlight.current = false;
    if (!result.ok) setProblem(result.why);
    else {
      setPerson(by.trim());
      props.onDone();
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && props.onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>{props.description}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id="board-delivery-approval"
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <p className="text-xs text-muted-foreground">
              Supply the engine approval key directly. An approval window is not enough. T3 does not
              save the key.
            </p>
            <Input
              aria-label="Your name"
              placeholder="Your name"
              autoComplete="name"
              value={by}
              disabled={busy}
              onChange={(event) => setBy(event.target.value)}
            />
            <Input
              aria-label="Approval key"
              placeholder="Approval key"
              type="password"
              autoComplete="off"
              value={key}
              disabled={busy}
              onChange={(event) => setKey(event.target.value)}
            />
            {props.confirmation ? (
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={confirmed}
                  disabled={busy}
                  onCheckedChange={(value) => setConfirmed(value === true)}
                />
                {props.confirmation}
              </label>
            ) : null}
            {problem ? (
              <p role="alert" className="text-sm text-warning">
                {problem}
              </p>
            ) : null}
            {!allowed ? (
              <p className="text-sm text-warning">
                This connection cannot change delivery settings.
              </p>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="board-delivery-approval"
            disabled={
              busy || !allowed || !by.trim() || !key.trim() || (!!props.confirmation && !confirmed)
            }
          >
            {busy ? "Saving…" : props.title}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
