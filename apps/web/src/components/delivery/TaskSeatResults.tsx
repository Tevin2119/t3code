import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { useGT } from "gt-react";

import { isWebUrl } from "../../browser/webUrl";
import { repeatKeys, type TaskQaReceipt, type TaskSeatHandoff } from "../../lib/delivery";
import { Badge } from "../ui/badge";
import { Row } from "./taskParts";

export function TaskSeatHandoffs(props: { readonly handoffs: ReadonlyArray<TaskSeatHandoff> }) {
  const gt = useGT();
  if (props.handoffs.length === 0) return null;
  const stages = { build: gt("Build"), review: gt("Review"), qa: gt("QA") };
  return (
    <section>
      <h3 className="pb-1 text-xs font-medium text-muted-foreground">{gt("Seat hand-offs")}</h3>
      {props.handoffs.map(({ stage, seat, state, reason }) => (
        <Row key={stage} label={stages[stage]}>
          {state === "handed" ? gt("Handed to {seat}", { seat }) : null}
          {state === "delivered" ? gt("Delivered by {seat}", { seat }) : null}
          {state === "fallen-back" ? (
            <span className="wrap-anywhere">
              {reason
                ? gt("Fell back to the pipeline ({reason})", { reason })
                : gt("Fell back to the pipeline")}
            </span>
          ) : null}
        </Row>
      ))}
    </section>
  );
}

function EvidenceRef({ reference }: { readonly reference: string }) {
  return isWebUrl(reference) ? (
    <a href={reference} target="_blank" rel="noreferrer" className="text-primary underline">
      {reference}
    </a>
  ) : (
    reference
  );
}

function QaReceipt(props: { readonly receipt: TaskQaReceipt; readonly acceptanceHash: string }) {
  const gt = useGT();
  const { acceptance, evidence, independenceChecked, model, modelSource, seat, verdict } =
    props.receipt;
  const verdicts = { pass: gt("Pass"), fail: gt("Fail"), blocked: gt("Blocked") };
  const variants = { pass: "success", fail: "destructive", blocked: "warning" } as const;
  const sources = { attested: gt("Attested"), picked: gt("Picked"), requested: gt("Requested") };
  return (
    <li className="flex min-w-0 flex-col gap-1 rounded-md border border-border px-2 py-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium wrap-anywhere">{seat}</span>
        <Badge variant={variants[verdict]}>{verdicts[verdict]}</Badge>
      </div>
      {model || modelSource ? (
        <p className="wrap-anywhere text-muted-foreground">
          {model && modelSource
            ? gt("{model} ({source})", { model, source: sources[modelSource] })
            : (model ?? (modelSource && sources[modelSource]))}
        </p>
      ) : null}
      {independenceChecked !== true ? (
        <p className="text-warning-foreground">{gt("Not independence-checked")}</p>
      ) : null}
      {acceptance.hash && acceptance.hash.toLowerCase() !== props.acceptanceHash ? (
        <p className="text-warning-foreground">{gt("Filed for earlier acceptance text")}</p>
      ) : null}
      {evidence.length > 0 ? (
        <ul
          className="list-disc pl-4 wrap-anywhere text-muted-foreground"
          aria-label={gt("Evidence")}
        >
          {repeatKeys(evidence).map((key, index) => (
            <li key={key}>
              <EvidenceRef reference={evidence[index]!} />
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function TaskAcceptanceReceipts(props: {
  readonly acceptance: ReadonlyArray<string>;
  readonly receipts: ReadonlyArray<TaskQaReceipt>;
}) {
  const gt = useGT();
  if (props.acceptance.length === 0) return null;
  const byItem = new Map<number, TaskQaReceipt[]>();
  for (const receipt of props.receipts) {
    const index = receipt.acceptance.index;
    const group = byItem.get(index);
    if (group) group.push(receipt);
    else byItem.set(index, [receipt]);
  }
  return (
    <section data-task-section="acceptance">
      <h3 className="pb-1 text-xs font-medium text-muted-foreground">
        {gt("Acceptance criteria")}
      </h3>
      <ol className="flex list-decimal flex-col gap-3 pl-5 text-sm">
        {repeatKeys(props.acceptance).map((key, index) => {
          const value = props.acceptance[index]!;
          const receipts = byItem.get(index);
          const hash = receipts?.some((receipt) => receipt.acceptance.hash)
            ? bytesToHex(sha256(new TextEncoder().encode(value)).subarray(0, 8))
            : "";
          return (
            <li key={key} className="wrap-anywhere">
              {value}
              {receipts ? (
                <ul className="mt-1 flex flex-col gap-1">
                  {receipts.map((receipt) => (
                    <QaReceipt key={receipt.seat} receipt={receipt} acceptanceHash={hash} />
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">{gt("No receipt")}</p>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
