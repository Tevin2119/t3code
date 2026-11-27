import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { deliveryEnvironment } from "../../state/delivery";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
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
import { toastManager } from "../ui/toast";
import { useSettingsScope } from "./SettingsScopeContext";
import { useSearchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/**
 * The engine's approval key, one row per environment in scope that runs delivery. Each row names
 * its server, so a key is never saved on one a person did not pick.
 */
export function BoardApprovalKeySettings() {
  const { connectedEnvironments } = useSettingsScope();
  const named = connectedEnvironments.length > 1;
  return connectedEnvironments.map((environment, index) => (
    <EnvironmentBoardApprovalKey
      key={environment.environmentId}
      environmentId={environment.environmentId}
      label={environment.label}
      named={named}
      anchored={index === 0}
    />
  ));
}

function EnvironmentBoardApprovalKey({
  environmentId,
  label,
  named,
  anchored,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** Several environments are in scope, so the section names this one. */
  readonly named: boolean;
  /** Search lands on the first row; the others keep their own anchors. */
  readonly anchored: boolean;
}) {
  const gt = useGT();
  const setting = useSearchableSetting();
  const enabled = useEnvironmentSettings(environmentId, (settings) => settings.delivery.enabled);
  const status = useEnvironmentQuery(
    enabled ? deliveryEnvironment.boardApprovalKey({ environmentId, input: {} }) : null,
  );
  const canSet = useAtomValue(
    deliveryEnvironment.setBoardApprovalKey.permissionAtom(environmentId),
  );
  const save = useAtomCommand(deliveryEnvironment.setBoardApprovalKey, { reportFailure: false });
  const [editing, setEditing] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  if (!enabled) return null;

  const source = status.data?.source ?? null;
  const stored = status.data?.stored === true;
  const typed = draft.trim();
  const closeEditor = () => {
    setEditing(false);
    setDraft("");
  };
  const write = async (key: string | null) => {
    setBusy(true);
    const result = await save({ environmentId, input: { key } });
    setBusy(false);
    setDraft("");
    if (result._tag === "Success") {
      status.refresh();
      setEditing(false);
      setClearing(false);
      toastManager.add({
        type: "success",
        title: key === null ? gt("Board approval key cleared") : gt("Board approval key saved"),
        description:
          result.value.source === "environment"
            ? gt("The server's T3_DELIVERY_BOARD_THREAD_KEY is still set, and it wins.")
            : key === null
              ? gt("Board tasks on {environment} can't run in T3 until a key is set.", {
                  environment: label,
                })
              : gt("Board tasks on {environment} can run in T3 now.", { environment: label }),
      });
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: gt("Could not save the board approval key"),
      description: error instanceof Error ? error.message : gt("An error occurred."),
    });
  };

  return (
    <SettingsSection
      id={anchored ? "board" : `board-${environmentId}`}
      title={named ? gt("Board on {environment}", { environment: label }) : gt("Board")}
    >
      <SettingsRow
        serverScoped
        {...setting("board-approval-key")}
        {...(anchored ? {} : { id: `board-approval-key-${environmentId}` })}
        description={gt(
          "The delivery engine's approval passphrase. T3 uses it to link board tasks to their threads and run their steps. It is kept in this server's secret store and never shown again.",
        )}
        status={
          source === "environment"
            ? stored
              ? gt(
                  "Stored key is overridden by the environment variable T3_DELIVERY_BOARD_THREAD_KEY.",
                )
              : gt(
                  "Set by the server's T3_DELIVERY_BOARD_THREAD_KEY, which wins over a key saved here.",
                )
            : status.error
              ? status.error
              : undefined
        }
        control={
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {source === null ? null : source === "none" ? (
              <Badge variant="warning" size="sm">
                {gt("Not set", { $context: "board approval key state" })}
              </Badge>
            ) : (
              <Badge variant="success" size="sm">
                {gt("Set", { $context: "board approval key state" })}
              </Badge>
            )}
            <Button
              size="xs"
              variant="outline"
              disabled={!canSet || busy}
              title={canSet ? undefined : gt("Only an environment maintainer can change this key.")}
              onClick={() => setEditing(true)}
            >
              {stored ? gt("Replace") : gt("Set key")}
            </Button>
            {stored ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={!canSet || busy}
                onClick={() => setClearing(true)}
              >
                {gt("Clear")}
              </Button>
            ) : null}
          </div>
        }
      />
      <Dialog
        open={editing}
        onOpenChange={(open) => {
          if (busy) return;
          if (open) setEditing(true);
          else closeEditor();
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              {stored ? gt("Replace board approval key") : gt("Set board approval key")}
            </DialogTitle>
            <DialogDescription>
              {gt(
                "Use the approval passphrase of the delivery engine on {environment}. T3 saves it on that server and never shows it again.",
                { environment: label },
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <Input
              type="password"
              name="board-approval-key"
              autoComplete="off"
              aria-label={gt("Board approval key")}
              placeholder={gt("Approval passphrase")}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && typed) void write(typed);
              }}
              disabled={busy}
            />
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={closeEditor} disabled={busy}>
              {gt("Cancel")}
            </Button>
            <Button onClick={() => void write(typed)} disabled={busy || !typed}>
              {gt("Save")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <AlertDialog open={clearing} onOpenChange={(open) => !busy && setClearing(open)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{gt("Clear the board approval key?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {gt(
                "Board tasks on {environment} stop linking to threads, and their steps don't run in T3, until a key is set again.",
                { environment: label },
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={busy} />}>
              {gt("Cancel")}
            </AlertDialogClose>
            <Button variant="destructive" disabled={busy} onClick={() => void write(null)}>
              {gt("Clear key")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSection>
  );
}
