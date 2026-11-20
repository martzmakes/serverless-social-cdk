import * as fs from "node:fs";
import * as path from "node:path";
import { Code } from "aws-cdk-lib/aws-lambda";
import type { NodejsFunctionProps } from "aws-cdk-lib/aws-lambda-nodejs";

export const lambdaEntries = [
  "auth/request",
  "auth/verify",
  "auth/me",
  "auth/pds-session",
  "chat/handler",
  "editor/handler",
  "editor/worker",
  "oauth/handler",
  "mcp/server",
  "atproto-oauth/handler",
  "pds/handler",
  "ap/handler",
  "ap/deliver",
  "ap/retry",
  "pds/firehose-ws",
  "pds/firehose-fanout",
  "pds/longform-renderer",
  "analytics/aggregate",
  "analytics/insights",
  "analytics/capture-engagement",
] as const;

type LambdaEntry = (typeof lambdaEntries)[number];

export function lambdaSource(entry: LambdaEntry): NodejsFunctionProps {
  const source = path.join(__dirname, "lambdas", `${entry}.ts`);
  if (fs.existsSync(source)) {
    return { entry: source, handler: "handler" };
  }

  const bundled = path.join(__dirname, "../lambda-assets", entry);
  return { code: Code.fromAsset(bundled), handler: "index.handler" };
}
