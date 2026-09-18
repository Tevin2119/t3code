import { expect, it } from "@effect/vitest";

import { parsePiRpcRecord, splitJsonLines } from "./PiRpcSession.ts";

it("emits only the records terminated by a newline and carries the rest forward", () => {
  const first = splitJsonLines('{"type":"agent_start"}\n{"type":"turn_s');

  expect(first.lines).toEqual(['{"type":"agent_start"}']);
  expect(first.rest).toBe('{"type":"turn_s');

  const second = splitJsonLines(`${first.rest}tart"}\n`);
  expect(second.lines).toEqual(['{"type":"turn_start"}']);
  expect(second.rest).toBe("");
});

it("accepts CRLF input by dropping the carriage return", () => {
  expect(splitJsonLines('{"type":"agent_start"}\r\n').lines).toEqual(['{"type":"agent_start"}']);
});

/**
 * pi's RPC protocol is strict JSONL: `\n` is the only record separator. A
 * reader that also split on the Unicode line separators would corrupt any
 * record containing one inside a JSON string.
 */
it("does not split on U+2028 or U+2029 inside a record", () => {
  const record = `{"type":"message_update","delta":"a b c"}`;
  const { lines, rest } = splitJsonLines(`${record}\n`);

  expect(lines).toEqual([record]);
  expect(rest).toBe("");
  expect(parsePiRpcRecord(lines[0] ?? "")).toMatchObject({ delta: "a b c" });
});

it("ignores blank lines between records", () => {
  expect(splitJsonLines('{"type":"a"}\n\n   \n{"type":"b"}\n').lines).toEqual([
    '{"type":"a"}',
    '{"type":"b"}',
  ]);
});

it("rejects records that are not JSON objects carrying a string type", () => {
  expect(parsePiRpcRecord("not json")).toBeUndefined();
  expect(parsePiRpcRecord("[1,2,3]")).toBeUndefined();
  expect(parsePiRpcRecord("null")).toBeUndefined();
  expect(parsePiRpcRecord('{"noType":true}')).toBeUndefined();
  expect(parsePiRpcRecord('{"type":42}')).toBeUndefined();
});
