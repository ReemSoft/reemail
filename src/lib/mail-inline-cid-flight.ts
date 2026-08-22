interface SharedInlineCidFlight<T> {
  promise: Promise<T>;
  controller: AbortController;
  subscribers: number;
}

export interface InlineCidFlightLease<T> {
  promise: Promise<T>;
  release: () => void;
}

const flights = new Map<string, SharedInlineCidFlight<unknown>>();

/**
 * Reference-counted browser single-flight. The last viewer leaving a physical
 * CID request aborts it, so obsolete image work cannot hold the media queue
 * after navigation.
 */
export function acquireInlineCidFlight<T>(
  key: string,
  start: (signal: AbortSignal) => Promise<T>,
): InlineCidFlightLease<T> {
  let flight = flights.get(key) as SharedInlineCidFlight<T> | undefined;
  if (!flight) {
    const controller = new AbortController();
    const created: SharedInlineCidFlight<T> = {
      controller,
      subscribers: 0,
      promise: Promise.resolve().then(() => start(controller.signal)),
    };
    created.promise = created.promise.finally(() => {
      if (flights.get(key) === created) flights.delete(key);
    });
    flight = created;
    flights.set(key, created as SharedInlineCidFlight<unknown>);
  }
  flight.subscribers += 1;
  let released = false;
  return {
    promise: flight.promise,
    release: () => {
      if (released) return;
      released = true;
      flight!.subscribers = Math.max(0, flight!.subscribers - 1);
      if (flight!.subscribers === 0 && flights.get(key) === flight) {
        flights.delete(key);
        flight!.controller.abort();
      }
    },
  };
}

export function abortInlineCidFlights(): void {
  for (const flight of flights.values()) flight.controller.abort();
  flights.clear();
}

export function inlineCidFlightCountForTests(): number {
  return flights.size;
}

export function resetInlineCidFlightsForTests(): void {
  abortInlineCidFlights();
}
