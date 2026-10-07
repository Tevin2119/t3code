import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { availableUpdateLine, checkoutUpdateView, shortCommit } from "./CheckoutUpdate.logic";
import { Button } from "./ui/button";

/**
 * The version of a T3 run from a git checkout, with the update on offer, for
 * a row of Settings > Connections. Shown only for servers that can take it.
 */
export function CheckoutUpdateAction({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const state = useEnvironmentQuery(
    serverEnvironment.checkoutUpdateState({ environmentId, input: {} }),
  ).data;
  const options = { reportFailure: false, reportDefect: false };
  const start = useAtomCommand(serverEnvironment.startCheckoutUpdate, options);
  const check = useAtomCommand(serverEnvironment.checkCheckoutUpdate, options);
  const [error, setError] = useState<string | null>(null);
  if (state === null) return null;

  const view = checkoutUpdateView(state, { loadedCommit: null, dismissedCommit: null });
  const busy = state.phase !== "idle" && state.phase !== "failed";
  const run = async (command: typeof start) => {
    setError(null);
    const result = await command({ environmentId, input: {} });
    if (result._tag === "Failure") setError("The request did not reach that T3. Try again.");
  };

  return (
    <div className="mt-1 flex max-w-md flex-wrap items-center gap-2 text-muted-foreground text-xs">
      <span>
        T3 {shortCommit(state.running.commit)}
        {view?.kind === "progress" || view?.kind === "failed"
          ? ` · ${view.description}`
          : state.available
            ? ` · update: ${availableUpdateLine(state.available)}`
            : " · up to date"}
      </span>
      {state.available && !busy ? (
        <Button size="xs" variant="outline" onClick={() => void run(start)}>
          Update and restart
        </Button>
      ) : !busy ? (
        <Button size="xs" variant="ghost" onClick={() => void run(check)}>
          Check now
        </Button>
      ) : null}
      {error ? <span className="text-destructive">{error}</span> : null}
    </div>
  );
}
