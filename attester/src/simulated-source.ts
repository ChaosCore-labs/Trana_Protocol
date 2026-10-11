/**
 * SimulatedSource — scripted arrivals, the required demo backup (CHA-32).
 *
 * Purpose: a demo must never be blocked by API rate limits, region coverage,
 * an expired trial, or the network. Flip the source in config to switch to this.
 *
 * Every arrival produced here is marked `simulated: true` so it can never be
 * mistaken for real carrier data in logs or UI.
 */

import type { Arrival, ArrivalSource } from "./source.ts";

export interface SimulatedArrival {
  /** Terminal-arrival timestamp, unix seconds. */
  actualDelivery: bigint;
  terminalCode?: bigint;
  /** Wall-clock seconds after the process starts to wait before "arriving". */
  afterSeconds?: number;
}

export interface SimulatedSourceOptions {
  arrivals?: Record<string, SimulatedArrival>;
  /** Injectable clock (unix seconds) for tests. Defaults to Date.now()/1000. */
  now?: () => bigint;
  /** Start instant for `afterSeconds` delays. Defaults to first call. */
  startedAt?: bigint;
}

export class SimulatedSource implements ArrivalSource {
  readonly name = "simulated";
  readonly simulated = true;

  private readonly arrivals: Record<string, SimulatedArrival>;
  private readonly now: () => bigint;
  private readonly startedAt: bigint;

  constructor(options: SimulatedSourceOptions = {}) {
    this.arrivals = options.arrivals ?? {};
    this.now = options.now ?? (() => BigInt(Math.floor(Date.now() / 1000)));
    this.startedAt = options.startedAt ?? this.now();
  }

  async fetch(shipmentId: bigint): Promise<Arrival | null> {
    const scripted = this.arrivals[shipmentId.toString()];
    if (!scripted) return null;

    if (scripted.afterSeconds !== undefined) {
      const due = this.startedAt + BigInt(Math.round(scripted.afterSeconds));
      if (this.now() < due) return null;
    }

    return {
      actualDelivery: scripted.actualDelivery,
      terminalCode: scripted.terminalCode ?? 0n,
    };
  }
}