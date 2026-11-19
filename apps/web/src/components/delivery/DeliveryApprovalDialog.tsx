import { type ReactNode, useId, useRef, useState } from "react";
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

export interface DeliveryApprovalSubmission {
  readonly by: string;
  readonly key: string;
  readonly confirmed: boolean;
}

export type DeliveryApprovalResult = { readonly ok: true } | { readonly ok: false; why: string };

const FAILED =
  "The request could not be confirmed. Refresh and inspect the saved state before retrying.";
const STALE = "The source snapshot became unavailable or stale. Cancel, refresh and review again.";

/**
 * The one dialog that takes the engine approval key. The key never lives in React state or props:
 * the input is uncontrolled, read once on submit and cleared before and after the await, and on
 * Cancel. A wrong key keeps the dialog open with an empty input.
 */
export function DeliveryApprovalDialog(props: {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  /** Shown above the fields, such as the request being signed. */
  readonly children?: ReactNode;
  /** When set, a first step shows this and a Continue button before the key is asked for. */
  readonly warning?: ReactNode;
  /** The name written on the decision. With `nameField` the dialog lets the person edit it. */
  readonly person: string;
  readonly nameField?: boolean;
  readonly keyLabel: string;
  readonly keyPlaceholder?: string;
  /** A consent the person ticks before the request can be sent. */
  readonly confirmation?: string;
  /** Whether this connection may act. Losing it while open invalidates the dialog. */
  readonly allowed?: boolean;
  readonly forbidden?: ReactNode;
  /** The data the request was reviewed against went away. Latches until the dialog is reopened. */
  readonly unavailable?: boolean;
  readonly submitLabel: string;
  readonly busyLabel?: string;
  /** Shown when `onSubmit` rejects instead of settling into a result. */
  readonly failure?: string;
  readonly continueProps?: Readonly<Record<`data-${string}`, boolean>>;
  readonly submitProps?: Readonly<Record<`data-${string}`, boolean>>;
  readonly onSubmit: (submission: DeliveryApprovalSubmission) => Promise<DeliveryApprovalResult>;
  readonly onDone: (by: string) => void;
  readonly onClose: () => void;
}) {
  const formId = useId();
  const allowed = props.allowed ?? true;
  const unavailable = props.unavailable ?? false;
  const [step, setStep] = useState<"warning" | "key">(props.warning ? "warning" : "key");
  const [ownName, setOwnName] = useState(props.person);
  const [hasKey, setHasKey] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [invalidated, setInvalidated] = useState(unavailable);
  if (unavailable && !invalidated) setInvalidated(true);
  const [hadPermission, setHadPermission] = useState(allowed);
  const [revoked, setRevoked] = useState(false);
  if (allowed && !hadPermission) setHadPermission(true);
  if (hadPermission && !allowed && !revoked) setRevoked(true);
  const inFlight = useRef(false);
  // The element, never its value. onChange also records it, for renderers without a DOM.
  const keyInput = useRef<HTMLInputElement | null>(null);
  const by = (props.nameField ? ownName : props.person).trim();
  const blocked =
    !allowed ||
    revoked ||
    unavailable ||
    invalidated ||
    !by ||
    (!!props.confirmation && !confirmed);
  const clearKey = () => {
    if (keyInput.current) keyInput.current.value = "";
    setHasKey(false);
  };
  const close = () => {
    if (inFlight.current) return;
    clearKey();
    props.onClose();
  };
  const submit = async () => {
    if (inFlight.current || blocked || step !== "key") return;
    const key = keyInput.current?.value ?? "";
    if (!key.trim()) return;
    inFlight.current = true;
    // Cleared before awaiting, so no rendered input holds the key while the request runs.
    clearKey();
    setBusy(true);
    setProblem(null);
    const result = await Promise.resolve()
      .then(() => props.onSubmit({ by, key, confirmed }))
      .catch((): DeliveryApprovalResult => ({ ok: false, why: props.failure ?? FAILED }));
    // And again after, in case anything was typed while the request ran.
    clearKey();
    inFlight.current = false;
    setBusy(false);
    if (!result.ok) setProblem(result.why);
    else props.onDone(by);
  };
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          {props.description ? <DialogDescription>{props.description}</DialogDescription> : null}
        </DialogHeader>
        <DialogPanel>
          {step === "warning" ? (
            props.warning
          ) : (
            <form
              id={formId}
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              {props.children}
              {props.nameField ? (
                <Input
                  aria-label="Your name"
                  placeholder="Your name"
                  autoComplete="name"
                  value={ownName}
                  disabled={busy}
                  onChange={(event) => setOwnName(event.target.value)}
                />
              ) : null}
              <Input
                ref={keyInput}
                type="password"
                autoComplete="new-password"
                aria-label={props.keyLabel}
                placeholder={props.keyPlaceholder ?? props.keyLabel}
                autoFocus={!props.nameField}
                disabled={busy || (!props.nameField && !by)}
                onChange={(event) => {
                  keyInput.current = event.target;
                  setHasKey(event.target.value.trim() !== "");
                }}
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
              {!allowed || revoked ? (
                <p role="status" className="text-sm text-warning-foreground">
                  {props.forbidden}
                </p>
              ) : null}
              {invalidated ? (
                <p role="alert" className="text-sm text-warning-foreground">
                  {STALE}
                </p>
              ) : null}
              {problem ? (
                <p role="alert" className="text-sm text-warning-foreground">
                  {problem}
                </p>
              ) : null}
            </form>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={close}>
            Cancel
          </Button>
          {step === "warning" ? (
            <Button variant="destructive" {...props.continueProps} onClick={() => setStep("key")}>
              Continue
            </Button>
          ) : (
            <Button
              type="submit"
              form={formId}
              variant={props.warning ? "destructive" : "default"}
              disabled={busy || blocked || !hasKey}
              {...props.submitProps}
              onClick={(event?: { preventDefault?: () => void }) => {
                // The form's own submit handles Enter; the click path is the same single submit.
                event?.preventDefault?.();
                void submit();
              }}
            >
              {busy && props.busyLabel ? props.busyLabel : props.submitLabel}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
