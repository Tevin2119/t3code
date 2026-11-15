import { expect, it } from "vite-plus/test";
import { deliveryProgress, deliveryTaskRequest, parseBoardDelivery } from "./boardDelivery";

it("keeps a retry tied to the same task and originating environment", () => {
  const task = { id: "task-a", origin: "thread:host-a/chat-a" };
  expect(deliveryTaskRequest("route", task, "host-a")).toEqual(
    deliveryTaskRequest("route", task, "host-a"),
  );
  expect(() => deliveryTaskRequest("route", task, "host-b")).toThrow(/selected environment/);
  expect(() =>
    deliveryTaskRequest("route", { ...task, origin: "thread:host-a/" }, "host-a"),
  ).toThrow();
});

it("does not turn task or merge completion into a live deployment", () => {
  const row = {
    request: null,
    complete: false,
    publications: [
      {
        pr_url: null,
        state: "merged",
        merge: { state: "merged", problem: null, merge_commit: "abc" },
      },
    ],
    candidate: null,
    live: { commit: "old" },
  };
  expect(deliveryProgress(row)).toBe("PR merged; awaiting release qualification");
  expect(deliveryProgress({ ...row, candidate: { state: "live", commit: "abc" } })).toBe(
    "Awaiting live verification: abc",
  );
  expect(deliveryProgress({ ...row, complete: true, live: { commit: "abc" } })).toBe("Live: abc");
  expect(
    deliveryProgress({
      ...row,
      publications: [
        {
          ...row.publications[0]!,
          merge: {
            state: "merged-elsewhere",
            problem: "Merged into the wrong branch",
            merge_commit: "abc",
          },
        },
      ],
    }),
  ).toBe("Merged into the wrong branch");
});

it("rejects an old engine response instead of inventing delivery routes", () => {
  expect(parseBoardDelivery({ error: "Not found" })).toBeNull();
  expect(parseBoardDelivery({ boards: [], routes: [], projects: [], tracking: [] })).not.toBeNull();
});
