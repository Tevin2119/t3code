import { expect, it } from "vite-plus/test";
import { Route } from "./orchestrator";

it.each([
  [{}, "/", undefined],
  [{ thread: "task-abcdef" }, "/board", { task: "task-abcdef" }],
] as const)("routes an orchestration link %j", (search, to, expectedSearch) => {
  const beforeLoad = Route.options.beforeLoad!;
  try {
    beforeLoad({ search } as Parameters<typeof beforeLoad>[0]);
    expect.unreachable("Expected a redirect");
  } catch (redirect) {
    expect(redirect).toMatchObject({
      options: { to, replace: true, ...(expectedSearch ? { search: expectedSearch } : {}) },
    });
  }
});
