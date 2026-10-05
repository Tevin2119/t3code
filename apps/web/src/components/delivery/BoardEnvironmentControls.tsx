import { useNavigate, useSearch } from "@tanstack/react-router";
import type { DeliveryBoardSearch } from "../../lib/deliveryBoard";
import { useBoardStore, useDeliveryEnvironmentId } from "../../state/delivery";
import { EnvironmentPicker } from "./EnvironmentPicker";
import { EnginePanel } from "./EnginePanel";

export function BoardEnvironmentControls() {
  const search = useSearch({ strict: false }) as DeliveryBoardSearch;
  const environmentId = useDeliveryEnvironmentId(null, search.environment ?? null);
  const setEnvironment = useBoardStore((state) => state.setDeliveryEnvironment);
  const navigate = useNavigate();
  return (
    <div className="no-drag relative z-10 ml-1 flex shrink-0 items-center gap-0.5">
      <EnvironmentPicker
        compact
        value={environmentId}
        onChoose={(environment) => {
          setEnvironment(environment);
          void navigate({ to: "/board", search: { environment } });
        }}
      />
      {environmentId ? (
        <EnginePanel key={environmentId} compact environmentId={environmentId} />
      ) : null}
    </div>
  );
}
