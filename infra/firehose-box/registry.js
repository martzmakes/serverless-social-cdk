'use strict'

/**
 * registry.js — SSM-backed instance registry for the firehose box.
 *
 * loadRegistry(ssmClient, paramName): fetches + parses JSON SSM param value:
 *   { defaultInstanceId: string, instances: { [id]: RegistryEntry } }
 * Returns a registry object with:
 *   - lookup(instanceId) → { repoTable, did } | null
 *   - defaultInstanceId (string)
 * Cache is refreshed every ~60 seconds.
 *
 * makeRegistry(obj): builds the same interface from an in-memory object (for tests).
 *
 * @typedef {Object} RegistryEntry
 * @property {string} repoTable - DynamoDB table name backing this PDS instance.
 * @property {string} did       - Apex AT Protocol DID for this instance (e.g. 'did:web:serverless.social').
 * @property {string[]} [dids]  - Full list of DIDs served by this instance (apex first, then sub-users).
 *                                Relay-side readers should use this as the authoritative DID set;
 *                                the plain `did` field is retained for backward-compat single-DID consumers.
 */

const CACHE_TTL_MS = 60_000

/**
 * Build a registry interface from a plain JS object.
 * This is the canonical interface used by server.js.
 *
 * @param {{ defaultInstanceId: string, instances: Record<string, RegistryEntry> }} obj
 */
function makeRegistry(obj) {
  return {
    get defaultInstanceId() {
      return obj.defaultInstanceId
    },
    lookup(instanceId) {
      if (!instanceId) return null
      const inst = obj.instances[instanceId]
      return inst ? { repoTable: inst.repoTable, did: inst.did } : null
    },
  }
}

/**
 * Load a live registry from SSM, with 60s caching.
 *
 * @param {import('@aws-sdk/client-ssm').SSMClient} ssmClient
 * @param {string} paramName  SSM parameter name (SecureString or String, JSON value)
 * @returns {Promise<ReturnType<typeof makeRegistry> & { refresh(): Promise<void> }>}
 */
async function loadRegistry(ssmClient, paramName) {
  const { GetParameterCommand } = require('@aws-sdk/client-ssm')

  let cached = null
  let lastFetch = 0

  async function refresh() {
    const res = await ssmClient.send(
      new GetParameterCommand({ Name: paramName, WithDecryption: true }),
    )
    const raw = res.Parameter?.Value
    if (!raw) throw new Error(`SSM parameter ${paramName} is empty`)
    cached = JSON.parse(raw)
    lastFetch = Date.now()
  }

  // Initial fetch
  await refresh()

  return {
    get defaultInstanceId() {
      return cached.defaultInstanceId
    },
    lookup(instanceId) {
      if (!instanceId) return null
      const inst = cached.instances[instanceId]
      return inst ? { repoTable: inst.repoTable, did: inst.did } : null
    },
    async refresh() {
      await refresh()
    },
    /** Internal: call this before each lookup in long-lived processes. */
    async maybeRefresh() {
      if (Date.now() - lastFetch > CACHE_TTL_MS) {
        await refresh()
      }
    },
  }
}

module.exports = { makeRegistry, loadRegistry }
