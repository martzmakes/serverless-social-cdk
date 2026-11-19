#!/usr/bin/env ts-node
/**
 * pds-bootstrap.ts — One-shot post-deploy repo initialiser.
 *
 * Run after the first CDK deploy to seed the AT Protocol repo with:
 *   - A self-profile record (app.bsky.actor.profile / self)
 *   - An initial post (app.bsky.feed.post)
 *
 * Idempotent: skips initialisation when a repo root already exists.
 *
 * Usage (from repo root):
 *   AWS_PROFILE=martzmakes-main-admin AWS_REGION=us-east-1 \
 *   REPO_TABLE=<table-name-from-cdk-outputs> \
 *   npx ts-node infra/scripts/pds-bootstrap.ts
 *
 * REPO_TABLE can also be inferred from infra/cdk-outputs.json if present.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm'
import { Repo, WriteOpAction } from '@atproto/repo'
import type { NsidString } from '@atproto/syntax'
import type { LexMap } from '@atproto/lex-data'

import { DID, HANDLE, PDS_ENDPOINT, SIGNING_KEY_SSM } from '../lib/lambdas/pds/lexicons'
import { keypairFromHex } from '../lib/lambdas/pds/signing-key'
import { DynamoRepoStorage } from '../lib/lambdas/pds/storage'
import { APEX_DID } from '../lib/lambdas/pds/tenant-keys'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

async function resolveTableName(): Promise<string> {
  if (process.env.REPO_TABLE) return process.env.REPO_TABLE

  // Try to read from cdk-outputs.json if present
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const outputs = require('../cdk-outputs.json') as Record<
      string,
      Record<string, string>
    >
    const stackOutputs = outputs['ServerlessSocialStack'] ?? {}
    if (stackOutputs['RepoTableName']) return stackOutputs['RepoTableName']
  } catch {
    // file not present — ignore
  }

  throw new Error(
    'REPO_TABLE env var is required (or run cdk deploy first to produce cdk-outputs.json)',
  )
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const tableName = await resolveTableName()
  const ssmClient = new SSMClient({})

  // Fetch signing key from SSM
  const keyRes = await ssmClient.send(
    new GetParameterCommand({ Name: SIGNING_KEY_SSM, WithDecryption: true }),
  )
  const hex = keyRes.Parameter?.Value?.trim()
  if (!hex) throw new Error(`SSM param ${SIGNING_KEY_SSM} is empty`)
  const kp = await keypairFromHex(hex)

  console.log(`Using RepoTable: ${tableName}`)
  console.log(`Using DID: ${DID}`)

  const storage = new DynamoRepoStorage(new DynamoDBClient({}), tableName, APEX_DID)

  // Idempotency guard — skip if a root already exists
  const existingRoot = await storage.getRoot()
  if (existingRoot !== null) {
    console.log(`Repo already initialised (head: ${existingRoot.toString()}). Nothing to do.`)
    return
  }

  // Create the repo with initial records
  console.log('Initialising repo...')
  const now = new Date().toISOString()

  const initialRecords: Parameters<typeof Repo.create>[3] = [
    // Self-profile
    {
      action: WriteOpAction.Create,
      collection: 'app.bsky.actor.profile' as NsidString,
      rkey: 'self',
      record: {
        $type: 'app.bsky.actor.profile',
        displayName: process.env.PDS_DISPLAY_NAME ?? HANDLE,
        ...(HANDLE === 'serverless.social' ? {
          description: 'A fully-serverless, single-tenant AT Protocol PDS + social client — deploy your own at your own domain. Built on AWS Lambda, DynamoDB, and the AT Protocol spec. This account is the platform dogfooding itself.',
        } : {}),
        createdAt: now,
      } as LexMap,
    },
  ]
  if (HANDLE === 'serverless.social' && !process.env.PDS_DISPLAY_NAME) {
    initialRecords.push({
      action: WriteOpAction.Create,
      collection: 'app.bsky.feed.post' as NsidString,
      rkey: 'first',
      record: {
        $type: 'app.bsky.feed.post',
        text: 'Serverless.social is live on the AT Protocol — a single-tenant PDS running entirely on AWS serverless infrastructure. Deploy your own: github.com/martzmakes/serverless-social',
        createdAt: now,
        langs: ['en'],
      } as LexMap,
    })
  }
  const repo = await Repo.create(storage, DID, kp, initialRecords)

  const head = repo.cid.toString()
  console.log(`Repo initialised. Head CID: ${head}`)
  console.log(`DID document: ${PDS_ENDPOINT}/.well-known/did.json`)
  console.log(`XRPC endpoint: ${PDS_ENDPOINT}/xrpc/com.atproto.server.describeServer`)
  console.log()
  console.log('Bootstrap complete.')
}

main().catch((err) => {
  console.error('Bootstrap failed:', err)
  process.exit(1)
})
