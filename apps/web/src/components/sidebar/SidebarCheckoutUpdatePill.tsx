import { Spinner } from "~/components/ui/spinner";
import { DownloadIcon, TriangleAlertIcon, XIcon } from "lucide-react";

import { useCheckoutUpdatePill } from "../CheckoutUpdateNotification";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

// The tones of SidebarProviderUpdatePill, so the two pills read as one area.
const CHECKOUT_UPDATE_PILL_STYLES = {
  info: "bg-sidebar-control-surface text-sidebar-foreground",
  loading: "bg-sidebar-control-surface text-sidebar-foreground",
  error: "bg-destructive/12 text-destructive",
} as const;

/** The update of a T3 run from a git checkout, in the v2 sidebar's footer. */
export function SidebarCheckoutUpdatePill() {
  const pill = useCheckoutUpdatePill();
  const view = pill?.view ?? null;
  const announcement = view
    ? [view.title, view.description, view.notice].filter(Boolean).join(". ")
    : "";

  return (
    <>
      {/* Mounted in every state so phase changes and outcomes are announced. */}
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
      {pill !== null && view !== null ? (
        <div
          className={`flex w-full shrink-0 flex-col gap-1.5 rounded-lg px-2 py-1.5 text-[11px] leading-4 font-medium ${
            CHECKOUT_UPDATE_PILL_STYLES[view.tone]
          }`}
        >
          <div className="flex min-w-0 items-start gap-2">
            {view.tone === "loading" ? (
              <Spinner className="mt-px size-3.5 shrink-0" />
            ) : view.tone === "error" ? (
              <TriangleAlertIcon aria-hidden="true" className="mt-px size-3.5 shrink-0" />
            ) : (
              <DownloadIcon aria-hidden="true" className="mt-px size-3.5 shrink-0" />
            )}
            <div aria-hidden="true" className="min-w-0 flex-1">
              <p className="wrap-break-word">{view.title}</p>
              <p className="wrap-break-word font-normal opacity-80">{view.description}</p>
              {view.notice ? (
                <p className="wrap-break-word font-normal text-destructive">{view.notice}</p>
              ) : null}
            </div>
            {view.close !== null ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-micro"
                      variant="ghost"
                      aria-label={view.close === "dismiss" ? "Dismiss T3 update" : "Close"}
                      className="-mr-1 [--control-icon-color:currentColor] rounded-md text-inherit opacity-70 hover:bg-transparent hover:opacity-100"
                      onClick={pill.close}
                    >
                      <XIcon className="size-3.5 shrink-0" />
                    </Button>
                  }
                />
                <TooltipPopup side="top">
                  {view.close === "dismiss" ? "Dismiss until a newer commit" : "Close"}
                </TooltipPopup>
              </Tooltip>
            ) : null}
          </div>
          {view.action === "update" || view.action === "starting" ? (
            <Button
              size="xs"
              variant="outline"
              aria-disabled={view.action === "starting"}
              className="self-start aria-disabled:pointer-events-none aria-disabled:opacity-64"
              onClick={pill.start}
            >
              {view.action === "starting" ? "Starting…" : "Update and restart"}
            </Button>
          ) : view.action === "reload" ? (
            <Button size="xs" variant="outline" className="self-start" onClick={pill.reload}>
              Reload
            </Button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
