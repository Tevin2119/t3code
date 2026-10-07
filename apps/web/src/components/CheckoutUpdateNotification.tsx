import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { DownloadIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { primaryServerConfigAtom, serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { checkoutUpdateView } from "./CheckoutUpdate.logic";
import { hiddenToastActionProps, stackedThreadToast, toastManager } from "./ui/toast";

const DISMISSED_KEY = "t3code:checkout-update-dismissed:v1";
const DismissedCommit = Schema.String;

/**
 * Offers the update of the T3 this page came from, when that T3 runs from a
 * git checkout under the supervisor, and reloads the page once it has moved on.
 */
export function CheckoutUpdateNotification() {
  const environmentId = usePrimaryEnvironmentId();
  const config = useAtomValue(primaryServerConfigAtom);
  if (environmentId === null || config?.environment.capabilities.checkoutUpdate !== true)
    return null;
  return <CheckoutUpdateToast environmentId={environmentId} />;
}

function CheckoutUpdateToast({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const state = useEnvironmentQuery(
    serverEnvironment.checkoutUpdateState({ environmentId, input: {} }),
  ).data;
  const start = useAtomCommand(serverEnvironment.startCheckoutUpdate, {
    reportFailure: false,
    reportDefect: false,
  });
  // The build this page runs: the commit the server ran when the page first heard from it.
  const [loadedCommit, setLoadedCommit] = useState<string | null>(null);
  if (state !== null && loadedCommit === null) setLoadedCommit(state.running.commit);
  const startedHereRef = useRef(false);
  const [dismissedCommit, setDismissedCommit] = useState(() =>
    getLocalStorageItem(DISMISSED_KEY, DismissedCommit),
  );
  const toastRef = useRef<{
    readonly id: ReturnType<typeof toastManager.add>;
    readonly key: string;
  } | null>(null);

  const view = checkoutUpdateView(state, { loadedCommit, dismissedCommit });

  const startUpdate = useCallback(async () => {
    startedHereRef.current = true;
    const result = await start({ environmentId, input: {} });
    if (result._tag === "Failure") {
      startedHereRef.current = false;
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "T3 could not start the update",
          description: "Try again from Settings > Connections.",
        }),
      );
    }
  }, [environmentId, start]);

  useEffect(() => {
    // This tab asked for the update, so it takes the new build at once.
    if (view?.kind === "reload" && startedHereRef.current) {
      window.location.reload();
      return;
    }
    const current = toastRef.current;
    if (current?.key === view?.key) return;
    if (current !== null) {
      toastManager.close(current.id);
      toastRef.current = null;
    }
    if (view === null) return;
    const dismiss = () => {
      if (view.kind === "available" && state?.available) {
        setLocalStorageItem(DISMISSED_KEY, state.available.commit, DismissedCommit);
        setDismissedCommit(state.available.commit);
      }
      toastRef.current = null;
    };
    const id = toastManager.add(
      stackedThreadToast({
        type: view.kind === "failed" ? "error" : view.kind === "progress" ? "loading" : "info",
        title: view.title,
        description: view.description,
        timeout: 0,
        actionProps:
          view.kind === "available"
            ? { children: "Update and restart", onClick: () => void startUpdate() }
            : view.kind === "reload"
              ? { children: "Reload", onClick: () => window.location.reload() }
              : hiddenToastActionProps,
        data: {
          hideCopyButton: true,
          leadingIcon: <DownloadIcon aria-hidden="true" className="size-4 text-success" />,
          onClose: dismiss,
        },
      }),
    );
    toastRef.current = { id, key: view.key };
  }, [view, state, startUpdate]);

  useEffect(
    () => () => {
      if (toastRef.current !== null) toastManager.close(toastRef.current.id);
    },
    [],
  );

  return null;
}
