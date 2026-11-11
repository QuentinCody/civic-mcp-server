import { afterEach, expect, it, vi } from "vitest";
import { createCivicGqlFetch } from "./code-mode-fetch";

afterEach(() => vi.unstubAllGlobals());
it.each([{ data: { molecularProfile: null } }, { errors: [{ message: "invalid" }] }, { data: { molecularProfile: null }, errors: [{ message: "partial" }] }])("keeps valid GraphQL success/error envelopes unchanged %#", async envelope => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(envelope)));
  vi.stubGlobal("fetch", fetcher);
  expect(await createCivicGqlFetch()("query($id:Int!){molecularProfile(id:$id){id}}", { id: 5 })).toEqual(envelope);
  expect(fetcher).toHaveBeenCalledWith("https://civicdb.org/api/graphql", expect.objectContaining({ method: "POST", redirect: "manual", signal: expect.any(AbortSignal), body: JSON.stringify({ query: "query($id:Int!){molecularProfile(id:$id){id}}", variables: { id: 5 } }), headers: expect.objectContaining({ Accept: "application/vnd.civicdb.v2+json" }) }));
});
it.each([null, [], {}, { data: [] }, { errors: [] }])("rejects malformed GraphQL envelopes %#", async envelope => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(envelope))));
  await expect(createCivicGqlFetch()("{__typename}")).rejects.toThrow();
});
it.each(["<html>unavailable</html>", new Uint8Array([255])])("rejects malformed JSON or UTF-8 %#", async body => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));
  await expect(createCivicGqlFetch()("{__typename}")).rejects.toThrow();
});
it("rejects HTTP failures without treating an error object as results", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response('{"data":{}}', { status: 429 })));
  await expect(createCivicGqlFetch()("{__typename}")).rejects.toThrow("CIViC HTTP 429");
});
it("bounds reads and cancels on overflow", async () => {
  const cancel = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1_000_000)); }, cancel }))));
  await expect(createCivicGqlFetch()("{__typename}")).rejects.toThrow("exceeds 8MB");
  expect(cancel).toHaveBeenCalledOnce();
});
