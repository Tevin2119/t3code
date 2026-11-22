import type {
  DeliveryLimitedSeatNotice,
  DeliveryLimitedSeatStatus,
  ModelSelection,
} from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

/** One limited-seat notice in words, with what its one action does. */
export interface LimitedSeatNoticeView {
  readonly id: string;
  readonly notice: DeliveryLimitedSeatNotice;
  readonly title: string;
  readonly description: string;
  readonly action:
    | { readonly type: "swap"; readonly label: string; readonly substitute: ModelSelection }
    | { readonly type: "open"; readonly label: string }
    | null;
}

/** The notices of a conversation whose seats or lead are limited, the lead's first. */
export function limitedSeatNoticeViews(
  status: DeliveryLimitedSeatStatus | null,
  options: {
    /** The name a model is shown by; its slug where the catalog has no name for it. */
    readonly modelName: (model: Pick<ModelSelection, "instanceId" | "model">) => string;
    /** A reset time as the banner beside it writes one; null leaves the time out. */
    readonly formatReset: (resetAt: string) => string | null;
  },
  resolve: MFunctionType = mFallback,
): ReadonlyArray<LimitedSeatNoticeView> {
  if (status === null || status.policy === null) return [];
  return status.notices.map((notice) => {
    const model = options.modelName(notice.limited);
    const substitute = notice.substitute === null ? null : options.modelName(notice.substitute);
    const reset = notice.limited.resetAt ? options.formatReset(notice.limited.resetAt) : null;
    const limited =
      notice.seat === null
        ? resolve(msg("{model} has reached its usage limit", { model }))
        : resolve(msg("{seat}: {model} has reached its usage limit", { seat: notice.seat, model }));
    const id = `limited-seat:${notice.seat ?? ""}:${notice.limited.instanceId}:${notice.limited.model}:${notice.state}`;
    if (notice.state === "swapped" && substitute !== null) {
      return notice.seat === null
        ? {
            id,
            notice,
            title: resolve(msg("Continued on {substitute}", { substitute })),
            description: resolve(
              msg(
                "{model} reached its usage limit, so this conversation continues in a linked thread. This one stays readable.",
                { model },
              ),
            ),
            action: { type: "open", label: resolve(msg("Open thread")) },
          }
        : {
            id,
            notice,
            title: resolve(msg("{seat} runs on {substitute}", { seat: notice.seat, substitute })),
            description: resolve(
              msg(
                "{model} has reached its usage limit. {seat} returns to it once the limit resets.",
                {
                  model,
                  seat: notice.seat,
                },
              ),
            ),
            action: null,
          };
    }
    if (notice.state === "offered" && notice.substitute !== null && substitute !== null) {
      return {
        id,
        notice,
        title: limited,
        description:
          notice.seat === null
            ? resolve(
                msg(
                  "{substitute} is free. Swapping continues this conversation in a new linked thread with a summary.",
                  { substitute },
                ),
              )
            : resolve(
                msg("{substitute} is free. {seat} uses it from your next message.", {
                  substitute,
                  seat: notice.seat,
                }),
              ),
        action: {
          type: "swap",
          label: resolve(msg("Swap to {substitute}", { substitute })),
          substitute: notice.substitute,
        },
      };
    }
    const waits =
      notice.seat === null
        ? resolve(msg("No favorite model is free, so this conversation waits."))
        : resolve(msg("No favorite model is free, so {seat} waits.", { seat: notice.seat }));
    return {
      id,
      notice,
      title: limited,
      description: reset === null ? waits : `${waits} ${reset}`,
      action: null,
    };
  });
}
