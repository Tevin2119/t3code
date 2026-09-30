import { CircleHelpIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";

/** One line of what a thing is, and what makes one. */
const PARTS: ReadonlyArray<readonly [string, string]> = [
  [
    "Thread",
    "A conversation with one harness. With a team and a role chosen, it is a conversation with that seat. Sending in a thread puts nothing on the Board; Create task from conversation (in the thread's menu) makes a task of it, for you to review first, and the two then link to each other.",
  ],
  [
    "Task",
    "A card on the Board: work given to a team. It is made by New task (on the Board, in the sidebar or from the command palette), from a conversation, or by the engine from a finding, and goes on the board you choose. It keeps what was asked, said and decided.",
  ],
  [
    "Flow",
    "What the team does with a task: Team chat talks, Plan plans, Review examines, Delivery builds. It is chosen when the task is made.",
  ],
  [
    "Run",
    "One go of the team at a task, with the seats as they were set. A task sent back or started again gets a new run; the earlier ones are kept.",
  ],
  [
    "Waiting on you",
    "Tasks that cannot go on without you: a question to answer, a change to confirm, a plan to read, work to approve or send back.",
  ],
  [
    "Tool approval",
    "In a Supervised thread, a harness asks before one action, such as writing a file. Approving it allows that action alone. It has nothing to do with a task.",
  ],
  [
    "Approve and Send back",
    "The decision on a task that passed its checks, review and QA. Approve records acceptance of the commit that was tested, and is the gate for publishing it; Send back gives the reason to redo it. Neither merges anything.",
  ],
  [
    "Pull request",
    "Where publishing is set up, your approval pushes the approved commit to its own branch and opens one pull request for it; a failed attempt can be tried again. Where it is not, the task says so and nothing is pushed. Merging is done on the repository host, never by the team. The columns keep these apart: Your sign-off, Approved (not published), Pull request open, Done (merged).",
  ],
];

export function HowItFits() {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="How the Board, threads and tasks fit together"
            data-board-how
          />
        }
      >
        <CircleHelpIcon />
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="end" className="w-[30rem] max-w-[calc(100vw-2rem)]">
        <PopoverTitle className="pb-2 text-sm">How it fits together</PopoverTitle>
        <dl className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto text-xs">
          {PARTS.map(([term, meaning]) => (
            <div key={term}>
              <dt className="font-medium">{term}</dt>
              <dd className="text-muted-foreground">{meaning}</dd>
            </div>
          ))}
        </dl>
      </PopoverPopup>
    </Popover>
  );
}
