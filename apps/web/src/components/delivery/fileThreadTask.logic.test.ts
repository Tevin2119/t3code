import { expect, it } from "vite-plus/test";

import { fileThreadTaskOffered } from "./fileThreadTask.logic";

it.each([
  { deliveryEnabled: true, threadId: "thread-1", permitted: true, offered: true },
  { deliveryEnabled: false, threadId: "thread-1", permitted: true, offered: false },
  { deliveryEnabled: true, threadId: "thread-1", permitted: false, offered: false },
  { deliveryEnabled: true, threadId: "board-task:work:task-1", permitted: true, offered: false },
])(
  "offers filing $threadId with delivery $deliveryEnabled and permission $permitted: $offered",
  ({ offered, ...input }) => {
    expect(fileThreadTaskOffered(input)).toBe(offered);
  },
);
