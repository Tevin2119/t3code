export const glassRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export const glassRows = (value: unknown): Array<Record<string, unknown>> =>
  Array.isArray(value) ? value.map(glassRecord) : [];
export const glassText = (value: unknown): string => (typeof value === "string" ? value : "");

/** An old or partial receipt cannot turn the currently displayed run green. */
export function glassRunState(value: unknown, expectedId: string) {
  const body = glassRecord(value);
  const job = glassRecord(body.job);
  const report = glassRecord(body.report);
  const verification = glassRecord(body.verification);
  if (!expectedId || job.id !== expectedId) return "not read";
  if (job.status === "running") return "running";
  if (job.status === "checks-passed" && report.runId === expectedId && verification.ok === true)
    return verification.assertionEvidence === true ? "tests passed" : "commands passed";
  if (job.status === "checks-passed") return "stale or unverified";
  return glassText(job.status) || "incomplete";
}
