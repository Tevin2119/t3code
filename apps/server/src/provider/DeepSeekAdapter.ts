import type { DeepSeekSettings } from "@t3tools/contracts";
import { makeForkAcpAdapter, type ForkAcpAdapterOptions } from "./ForkAcpAdapter.ts";

export type DeepSeekAdapterOptions = ForkAcpAdapterOptions;

export const makeDeepSeekAdapter = (_settings: DeepSeekSettings, options: DeepSeekAdapterOptions) =>
  makeForkAcpAdapter("deepseek", options);
