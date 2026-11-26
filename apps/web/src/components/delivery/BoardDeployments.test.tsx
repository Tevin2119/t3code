import { create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";
import { act } from "../../../test/act";
import { BoardDeployments } from "./BoardDeployments";

const mock = vi.hoisted(() => ({ reads: vi.fn(), snapshot: {} as unknown }));
vi.mock("./DeploymentsPage", () => ({ Configuration: "configuration" }));
vi.mock("./DeploymentsPage.runtime", () => ({ DeploymentRuntime: "deployment-runtime" }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("../../state/delivery", () => ({
  deliveryEnvironment: { act: { permissionAtom: () => null } },
  useDeliveryAct: () => vi.fn(),
  useDeliveryRead: (env: string | null, path: string | null, options: unknown) => {
    mock.reads(env, path, options);
    return { body: mock.snapshot, error: null, isPending: false, readAt: null, refresh: vi.fn() };
  },
  useStaleReading: () => false,
  usePersonName: () => "Sam",
  useBoardStore: (select: (state: unknown) => unknown) => select({ setPerson: vi.fn() }),
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/badge", () => ({ Badge: "badge" }));
vi.mock("./TaskDisclosure", () => ({ TaskDisclosure: "disclosure" }));

const project = (id: string, repository: string) => ({
  id,
  repository,
  title: repository,
  branch: "main",
  environment: "main",
  mode: "manual",
  adapter: "command",
  latestCommit: null,
  liveCommit: null,
});

it("reads only the board repository's instances and shows no other repository's", async () => {
  mock.snapshot = {
    version: 1,
    projects: [project("mine", "payoutlab"), project("theirs", "other")],
    candidates: [],
    repositories: [],
    capabilities: { engine: false, command: true, "firebase-hosting": true },
  };
  let renderer!: ReactTestRenderer;
  await act(() => {
    renderer = create(
      <BoardDeployments
        environmentId={"host" as never}
        target={{
          repository: "payoutlab",
          base: "qa",
          title: "PayoutLab",
          path: "/repo",
          ok: true,
          problem: null,
        }}
      />,
    );
  });
  expect(mock.reads).toHaveBeenCalledWith("host", "/api/deployments?repository=payoutlab", {
    pollMs: 10_000,
  });
  const sections = renderer.root
    .findAllByType("section")
    .map((node) => node.props["aria-label"] as string);
  expect(sections).toEqual(["Board deployments", "payoutlab main"]);
  await act(() => renderer.unmount());
});
