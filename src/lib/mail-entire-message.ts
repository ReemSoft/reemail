const flights = new Map<string, Promise<unknown>>();

/** One in-flight request per tenant/account/mailbox/UID/UIDVALIDITY identity. */
export function runEntireMessageSingleFlight<T>(
  key: string,
  request: () => Promise<T>,
): Promise<T> {
  const existing = flights.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const flight = request().finally(() => {
    if (flights.get(key) === flight) flights.delete(key);
  });
  flights.set(key, flight);
  return flight;
}

export function samePhysicalMessage(
  current: { id: string; uidValidity?: string } | null,
  incoming: { id: string; uidValidity?: string },
): boolean {
  return current?.id === incoming.id && current.uidValidity === incoming.uidValidity;
}

export function entireMessageFlightCount(): number {
  return flights.size;
}
