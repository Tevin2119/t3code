import type { KimiSettings } from "@t3tools/contracts";
import { makeForkAcpAdapter, type ForkAcpAdapterOptions } from "./ForkAcpAdapter.ts";

export type KimiAdapterOptions = ForkAcpAdapterOptions;

export const makeKimiAdapter = (_settings: KimiSettings, options: KimiAdapterOptions) =>
  makeForkAcpAdapter("kimi", options);
