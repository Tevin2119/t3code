import { InfoIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

/**
 * An explanation kept out of the way: an info icon that opens it on a click or a tap. A tooltip
 * would need a pointer that hovers, which a phone does not have.
 */
export function InfoPopover(props: {
  /** What the icon explains, read out by a screen reader and shown as the popup's heading. */
  readonly label: string;
  readonly children: ReactNode;
  /** Marks the popup's text, for checks of the page. */
  readonly marker?: Record<string, string>;
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={props.label}
            className="text-muted-foreground"
            data-info-popover-trigger={props.label}
          />
        }
      >
        <InfoIcon className="size-3.5" aria-hidden />
      </PopoverTrigger>
      <PopoverPopup side="top" align="start" className="w-80 max-w-[calc(100vw-2rem)]">
        <p className="text-xs font-medium">{props.label}</p>
        <p className="mt-1 text-xs text-muted-foreground" {...props.marker}>
          {props.children}
        </p>
      </PopoverPopup>
    </Popover>
  );
}
