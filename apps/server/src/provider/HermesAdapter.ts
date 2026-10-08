import type { HermesSettings } from "@t3tools/contracts";
import { makeForkAcpAdapter, type ForkAcpAdapterOptions } from "./ForkAcpAdapter.ts";

export type HermesAdapterOptions = ForkAcpAdapterOptions;

export const makeHermesAdapter = (_settings: HermesSettings, options: HermesAdapterOptions) =>
  makeForkAcpAdapter("hermes", options);
