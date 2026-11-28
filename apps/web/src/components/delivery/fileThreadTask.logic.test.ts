import { expect, it } from "vite-plus/test";

import { fileThreadTaskOffered } from "./fileThreadTask.logic";

it.each([
  { deliveryEnabled: true, serverOwned: false, permitted: true, offered: true },
  { deliveryEnabled: false, serverOwned: false, permitted: true, offered: false },
  { deliveryEnabled: true, serverOwned: false, permitted: false, offered: false },
  { deliveryEnabled: true, serverOwned: true, permitted: true, offered: false },
])(
  "offers filing with delivery $deliveryEnabled, server-owned $serverOwned and permission $permitted: $offered",
  ({ offered, ...input }) => {
    expect(fileThreadTaskOffered(input)).toBe(offered);
  },
);
