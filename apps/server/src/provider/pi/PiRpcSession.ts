// Pi RPC is JSONL, not ACP. Split only at LF and strip trailing CR; U+2028/U+2029 are valid JSON data.
/** One decoded stdout record. `type` is always present in the protocol. */
export interface PiRpcRecord {
  readonly type: string;
  readonly [key: string]: unknown;
}

/**
 * Split a rolling buffer into complete JSONL records. Returns the records and
 * the unterminated remainder, which the caller carries into the next chunk.
 */
export function splitJsonLines(buffer: string): {
  readonly lines: ReadonlyArray<string>;
  readonly rest: string;
} {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  const lines: Array<string> = [];
  for (const part of parts) {
    // Accept CRLF input by dropping the carriage return the split left behind.
    const line = part.endsWith("\r") ? part.slice(0, -1) : part;
    if (line.trim().length > 0) lines.push(line);
  }
  return { lines, rest };
}

export function parsePiRpcRecord(line: string): PiRpcRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    return typeof record["type"] === "string" ? (record as unknown as PiRpcRecord) : undefined;
  } catch {
    return undefined;
  }
}
