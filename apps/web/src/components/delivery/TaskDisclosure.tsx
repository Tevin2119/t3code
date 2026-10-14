import { ChevronDownIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";

export function TaskDisclosure(props: {
  readonly title: ReactNode;
  readonly children: ReactNode;
  readonly defaultOpen?: boolean;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
}) {
  return (
    <Collapsible
      defaultOpen={props.defaultOpen ?? true}
      open={props.open}
      onOpenChange={props.onOpenChange}
      className="min-w-0"
    >
      <h3>
        <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-md py-2 text-left text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
          <ChevronDownIcon
            aria-hidden
            className="size-4 shrink-0 transition-transform group-data-panel-open:rotate-180"
          />
          <span className="min-w-0 flex-1">{props.title}</span>
        </CollapsibleTrigger>
      </h3>
      <CollapsiblePanel keepMounted animate={false}>
        <div className="flex min-w-0 flex-col gap-4 pt-1">{props.children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}
