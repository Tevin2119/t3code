import { useNavigate, useSearch } from "@tanstack/react-router";

import { useDeliveryEnabled } from "../../state/delivery";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { SidebarInset } from "../ui/sidebar";
import { TaskEditor } from "./TaskEditor";
import { TaskWorkspace } from "./TaskWorkspace";

/**
 * A conversation with a team. It is the same task the Board shows, opened on
 * what was said: it begins as a draft, where nothing runs, and once it is
 * submitted the engine moves it on and the team is written to from here.
 */
export function OrchestratorPage() {
  const environmentId = usePrimaryEnvironmentId();
  const enabled = useDeliveryEnabled(environmentId);
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { thread?: string };
  const select = (thread: string | null) =>
    void navigate({ to: "/orchestrator", search: thread ? { thread } : {} });

  if (!enabled) {
    return (
      <SidebarInset className="h-dvh bg-background text-foreground">
        <p className="p-6 text-sm text-muted-foreground">
          Delivery is turned off for this environment. Turn it on in the server settings to talk to
          a team.
        </p>
      </SidebarInset>
    );
  }
  if (!search.thread) {
    return (
      <TaskEditor
        environmentId={environmentId}
        taskId={null}
        from="Orchestrator"
        onClose={() => void navigate({ to: "/board" })}
        onSaved={select}
      />
    );
  }
  return (
    <TaskWorkspace
      environmentId={environmentId}
      taskId={search.thread}
      from="Orchestrator"
      onClose={() => select(null)}
      onOpenTask={select}
    />
  );
}
