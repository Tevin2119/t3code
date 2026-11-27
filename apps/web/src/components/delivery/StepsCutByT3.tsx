import { useGT } from "gt-react";

import type { stepsCutByT3 } from "../../lib/delivery";
import { cn } from "../../lib/utils";

/**
 * Each step of a board task that T3's own restart cut short. The engine runs it once more on its
 * own, so the task can look like it is moving on: these lines keep it in front of a person.
 */
export function StepsCutByT3(props: {
  readonly steps: ReturnType<typeof stepsCutByT3>;
  readonly className?: string;
}) {
  const gt = useGT();
  if (props.steps.length === 0) return null;
  return (
    <ul
      role="status"
      className={cn(
        "m-0 flex list-none flex-col gap-1 p-0 text-warning-foreground",
        props.className,
      )}
      data-steps-cut-by-t3
    >
      {props.steps.map((step) => (
        <li key={`${step.seat}:${step.stage}`} data-step-cut-by-t3={step.seat}>
          {gt(
            "T3 restarted and cut {seat}''s {stage} step short. It needs a person to check it before the work goes on.",
            { seat: step.seat, stage: step.stage },
          )}
        </li>
      ))}
    </ul>
  );
}
