import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  Terminal49Source,
  terminalArrival,
  terminalCodeFromLocode,
} from "../src/terminal49-source.ts";

const CONTAINER = "eeafd337-72b5-4e5c-87cb-9ef83fa99cf4";
const BASE = "https://api.terminal49.com/v2";

const event = (name: string, timestamp: string | null, locode: string | null = "USOAK") => ({
  attributes: { event: name, timestamp, location_locode: locode },
});

const page = (data: unknown[], next?: string) => ({
  data,
  links: next === undefined ? {} : { next },
});

const stubFetch = (responses: Record<string, unknown>) =>
  (async (url: string | URL | Request) => {
    const body = responses[String(url)];
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

test("terminal code packs a UN/LOCODE into a u64", () => {
  assert.equal(terminalCodeFromLocode("USOAK"), 0x55534f414bn);
  assert.equal(terminalCodeFromLocode(""), 0n);
});

test("terminalArrival takes the earliest actual arrival", () => {
  const arrival = terminalArrival([
    event("container.transport.vessel_discharged", "2020-04-13T00:00:00Z"),
    event("container.transport.vessel_arrived", "2020-04-13T01:24:00Z"),
    event("container.transport.vessel_arrived", "2020-04-13T02:00:00Z", "USLAX"),
  ]);
  assert.equal(arrival?.actualDelivery, BigInt(Date.parse("2020-04-13T01:24:00Z") / 1000));
  assert.equal(arrival?.terminalCode, terminalCodeFromLocode("USOAK"));
});

test("terminalArrival ignores estimates and null timestamps", () => {
  assert.equal(
    terminalArrival([
      event("container.transport.estimated.vessel_arrived", "2020-04-13T01:24:00Z"),
      event("container.transport.vessel_arrived", null),
    ]),
    null,
  );
});

test("terminalArrival falls back to discharge when arrival is absent", () => {
  const arrival = terminalArrival([
    event("container.transport.full_out", "2020-04-14T00:00:00Z"),
    event("container.transport.vessel_discharged", "2020-04-13T00:00:00Z"),
  ]);
  assert.equal(arrival?.actualDelivery, BigInt(Date.parse("2020-04-13T00:00:00Z") / 1000));
});

test("fetch returns null for an unmapped shipment without calling the API", async () => {
  let calls = 0;
  const source = new Terminal49Source({
    apiKey: "k",
    containers: { "27": CONTAINER },
    baseUrl: BASE,
    fetchImpl: (async () => {
      calls += 1;
      throw new Error("should not be called");
    }) as unknown as typeof fetch,
  });

  assert.equal(await source.fetch(99n), null);
  assert.equal(calls, 0);
});

test("fetch authenticates, reads the events and maps the arrival", async () => {
  const seen: { url: string; auth?: string }[] = [];
  const source = new Terminal49Source({
    apiKey: "secret",
    containers: { "27": CONTAINER },
    baseUrl: BASE,
    fetchImpl: (async (url: string, init?: { headers?: Record<string, string> }) => {
      seen.push({ url: String(url), auth: init?.headers?.Authorization });
      return new Response(
        JSON.stringify(
          page([
            event("container.transport.full_out", "2020-04-14T00:00:00Z"),
            event("container.transport.vessel_arrived", "2020-04-13T01:24:00Z"),
          ]),
        ),
        { status: 200 },
      );
    }) as unknown as typeof fetch,
  });

  const arrival = await source.fetch(27n);
  assert.equal(seen[0]?.url, `${BASE}/containers/${CONTAINER}/transport_events`);
  assert.equal(seen[0]?.auth, "Token secret");
  assert.equal(arrival?.actualDelivery, BigInt(Date.parse("2020-04-13T01:24:00Z") / 1000));
});

test("fetch follows pagination until links.next is absent", async () => {
  const first = `${BASE}/containers/${CONTAINER}/transport_events`;
  const second = `${first}?page[number]=2`;
  const requested: string[] = [];
  const source = new Terminal49Source({
    apiKey: "k",
    containers: { "27": CONTAINER },
    baseUrl: BASE,
    fetchImpl: (async (url: string) => {
      requested.push(String(url));
      const body =
        String(url) === first
          ? page([event("container.transport.full_out", "2020-04-14T00:00:00Z")], second)
          : page([event("container.transport.vessel_arrived", "2020-04-13T01:24:00Z")]);
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch,
  });

  const arrival = await source.fetch(27n);
  assert.equal(arrival?.actualDelivery, BigInt(Date.parse("2020-04-13T01:24:00Z") / 1000));
  assert.deepEqual(requested, [first, second]);
});

test("fetch refuses a next page that leaves the configured HTTPS origin", async () => {
  const first = `${BASE}/containers/${CONTAINER}/transport_events`;
  const requested: string[] = [];
  const source = new Terminal49Source({
    apiKey: "secret",
    containers: { "27": CONTAINER },
    baseUrl: BASE,
    fetchImpl: (async (url: string) => {
      requested.push(String(url));
      const body = page(
        [event("container.transport.full_out", "2020-04-14T00:00:00Z")],
        "https://evil.example/containers/next",
      );
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch,
  });

  await assert.rejects(() => source.fetch(27n), /HTTPS origin/);
  // The credential never left the configured host.
  assert.deepEqual(requested, [first]);
});

test("fetch surfaces a non-ok response instead of inventing an arrival", async () => {
  const source = new Terminal49Source({
    apiKey: "k",
    containers: { "27": CONTAINER },
    baseUrl: BASE,
    fetchImpl: stubFetch({}),
  });

  await assert.rejects(() => source.fetch(27n), /Terminal49 returned 404/);
});
