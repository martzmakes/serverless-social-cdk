// MCP server Lambda — JSON-RPC 2.0 over HTTP POST (Streamable HTTP transport).
// Auth: OAuth access token scoped to the MCP resource.
//
// Spec: https://modelcontextprotocol.io/specification
//
// Where to extend
// ---------------
// 1. Add tools to the TOOLS array (define schema + description).
// 2. Wire each tool name in the callTool() switch to its handler.
// 3. (Optional) Pair a tool with a widget by setting `_meta: widgetUiMeta(uri)`
//    on its TOOL definition AND adding the corresponding HTML to widgets.ts.
//
// Delete this file (and the rest of the MCP/OAuth block in infra-stack.ts +
// app/src/hooks/useMcp.ts) if your project doesn't expose an MCP server.

import { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  GetCommand,
  DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { READ_SCOPE, WRITE_SCOPE, mcpResource, verifyMcpToken } from "./auth";
import {
  listResources,
  readResource,
  UI_RESOURCES as UI_RESOURCES_MAP,
} from "./widgets";
import { listAccountsTool } from "./tools/list-accounts";
import {
  listPostEngagementTool,
  type ListPostEngagementInput,
} from "./tools/post-engagement";
import {
  getEngagementTrendsTool,
  type EngagementTrendsInput,
} from "./tools/engagement-trends";
import { getPageViewsTool, type PageViewsInput } from "./tools/page-views";
import { getSiteAnalyticsTool, type SiteOverviewInput } from "./tools/site-overview";
import { createPostTool, type CreatePostInput } from "./tools/create-post";
import {
  createLongformTool,
  type CreateLongformInput,
} from "./tools/create-longform";
import {
  deleteRecordTool,
  type DeleteRecordInput,
} from "./tools/delete-record";
import { McpToolError } from "./tools/lib/mcp-tool-error";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const USERS_TABLE = process.env.USERS_TABLE!;
const PROJECT_SLUG = process.env.PROJECT_SLUG!;
const DOMAIN = process.env.DOMAIN!;
const MCP_PUBLIC_BASE = process.env.MCP_PUBLIC_BASE || `https://${DOMAIN}`;

const PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_VERSIONS = new Set([PROTOCOL_VERSION, "2025-06-18"]);
const RESOURCE = mcpResource(MCP_PUBLIC_BASE);
const RESOURCE_METADATA = new URL("/.well-known/oauth-protected-resource/mcp", RESOURCE).href;
const ALLOWED_ORIGINS = new Set([
  new URL(RESOURCE).origin,
  ...(process.env.MCP_ALLOWED_ORIGINS ?? "").split(",").map(value => value.trim()).filter(Boolean),
]);
const SERVER_NAME = PROJECT_SLUG;
const SERVER_VERSION = "0.1.0";

// Helper to attach widget metadata to a tool definition. The pairing tells
// Claude to iframe the matching ui:// resource alongside the tool result.
function widgetUiMeta(resourceUri: string) {
  // Tool _meta carries ONLY resourceUri (modern nested + legacy flat key
  // for older-host compat per @modelcontextprotocol/ext-apps registerAppTool).
  // csp/permissions/domain belong on the RESOURCE (resources/read _meta.ui
  // via DEFAULT_META in widgets.ts) — hosts log "declares _meta.ui.csp/
  // permissions, which is ignored" if set here.
  return {
    ui: { resourceUri },
    "ui/resourceUri": resourceUri,
  };
}

// ---------------------------------------------------------------------------
// Tool catalog — Spec #6 domain tools
// ---------------------------------------------------------------------------

const WRITE_TOOLS = new Set(["create_post", "create_longform", "delete_record"]);

const TOOLS = [
  {
    name: "list_accounts",
    description:
      "Lists the AT-Proto accounts the signed-in user can post from. Returns " +
      "{did, handle, role} for each. Call this first to discover valid 'account' " +
      "values for create_post / create_longform / delete_record.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_post",
    description:
      "Creates a short-form post (app.bsky.feed.post) on the specified account. " +
      "Takes an explicit 'account' (DID or handle from list_accounts) so the model " +
      "picks intentionally. Returns {uri, cid}. Optional reply_to + embed.images " +
      "(base64-encoded, max ~7.5MB after decode).",
    inputSchema: {
      type: "object",
      required: ["account", "text"],
      properties: {
        account: {
          type: "string",
          description: "DID or handle from list_accounts",
        },
        text: { type: "string", description: "Post body (UTF-8)" },
        reply_to: {
          type: "object",
          required: ["root_uri", "root_cid", "parent_uri", "parent_cid"],
          properties: {
            root_uri: { type: "string" },
            root_cid: { type: "string" },
            parent_uri: { type: "string" },
            parent_cid: { type: "string" },
          },
        },
        embed: {
          type: "object",
          properties: {
            images: {
              type: "array",
              items: {
                type: "object",
                required: ["bytes_b64", "mime", "alt"],
                properties: {
                  bytes_b64: {
                    type: "string",
                    description:
                      "Base64-encoded image bytes; max ~7.5MB after decode",
                  },
                  mime: {
                    type: "string",
                    enum: ["image/jpeg", "image/png", "image/webp"],
                  },
                  alt: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
  },
  {
    name: "create_longform",
    description:
      "Creates a long-form article (social.serverless.longform) on the specified " +
      "account. Returns {uri, cid, canonical_url, render_pending:true}. Static HTML " +
      "renders async via DDB-stream consumer; canonical_url may 404 briefly until " +
      "render completes. NOTE: 'syndicate' defaults to false — set it true ONLY to " +
      "intentionally cross-post a Bluesky link to the account's followers.",
    inputSchema: {
      type: "object",
      required: ["account", "title", "content"],
      properties: {
        account: { type: "string" },
        title: { type: "string" },
        content: {
          type: "string",
          description: "Markdown body of the article",
        },
        slug: {
          type: "string",
          description: "Optional; auto-generated from title if omitted",
        },
        excerpt: {
          type: "string",
          description: "Optional short summary (meta description + teaser)",
        },
        tags: { type: "array", items: { type: "string" } },
        syndicate: {
          type: "boolean",
          description:
            "Default false. True = POSSE a Bluesky link post to the account's followers.",
        },
        syndication_teaser: {
          type: "string",
          description: "Optional text for the syndicated Bluesky post",
        },
        cover: {
          type: "object",
          required: ["bytes_b64", "mime", "alt"],
          properties: {
            bytes_b64: { type: "string" },
            mime: {
              type: "string",
              enum: ["image/jpeg", "image/png", "image/webp"],
            },
            alt: { type: "string" },
          },
        },
      },
    },
  },
  {
    name: "delete_record",
    description:
      "Deletes a record from one of the caller's approved accounts. Use the 'uri' " +
      "returned by create_post / create_longform. The 'account' arg must match the " +
      "URI's DID — cross-DID URIs are rejected (uri_mismatch).",
    inputSchema: {
      type: "object",
      required: ["account", "uri"],
      properties: {
        account: { type: "string" },
        uri: {
          type: "string",
          description: "at://<did>/<collection>/<rkey>",
        },
      },
    },
  },
  {
    name: "list_post_engagement",
    description:
      "Returns live engagement (likes/reposts/replies) for the posts of one of " +
      "the caller's approved accounts, plus a totals summary. Takes an explicit " +
      "'account' (DID or handle from list_accounts) and an optional 'limit' " +
      "(newest-first). Read-only — counts come from Bluesky's public AppView, so " +
      "they're bsky-only (not ActivityPub) and are point-in-time, not trends.",
    inputSchema: {
      type: "object",
      required: ["account"],
      properties: {
        account: {
          type: "string",
          description: "DID or handle from list_accounts",
        },
        limit: {
          type: "number",
          description: "Optional cap on posts (newest-first); omit for all",
        },
      },
    },
  },
  {
    name: "get_engagement_trends",
    description:
      "Engagement OVER TIME for one of the caller's approved accounts, from daily " +
      "snapshots. With 'uri' (a post AT-URI) → that post's like/repost/reply series " +
      "+ first→last delta. Without 'uri' → the account's follower/follow/post series " +
      "+ delta. Optional inclusive 'since'/'until' (YYYY-MM-DD) window. Series are " +
      "empty until the daily capture has run for a few days.",
    inputSchema: {
      type: "object",
      required: ["account"],
      properties: {
        account: {
          type: "string",
          description: "DID or handle from list_accounts",
        },
        uri: {
          type: "string",
          description: "Optional post AT-URI; omit for account-level trends",
        },
        since: { type: "string", description: "Inclusive YYYY-MM-DD" },
        until: { type: "string", description: "Inclusive YYYY-MM-DD" },
      },
    },
  },
  {
    name: "get_page_views",
    description:
      "Page views for the published posts of one of the caller's approved " +
      "accounts, from server-side CloudFront logs (no tracker). Per post: human " +
      "views, bot views, human referrers, and a daily breakdown over the last " +
      "'days' UTC days (default 30, max 365; 1 = today only). Optional 'slug' " +
      "narrows to one post. Only slugs in the account's longform index count.",
    inputSchema: {
      type: "object",
      required: ["account"],
      properties: {
        account: {
          type: "string",
          description: "DID or handle from list_accounts",
        },
        slug: { type: "string", description: "Optional single post slug" },
        days: { type: "number", description: "Window in days (1-365, default 30)" },
      },
    },
  },
  {
    name: "get_site_analytics",
    description:
      "Site-wide analytics for one of the caller's approved accounts over the last 7, 30 or 90 " +
      "days (default 30) compared with the previous window: human page views for articles, the " +
      "home page and short-post pages, daily totals, top articles, top short posts with their " +
      "Bluesky engagement change, traffic sources, devices, approximate reader countries and " +
      "cities (from the serving CloudFront edge), top referrer domains, automated requests " +
      "filtered out, and Bluesky follower change. Server-side logs only, no tracker.",
    inputSchema: {
      type: "object",
      required: ["account"],
      properties: {
        account: { type: "string", description: "DID or handle from list_accounts" },
        days: { type: "number", enum: [7, 30, 90], description: "Window in days (default 30)" },
      },
    },
  },
  {
    name: "whoami",
    description:
      "Returns the signed-in user's email + accounts they can post from (same as " +
      "list_accounts) + timestamps. Pairs with the user-card widget.",
    inputSchema: { type: "object", properties: {} },
    _meta: widgetUiMeta(`ui://${PROJECT_SLUG}/user-card`),
  },
].map(tool => ({
  ...tool,
  annotations: {
    readOnlyHint: !WRITE_TOOLS.has(tool.name),
    ...(WRITE_TOOLS.has(tool.name) ? {
      destructiveHint: tool.name === "delete_record",
      idempotentHint: false,
    } : {}),
    openWorldHint: WRITE_TOOLS.has(tool.name) || tool.name === "list_post_engagement",
  },
}));

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function whoamiTool(email: string) {
  const res = await ddb.send(
    new GetCommand({ TableName: USERS_TABLE, Key: { email } })
  );
  const user = res.Item || {};
  const { accounts } = await listAccountsTool(email);
  return {
    email,
    accounts,
    ownedEntitlements: user.ownedEntitlements || [],
    createdAt: user.createdAt ?? null,
    lastLoginAt: user.lastLoginAt ?? null,
  };
}

type ToolContentBlock = { type: "text"; text: string };

type ToolCallResult = {
  content: ToolContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
};

async function callTool(
  email: string,
  name: string,
  args: Record<string, unknown>
): Promise<ToolCallResult> {
  try {
    switch (name) {
      case "list_accounts": {
        const result = await listAccountsTool(email);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent: result,
        };
      }
      case "create_post": {
        const result = await createPostTool(
          email,
          args as unknown as CreatePostInput
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent: result,
        };
      }
      case "create_longform": {
        const result = await createLongformTool(
          email,
          args as unknown as CreateLongformInput
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent: result,
        };
      }
      case "delete_record": {
        const result = await deleteRecordTool(
          email,
          args as unknown as DeleteRecordInput
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent: result,
        };
      }
      case "list_post_engagement": {
        const result = await listPostEngagementTool(
          email,
          args as unknown as ListPostEngagementInput
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent: result,
        };
      }
      case "get_engagement_trends": {
        const result = await getEngagementTrendsTool(
          email,
          args as unknown as EngagementTrendsInput
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent: result,
        };
      }
      case "get_page_views": {
        const result = await getPageViewsTool(
          email,
          args as unknown as PageViewsInput
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent: result,
        };
      }
      case "get_site_analytics": {
        const result = await getSiteAnalyticsTool(email, args as unknown as SiteOverviewInput);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent: result,
        };
      }
      case "whoami": {
        const result = await whoamiTool(email);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent: result,
        };
      }
      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (e) {
    if (e instanceof McpToolError) {
      const err = { error: e.code, detail: e.detail ?? null };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(err) }],
        structuredContent: err,
        isError: true,
      };
    }
    throw e; // unexpected — let it surface as a JSON-RPC error
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC types & helpers
// ---------------------------------------------------------------------------

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

function ok(id: JsonRpcRequest["id"], result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function rpcErr(
  id: JsonRpcRequest["id"],
  code: number,
  message: string,
  data?: unknown
): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, data } };
}

function responseHeaders(): Record<string, string> {
  return {
    "cache-control": "no-store",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers":
      "authorization,content-type,mcp-protocol-version",
    "access-control-expose-headers": "www-authenticate",
  };
}

function httpJson(
  statusCode: number,
  body: unknown,
  extraHeaders: Record<string, string> = {}
) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
      ...responseHeaders(),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

function httpNoContent(statusCode: number) {
  return { statusCode, headers: responseHeaders(), body: "" };
}

// ---------------------------------------------------------------------------
// MCP method dispatch
// ---------------------------------------------------------------------------

async function dispatch(
  email: string,
  canWrite: boolean,
  req: JsonRpcRequest
): Promise<JsonRpcResponse | null> {
  // Notifications are acknowledged by the HTTP handler without side effects.

  const id = req.id ?? null;

  try {
    switch (req.method) {
      case "initialize": {
        const offered = (req.params as { protocolVersion?: string } | undefined)?.protocolVersion;
        return ok(id, {
          protocolVersion: offered && SUPPORTED_VERSIONS.has(offered) ? offered : PROTOCOL_VERSION,
          capabilities: {
            tools: { listChanged: false },
            resources: { listChanged: false },
            // Declare MCP Apps extension support so Claude knows it can
            // render ui:// resource widgets inline with tool results.
            extensions: {
              "io.modelcontextprotocol/ui": {
                mimeTypes: ["text/html;profile=mcp-app"],
              },
            },
          },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        });
      }

      case "ping":
        return ok(id, {});

      case "tools/list":
        return ok(id, { tools: TOOLS.filter(tool => canWrite || !WRITE_TOOLS.has(tool.name)) });

      case "resources/list":
        return ok(id, { resources: listResources() });

      case "resources/read": {
        const uri = (req.params as { uri?: string } | undefined)?.uri;
        if (!uri) return rpcErr(id, -32602, "Missing uri");
        const r = readResource(uri);
        if (!r) return rpcErr(id, -32002, `Resource not found: ${uri}`);
        return ok(id, r);
      }

      case "resources/templates/list":
        return ok(id, { resourceTemplates: [] });

      case "tools/call": {
        const params = (req.params || {}) as {
          name?: string;
          arguments?: Record<string, unknown>;
        };
        const name = params.name;
        if (!name) return rpcErr(id, -32602, "Missing tool name");
        try {
          const result = await callTool(email, name, params.arguments || {});
          return ok(id, result);
        } catch (toolErr) {
          // Unexpected error (not McpToolError — those are caught inside callTool).
          const message =
            toolErr instanceof Error ? toolErr.message : String(toolErr);
          return ok(id, {
            content: [{ type: "text", text: `Error: ${message}` }],
            isError: true,
          });
        }
      }

      default:
        return rpcErr(id, -32601, `Method not found: ${req.method}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return rpcErr(id, -32603, message);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function authenticate(authHeader: string | undefined) {
  const match = /^Bearer (\S+)$/i.exec(authHeader ?? "");
  if (!match) return;
  return verifyMcpToken(match[1], RESOURCE).catch(() => undefined);
}

function serveWidgetHtml(widgetPath: string) {
  const uri = `ui://${PROJECT_SLUG}/${widgetPath}`;
  const r = UI_RESOURCES_MAP[uri];
  if (!r) {
    return {
      statusCode: 404,
      headers: { "content-type": "application/json", ...responseHeaders() },
      body: JSON.stringify({ error: "not_found", uri }),
    };
  }
  return {
    statusCode: 200,
    headers: {
      // MCP-Apps resource MIME ("text/html;profile=mcp-app") travels via
      // JSON-RPC resources/read; the bytes the host iframes here need to be
      // plain text/html so browsers actually render them (nosniff blocks
      // structured-syntax suffixes / unusual MIMEs in strict modes).
      "content-type": "text/html; charset=utf-8",
      "x-content-type-options": "nosniff",
      // Host iframes load from a different origin (claudeusercontent.com /
      // web-sandbox.oaiusercontent.com); without CORP=cross-origin some
      // COEP-fronted hosts block the cross-origin fetch.
      "cross-origin-resource-policy": "cross-origin",
      ...responseHeaders(),
      "cache-control": "no-cache, no-store, must-revalidate",
    },
    body: r.content,
  };
}

export const handler: APIGatewayProxyHandlerV2 = async event => {
  const method = event.requestContext.http.method;
  const path = event.rawPath || "";
  const headers = event.headers ?? {};
  const origin = headers.origin;

  // Public widget HTML carries no account data.
  if (method === "GET" && path.startsWith("/mcp/ui/")) {
    return serveWidgetHtml(path.slice("/mcp/ui/".length));
  }

  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return httpJson(403, rpcErr(null, -32001, "Origin not allowed"));
  }
  const browserHeaders: Record<string, string> = origin
    ? { "access-control-allow-origin": origin, vary: "Origin" } : {};
  const reply = (status: number, body: unknown, extra: Record<string, string> = {}) =>
    httpJson(status, body, { ...browserHeaders, ...extra });

  if (method === "OPTIONS") {
    return { ...httpNoContent(204), headers: { ...responseHeaders(), ...browserHeaders } };
  }
  if (method !== "POST") {
    return reply(405, rpcErr(null, -32000, "Method not allowed"), { allow: "POST, OPTIONS" });
  }
  const auth = await authenticate(headers.authorization);
  const challenge = `Bearer resource_metadata="${RESOURCE_METADATA}"`;
  if (!auth) {
    return reply(401, rpcErr(null, -32001, "An MCP access token is required"), {
      "www-authenticate": `${challenge}, scope="${READ_SCOPE}"`,
    });
  }

  const version = headers["mcp-protocol-version"];
  if (version && !SUPPORTED_VERSIONS.has(version)) {
    return reply(400, rpcErr(null, -32600, "Unsupported MCP protocol version"));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : event.body ?? "");
  } catch {
    return reply(400, rpcErr(null, -32700, "Parse error"));
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return reply(400, rpcErr(null, -32600, "Expected one JSON-RPC request"));
  }
  const req = parsed as JsonRpcRequest;
  if (req.jsonrpc !== "2.0" || typeof req.method !== "string" ||
      (req.id !== undefined && typeof req.id !== "string" && typeof req.id !== "number")) {
    return reply(400, rpcErr(null, -32600, "Invalid JSON-RPC request"));
  }
  if (req.id === undefined) {
    return { ...httpNoContent(202), headers: { ...responseHeaders(), ...browserHeaders } };
  }

  const canWrite = auth.scopes.includes(WRITE_SCOPE);
  const tool = (req.params as { name?: string } | undefined)?.name;
  if (!canWrite && req.method === "tools/call" && tool && WRITE_TOOLS.has(tool)) {
    return reply(403, rpcErr(req.id, -32001, "Publishing access requires approval"), {
      "www-authenticate": `${challenge}, error="insufficient_scope", scope="${READ_SCOPE} ${WRITE_SCOPE}"`,
    });
  }
  const result = await dispatch(auth.email, canWrite, req);
  return reply(200, result);
};
