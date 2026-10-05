export function matchesEnvironmentSearch(
  environment: { readonly label: string; readonly displayUrl: string | null },
  query: string,
): boolean {
  const searchable = `${environment.label} ${environment.displayUrl ?? ""}`.toLowerCase();
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .every((word) => searchable.includes(word));
}
