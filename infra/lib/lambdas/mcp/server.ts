// MCP server Lambda — JSON-RPC 2.0 over HTTP POST (Streamable HTTP transport).
// Auth: Bearer JWT minted by the magic-link sign-in (or by the OAuth flow for
// remote MCP clients like Claude Desktop).
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
import { randomUUID } from "crypto";
import { verifyJwt } from "../auth/lib/jwt";
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
const SERVER_NAME = PROJECT_SLUG;
const SERVER_VERSION = "0.1.0";

// Sandbox domain Claude uses to iframe widgets — sha256(mcpUrl).slice(0,32)
// + ".claudemcpcontent.com". Compute with `scripts/mcp-sandbox-domain.sh`
// after deploy and paste here. Until then, widgets work but Claude shows a
// "local connector" warning.
//
// Claude rejects ui.domain hints from raw *.execute-api.amazonaws.com URLs
// — the MCP server MUST be served from a verified custom domain (the
// CloudFront proxy in infra-stack.ts handles this).
const WIDGET_DOMAIN =
  process.env.MCP_WIDGET_DOMAIN || "<COMPUTE_AFTER_FIRST_DEPLOY>.claudemcpcontent.com";

const WIDGET_CSP = {
  connectDomains: [DOMAIN, WIDGET_DOMAIN],
  resourceDomains: [] as string[],
};

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
    name: "whoami",
    description:
      "Returns the signed-in user's email + accounts they can post from (same as " +
      "list_accounts) + timestamps. Pairs with the user-card widget.",
    inputSchema: { type: "object", properties: {} },
    _meta: widgetUiMeta(`ui://${PROJECT_SLUG}/user-card`),
  },
] as const;

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

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers":
      "authorization,content-type,mcp-session-id,mcp-protocol-version",
    "access-control-expose-headers": "mcp-session-id,www-authenticate",
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
      ...corsHeaders(),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

function httpNoContent(statusCode: number) {
  return { statusCode, headers: corsHeaders(), body: "" };
}

// ---------------------------------------------------------------------------
// MCP method dispatch
// ---------------------------------------------------------------------------

async function dispatch(
  email: string,
  req: JsonRpcRequest
): Promise<JsonRpcResponse | null> {
  // Notifications (no response)
  if (req.id == null && req.method.startsWith("notifications/")) return null;

  const id = req.id ?? null;

  try {
    switch (req.method) {
      case "initialize":
        return ok(id, {
          protocolVersion: PROTOCOL_VERSION,
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

      case "ping":
        return ok(id, {});

      case "tools/list":
        return ok(id, { tools: TOOLS });

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

async function extractEmail(
  authHeader: string | undefined
): Promise<string | null> {
  if (!authHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (!match) return null;
  try {
    const { email } = await verifyJwt(match[1]);
    return email;
  } catch {
    return null;
  }
}

function serveWidgetHtml(widgetPath: string) {
  const uri = `ui://${PROJECT_SLUG}/${widgetPath}`;
  const r = UI_RESOURCES_MAP[uri];
  if (!r) {
    return {
      statusCode: 404,
      headers: { "content-type": "application/json", ...corsHeaders() },
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
      "cache-control": "no-cache, no-store, must-revalidate",
      "x-content-type-options": "nosniff",
      // Host iframes load from a different origin (claudeusercontent.com /
      // web-sandbox.oaiusercontent.com); without CORP=cross-origin some
      // COEP-fronted hosts block the cross-origin fetch.
      "cross-origin-resource-policy": "cross-origin",
      ...corsHeaders(),
    },
    body: r.content,
  };
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const method = event.requestContext.http.method;
  const rawPath = event.rawPath || "";

  if (method === "OPTIONS") return httpNoContent(204);

  // Public widget HTML — Claude iframes these directly. No auth required
  // (the HTML is public; data calls back to /mcp still need Bearer).
  if (method === "GET" && rawPath.startsWith("/mcp/ui/")) {
    return serveWidgetHtml(rawPath.slice("/mcp/ui/".length));
  }

  // Some clients open SSE on GET /mcp; we don't push, so 405.
  if (method === "GET") {
    return httpJson(405, {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Streaming GET not supported" },
    });
  }

  // DELETE /mcp would close a session — we're stateless.
  if (method === "DELETE") return httpNoContent(204);

  if (method !== "POST") {
    return httpJson(405, {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed" },
    });
  }

  const authHeader =
    event.headers?.authorization || event.headers?.Authorization;
  const email = await extractEmail(authHeader);
  if (!email) {
    // RFC 9728: point clients at the MCP-SCOPED protected-resource metadata so
    // they can initiate the OAuth flow. The canonical /.well-known/oauth-
    // protected-resource is owned by the AT-Proto OAuth server (PAR + DPoP
    // mandatory) — pointing MCP clients there shunted Claude Code/Desktop into
    // "PAR required". The /mcp-scoped PRM advertises the magic-link MCP AS.
    const wwwAuth = `Bearer resource_metadata="${MCP_PUBLIC_BASE}/.well-known/oauth-protected-resource/mcp"`;
    return httpJson(
      401,
      {
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message: "Unauthorized — missing or invalid JWT",
        },
      },
      { "www-authenticate": wwwAuth }
    );
  }

  let parsed: JsonRpcRequest | JsonRpcRequest[];
  try {
    parsed = JSON.parse(event.body || "null");
  } catch {
    return httpJson(400, {
      jsonrpc: "2.0",
      error: { code: -32700, message: "Parse error" },
    });
  }

  // Streamable HTTP: server mints session id on initialize; clients echo it
  // on subsequent calls. We're stateless, so just generate a fresh one.
  const incomingSession =
    event.headers?.["mcp-session-id"] || event.headers?.["Mcp-Session-Id"];
  const isInitialize =
    !Array.isArray(parsed) && parsed?.method === "initialize";
  const sessionId = isInitialize
    ? randomUUID()
    : incomingSession || randomUUID();
  const sessionHeader = { "mcp-session-id": sessionId };

  if (Array.isArray(parsed)) {
    const results = await Promise.all(parsed.map((r) => dispatch(email, r)));
    const filtered = results.filter((r): r is JsonRpcResponse => r !== null);
    if (filtered.length === 0) {
      return {
        statusCode: 202,
        headers: { ...corsHeaders(), ...sessionHeader },
        body: "",
      };
    }
    return httpJson(200, filtered, sessionHeader);
  }

  const result = await dispatch(email, parsed);
  if (result === null) {
    return {
      statusCode: 202,
      headers: { ...corsHeaders(), ...sessionHeader },
      body: "",
    };
  }
  return httpJson(200, result, sessionHeader);
};
