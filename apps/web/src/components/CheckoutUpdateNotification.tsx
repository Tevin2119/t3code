import { useAtomValue } from "@effect/atom-react";
import type { CheckoutUpdateState, EnvironmentId } from "@t3tools/contracts";
import { useLocation } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { DownloadIcon } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";
import { useClientSettingsHydrated, useLegacySidebarEnabled } from "../hooks/useSettings";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { primaryServerConfigAtom, serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import {
  CHECKOUT_UPDATE_NOT_STARTED,
  checkoutUpdatePillView,
  checkoutUpdatePresentation,
  checkoutUpdateView,
  type CheckoutUpdatePillView,
  type CheckoutUpdatePresentation,
} from "./CheckoutUpdate.logic";
import { hiddenToastActionProps, stackedThreadToast, toastManager } from "./ui/toast";

const DISMISSED_KEY = "t3code:checkout-update-dismissed:v1";
const DismissedCommit = Schema.String;

export interface CheckoutUpdatePillModel {
  readonly view: CheckoutUpdatePillView;
  readonly start: () => void;
  /** Remembers a dismissed offer, or closes an outcome notice. */
  readonly close: () => void;
  readonly reload: () => void;
}

const CheckoutUpdatePillContext = createContext<CheckoutUpdatePillModel | null>(null);

/** The checkout update for the v2 sidebar's pill, or null when the pill shows nothing. */
export function useCheckoutUpdatePill(): CheckoutUpdatePillModel | null {
  return useContext(CheckoutUpdatePillContext);
}

/**
 * Offers the update of the T3 this page came from, when that T3 runs from a
 * git checkout under the supervisor, and reloads the page once it has moved on.
 * Wraps the app shell so the sidebar pill can read it; on Settings and with the
 * legacy sidebar it shows a toast instead.
 */
export function CheckoutUpdateProvider({
  enabled,
  children,
}: {
  readonly enabled: boolean;
  readonly children: ReactNode;
}) {
  const [pill, setPill] = useState<CheckoutUpdatePillModel | null>(null);
  return (
    <CheckoutUpdatePillContext.Provider value={pill}>
      {enabled ? <CheckoutUpdateController onPill={setPill} /> : null}
      {children}
    </CheckoutUpdatePillContext.Provider>
  );
}

/** What this tab knows about one environment's checkout update. */
interface Session {
  readonly environmentId: EnvironmentId | null;
  /** The last capability the server reported, kept while its config reconnects. */
  readonly supported: boolean;
  /** The last state heard, kept while the server restarts. */
  readonly lastState: CheckoutUpdateState | null;
  /** The build this page runs: the commit the server ran when the page first heard from it. */
  readonly loadedCommit: string | null;
  readonly pending: boolean;
  readonly startFailed: boolean;
  /** This tab asked for the update, so it takes the new build at once. */
  readonly startedHere: boolean;
  readonly closedKey: string | null;
  /** The state when the start request returned; an idle state after it means the supervisor passed. */
  readonly sentState: CheckoutUpdateState | null | undefined;
}

const newSession = (environmentId: EnvironmentId | null): Session => ({
  environmentId,
  supported: false,
  lastState: null,
  loadedCommit: null,
  pending: false,
  startFailed: false,
  startedHere: false,
  closedKey: null,
  sentState: undefined,
});

const reloadPage = () => window.location.reload();

export function CheckoutUpdateController({
  onPill,
}: {
  readonly onPill: (pill: CheckoutUpdatePillModel | null) => void;
}) {
  const environmentId = usePrimaryEnvironmentId();
  const config = useAtomValue(primaryServerConfigAtom);
  const settingsHydrated = useClientSettingsHydrated();
  const legacySidebar = useLegacySidebarEnabled();
  const pathname = useLocation({ select: (location) => location.pathname });

  const [session, setSession] = useState(() => newSession(environmentId));
  let current = session;
  if (current.environmentId !== environmentId) current = newSession(environmentId);
  if (config !== null) {
    const reported = config.environment.capabilities.checkoutUpdate === true;
    if (reported !== current.supported) {
      current = { ...current, supported: reported, ...(reported ? {} : { lastState: null }) };
    }
  }
  const queried = useEnvironmentQuery(
    current.supported && environmentId !== null
      ? serverEnvironment.checkoutUpdateState({ environmentId, input: {} })
      : null,
  ).data;
  if (queried !== null && queried !== current.lastState) {
    current = {
      ...current,
      lastState: queried,
      loadedCommit: current.loadedCommit ?? queried.running.commit,
    };
  }
  const state = current.supported ? current.lastState : null;

  const [dismissedCommit, setDismissedCommit] = useState(() =>
    getLocalStorageItem(DISMISSED_KEY, DismissedCommit),
  );
  const view = checkoutUpdateView(state, { loadedCommit: current.loadedCommit, dismissedCommit });

  // A start request is done once the server leaves the offer: under way, failed or done.
  // A supervisor already busy passes on it, so an idle state after the reply also ends it.
  const handedOff =
    view?.kind !== "available" ||
    (current.sentState !== undefined && state !== current.sentState && state?.phase === "idle");
  const attemptEnded = view?.kind === "failed" || (handedOff && view?.kind === "available");
  if ((current.pending && handedOff) || (current.startedHere && attemptEnded)) {
    current = {
      ...current,
      pending: false,
      sentState: undefined,
      startedHere: attemptEnded ? false : current.startedHere,
    };
  }
  if (current !== session) setSession(current);
  const presentation = checkoutUpdatePresentation({
    settingsHydrated,
    supported: current.supported,
    legacySidebar,
    pathname,
  });

  const startCommand = useAtomCommand(serverEnvironment.startCheckoutUpdate, {
    reportFailure: false,
    reportDefect: false,
  });
  // Read synchronously by start(), so a second press before React renders does nothing.
  const pendingRef = useRef(false);
  const pending = current.pending;
  const attemptRef = useRef(0);
  const environmentRef = useRef(environmentId);
  const presentationRef = useRef<CheckoutUpdatePresentation>(presentation);
  const latestRef = useRef({ state, view });
  useLayoutEffect(() => {
    if (environmentRef.current !== environmentId) {
      // A request still out belongs to the old environment and must not land here.
      attemptRef.current += 1;
      environmentRef.current = environmentId;
    }
    pendingRef.current = pending;
    presentationRef.current = presentation;
    latestRef.current = { state, view };
  });

  const start = useCallback(() => {
    if (pendingRef.current || environmentId === null) return;
    pendingRef.current = true;
    const attempt = ++attemptRef.current;
    setSession((previous) => ({
      ...previous,
      pending: true,
      startFailed: false,
      startedHere: true,
      sentState: undefined,
    }));
    void startCommand({ environmentId, input: {} }).then((result) => {
      if (attemptRef.current !== attempt || environmentRef.current !== environmentId) return;
      if (result._tag === "Success") {
        const sentState = latestRef.current.state;
        setSession((previous) => (previous.pending ? { ...previous, sentState } : previous));
        return;
      }
      pendingRef.current = false;
      setSession((previous) => ({
        ...previous,
        pending: false,
        startFailed: true,
        startedHere: false,
      }));
      if (presentationRef.current === "toast") {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "T3 could not start the update",
            description: CHECKOUT_UPDATE_NOT_STARTED,
          }),
        );
      }
    });
  }, [environmentId, startCommand]);

  const reloadingHere = view?.kind === "reload" && current.startedHere;
  useEffect(() => {
    if (reloadingHere) reloadPage();
  }, [reloadingHere]);

  const close = useCallback(() => {
    const { state, view } = latestRef.current;
    if (view === null) return;
    if (view.kind === "available" && state?.available) {
      setLocalStorageItem(DISMISSED_KEY, state.available.commit, DismissedCommit);
      setDismissedCommit(state.available.commit);
      return;
    }
    setSession((previous) => ({ ...previous, closedKey: view.key }));
  }, [setDismissedCommit]);

  const shown = reloadingHere || view === null || view.key === current.closedKey ? null : view;
  useCheckoutUpdateToast(presentation === "toast" ? shown : null, start, close);

  const pillView =
    presentation === "pill" && !reloadingHere
      ? checkoutUpdatePillView(view, {
          starting: current.pending,
          startFailed: current.startFailed,
          closedKey: current.closedKey,
        })
      : null;
  // The view is rebuilt every render; its contents decide whether the pill changed.
  const pillJson = pillView === null ? null : JSON.stringify(pillView);
  const pill = useMemo<CheckoutUpdatePillModel | null>(
    () =>
      pillJson === null
        ? null
        : {
            view: JSON.parse(pillJson) as CheckoutUpdatePillView,
            start,
            close,
            reload: reloadPage,
          },
    [pillJson, start, close],
  );
  useEffect(() => onPill(pill), [onPill, pill]);
  useEffect(() => () => onPill(null), [onPill]);

  return null;
}

function useCheckoutUpdateToast(
  view: ReturnType<typeof checkoutUpdateView>,
  start: () => void,
  close: () => void,
) {
  const toastRef = useRef<{
    readonly id: ReturnType<typeof toastManager.add>;
    readonly key: string;
  } | null>(null);
  const startRef = useRef(start);
  const closeRef = useRef(close);
  useLayoutEffect(() => {
    startRef.current = start;
    closeRef.current = close;
  });

  useEffect(() => {
    const current = toastRef.current;
    if (current?.key === view?.key) return;
    // Closed by code, not by the person: nothing is remembered.
    if (current !== null) {
      toastManager.close(current.id);
      toastRef.current = null;
    }
    if (view === null) return;
    const id = toastManager.add(
      stackedThreadToast({
        type: view.kind === "failed" ? "error" : view.kind === "progress" ? "loading" : "info",
        title: view.title,
        description: view.description,
        timeout: 0,
        actionProps:
          view.kind === "available"
            ? { children: "Update and restart", onClick: () => startRef.current() }
            : view.kind === "reload"
              ? { children: "Reload", onClick: reloadPage }
              : hiddenToastActionProps,
        data: {
          hideCopyButton: true,
          leadingIcon: <DownloadIcon aria-hidden="true" className="size-4 text-success" />,
          // Called only when the person closes the toast.
          onClose: () => {
            toastRef.current = null;
            closeRef.current();
          },
        },
      }),
    );
    toastRef.current = { id, key: view.key };
  }, [view]);

  useEffect(
    () => () => {
      if (toastRef.current !== null) toastManager.close(toastRef.current.id);
    },
    [],
  );
}
