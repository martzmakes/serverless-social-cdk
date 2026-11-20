import { expect, it, vi } from "vitest";
import { processEvent, type Ports } from "../lib/lambdas/pds/longform-renderer";
import type { IndexItem } from "../lib/lambdas/pds/longform-index";

it("retries derived feed writes before recording a longform deletion as complete", async () => {
  const published: IndexItem = {
    rkey: "article", currentSlug: "removed", priorSlugs: [], status: "published", cid: "cid",
    title: "Removed", excerpt: "", tags: [], createdAt: "2026-10-01T00:00:00.000Z",
    publishedAt: "2026-10-01T00:00:00.000Z", syndication: {},
  };
  const putIndex = vi.fn(async () => {});
  const putObject = vi.fn(async () => {}).mockRejectedValueOnce(new Error("S3 unavailable"));
  const ports: Ports = {
    getIndex: async () => published, listIndex: async () => [published],
    getRecord: async () => undefined, putObject, putIndex,
    deleteObject: async () => {}, ownerOf: async () => undefined,
    kvsPut: async () => {}, kvsDel: async () => {},
    syndicate: async () => ({ uri: "", cid: "" }), deleteSyndication: async () => {},
  };
  const event = { rkey: "article", op: "delete" } as const;
  const site = { origin: "https://social.example.com", siteName: "Social", author: "social.example.com" };
  await expect(processEvent(event, ports, site)).rejects.toThrow("S3 unavailable");
  expect(putIndex).not.toHaveBeenCalled();
  await processEvent(event, ports, site);
  expect(putObject.mock.calls).toHaveLength(4);
  expect(putIndex).toHaveBeenCalledWith(expect.objectContaining({ status: "deleted" }), expect.anything());
});
