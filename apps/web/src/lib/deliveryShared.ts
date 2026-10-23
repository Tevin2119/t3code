const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const rows = (value: unknown) =>
  Array.isArray(value)
    ? value.map(record).filter((r): r is Record<string, unknown> => r !== null)
    : [];
const text = (v: unknown) => (typeof v === "string" ? v : "");
const hasId = (v: unknown) => text(v).trim().length > 0;
const hasTaskId = (v: unknown) => /^[A-Za-z0-9_-]+$/.test(text(v));
const number = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
export function parseShared(value: unknown) {
  const root = record(value);
  if (!root) return null;
  return {
    enabled: root.enabled === true,
    connected: root.connected === true,
    machine: text(root.machine),
    problem: text(root.problem),
    boards: rows(root.boards)
      .filter((b) => hasId(b.id))
      .map((b) => {
        const policy = record(b.policy);
        return {
          id: text(b.id),
          title: text(b.title),
          repository: text(b.repository),
          revision: number(b.revision),
          policy: {
            automatic: policy?.automatic === true,
            startOnArrival: policy?.startOnArrival === true,
            machine: text(policy?.machine) || null,
            prefer: text(policy?.prefer) || null,
          },
        };
      }),
    machines: rows(root.machines)
      .filter((m) => hasId(m.id))
      .map((m) => ({ id: text(m.id), name: text(m.name), seen: number(m.seen) })),
    tasks: rows(root.tasks)
      .filter((t) => hasTaskId(t.id) && record(t.summary))
      .map((t) => {
        const summary = record(t.summary);
        return {
          id: text(t.id),
          board: text(t.board),
          owner: text(t.owner),
          moving: text(t.moving),
          title: text(summary?.title),
          lane: text(summary?.lane) || "intake",
          state: text(summary?.state),
          number: number(summary?.number),
        };
      }),
    moves: rows(root.moves)
      .filter((m) => hasId(m.id))
      .map((m) => ({
        id: text(m.id),
        root: text(m.root),
        source: text(m.source),
        destination: text(m.destination),
        state: text(m.state),
      })),
  };
}
export function parseAllocation(value: unknown) {
  const root = record(value);
  return rows(root?.machines)
    .filter((m) => hasId(m.machine))
    .map((m) => ({
      machine: text(m.machine),
      eligible: m.eligible === true,
      reasons: Array.isArray(m.reasons)
        ? m.reasons.filter((r): r is string => typeof r === "string")
        : [],
    }));
}
export function sharedLanes(tasks: NonNullable<ReturnType<typeof parseShared>>["tasks"]) {
  const lanes = new Map<string, typeof tasks>();
  for (const task of tasks) {
    const lane = task.moving ? "moving" : task.lane;
    const group = lanes.get(lane) ?? [];
    group.push(task);
    lanes.set(lane, group);
  }
  return [...lanes].map(([id, cards]) => ({ id, cards }));
}
