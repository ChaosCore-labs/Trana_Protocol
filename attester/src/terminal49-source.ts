/**
 * Terminal49Source — the real carrier feed (CHA-32).
 *
 * Terminal49 normalizes ocean milestones behind one REST endpoint:
 *
 *   GET https://api.terminal49.com/v2/containers/{id}/transport_events
 *   Authorization: Token <api-key>
 *
 * It is polled, not pushed: `ArrivalSource` is a pull interface and the crank
 * decides when to ask, so no webhook is required (and none exists on the free
 * tier). The same endpoint also returns `estimated.*` events — projections, not
 * facts — which are never attested as an arrival: a guess must not pay out.
 *
 * The SLA event is `container.transport.vessel_arrived` (falling back to
 * `vessel_discharged`), which is the destination-terminal arrival defined in
 * CHA-33.
 */

import type { Arrival, ArrivalSource } from "./source.ts";

const DEFAULT_BASE_URL = "https://api.terminal49.com/v2";

/** Terminal-arrival milestones, in precedence order. */
const ARRIVAL_EVENTS = [
  "container.transport.vessel_arrived",
  "container.transport.vessel_discharged",
] as const;

export interface Terminal49Options {
  apiKey: string;
  /** `shipment_id` (as a decimal string) to Terminal49 container id. */
  containers: Record<string, string>;
  baseUrl?: string;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

interface TransportEvent {
  attributes: {
    event: string;
    timestamp: string | null;
    location_locode: string | null;
  };
}

interface TransportEventsPage {
  data?: TransportEvent[];
  links?: { next?: string | null };
}

/** Pack a UN/LOCODE (up to 5 ASCII chars) into a u64: `USOAK` -> 0x55534f414b. */
export function terminalCodeFromLocode(locode: string): bigint {
  let code = 0n;
  for (const byte of new TextEncoder().encode(locode.slice(0, 5))) {
    code = (code << 8n) | BigInt(byte);
  }
  return code;
}

/**
 * The terminal-arrival event, or null if it has not happened yet.
 *
 * Exact event names are matched, so the `estimated.*` variants (which carry
 * different names) can never be mistaken for a real arrival. Within one event
 * type the earliest timestamp wins.
 */
export function terminalArrival(events: TransportEvent[]): Arrival | null {
  for (const name of ARRIVAL_EVENTS) {
    const stamps = events
      .filter((event) => event.attributes.event === name && event.attributes.timestamp)
      .map((event) => ({
        ms: Date.parse(event.attributes.timestamp as string),
        locode: event.attributes.location_locode,
      }))
      .filter((stamp) => !Number.isNaN(stamp.ms))
      .sort((a, b) => a.ms - b.ms);
    const earliest = stamps[0];
    if (earliest) {
      return {
        actualDelivery: BigInt(Math.floor(earliest.ms / 1000)),
        terminalCode: earliest.locode ? terminalCodeFromLocode(earliest.locode) : 0n,
      };
    }
  }
  return null;
}

/** The next page URL, allowed only if it stays on the configured HTTPS origin. */
export function nextPageUrl(
  next: string | null | undefined,
  current: string,
  baseUrl: string,
): string | null {
  if (!next) return null;
  const resolved = new URL(next, current);
  if (resolved.protocol !== "https:" || resolved.origin !== new URL(baseUrl).origin) {
    throw new Error("Terminal49 pagination must stay on the configured HTTPS origin");
  }
  return resolved.href;
}

export class Terminal49Source implements ArrivalSource {
  readonly name = "terminal49";

  private readonly apiKey: string;
  private readonly containers: Record<string, string>;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: Terminal49Options) {
    this.apiKey = options.apiKey;
    this.containers = options.containers;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async fetch(shipmentId: bigint): Promise<Arrival | null> {
    const containerId = this.containers[shipmentId.toString()];
    if (!containerId) return null;
    return terminalArrival(await this.transportEvents(containerId));
  }

  /** Every transport event for a container, following `links.next`. */
  private async transportEvents(containerId: string): Promise<TransportEvent[]> {
    const events: TransportEvent[] = [];
    let url: string | null = `${this.baseUrl}/containers/${containerId}/transport_events`;

    while (url) {
      const response = await this.fetchImpl(url, {
        headers: { Authorization: `Token ${this.apiKey}` },
      });
      if (!response.ok) {
        throw new Error(`Terminal49 returned ${response.status} for container ${containerId}`);
      }
      const page = (await response.json()) as TransportEventsPage;
      events.push(...(page.data ?? []));
      // The credential rides on every request, so a `links.next` must not be
      // followed off the configured origin.
      url = nextPageUrl(page.links?.next, url, this.baseUrl);
    }

    return events;
  }
}
