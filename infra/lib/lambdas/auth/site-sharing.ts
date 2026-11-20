import { GetCommand, PutCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { SharingDirections } from "../../../insights";

type Site = { did: string; handle: string };
type Session = { email: string; siteHost?: string };
type Context = { ddb: DynamoDBDocumentClient; table?: string; domain: string; apexDid: string; hosts: ReadonlySet<string> };

export const defaultSharing: SharingDirections = { outgoing: true, incoming: true };

export function sharingHosts(domain: string, tenantHosts = "") {
  return new Set([domain, ...tenantHosts.split(",").map(host => host.trim()).filter(Boolean)]);
}

export function workspaceHost(session: Session, header: string | undefined, context: Context) {
  const host = header ?? context.domain;
  if (!context.hosts.has(host) || (session.siteHost && session.siteHost !== host)) return;
  return host;
}

export function publishingHost({ did, handle }: Site, context: Context) {
  return did === context.apexDid ? context.domain : context.hosts.has(handle) ? handle : undefined;
}

const policyKey = (host: string, peer: string) => ({ pk: `SITE_SHARING#${host}`, sk: peer });

export async function readSharing(context: Context, host: string, peer: string): Promise<SharingDirections> {
  if (!context.table) return defaultSharing;
  const { Item } = await context.ddb.send(new GetCommand({
    TableName: context.table, Key: policyKey(host, peer), ConsistentRead: true,
  }));
  return { outgoing: Item?.outgoing !== false, incoming: Item?.incoming !== false };
}

export async function saveSharing(context: Context, host: string, peer: string, allowed: SharingDirections) {
  if (!context.table) throw new Error("Site sharing table is unavailable");
  await context.ddb.send(new PutCommand({
    TableName: context.table,
    Item: { ...policyKey(host, peer), outgoing: allowed.outgoing, incoming: allowed.incoming },
  }));
}

export async function canShare(context: Context, source: string | undefined, destination: string | undefined) {
  // An identity without a deployed website has no cross-site settings.
  if (!context.table || !source || !destination || source === destination) return true;
  const [from, to] = await Promise.all([
    readSharing(context, source, destination), readSharing(context, destination, source),
  ]);
  return from.outgoing && to.incoming;
}

export async function workspaceSites<T extends Site>(context: Context, sites: T[], host: string) {
  const candidates = await Promise.all(sites.map(async site =>
    await canShare(context, publishingHost(site, context), host) ? site : undefined,
  ));
  return candidates.filter((site): site is Awaited<T> => site !== undefined);
}
