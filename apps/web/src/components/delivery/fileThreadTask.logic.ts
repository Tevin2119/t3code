/**
 * Whether "File a task from this thread" is offered: delivery is on in the thread's environment,
 * the thread is not one the server owns (a board task's own, or an engine intake), and this
 * connection may file. Every entry point asks this.
 */
export function fileThreadTaskOffered(input: {
  readonly deliveryEnabled: boolean;
  readonly serverOwned: boolean;
  readonly permitted: boolean;
}): boolean {
  return input.deliveryEnabled && input.permitted && !input.serverOwned;
}
