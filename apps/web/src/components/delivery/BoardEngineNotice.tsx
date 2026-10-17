import type { ComponentProps, ReactNode } from "react";
import { useState } from "react";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { EngineDownNotice } from "./EnginePanel";

export function BoardEngineNotice(props: ComponentProps<typeof EngineDownNotice>) {
  return (
    <BoardNotice summary="Delivery engine not reachable. Tap for details.">
      <EngineDownNotice {...props} />
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
