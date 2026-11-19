'use strict'

/**
 * server.js — shared multi-instance firehose box WebSocket server.
 *
 * Exports:
 *   createServer({ ddbClient, registry, pollMs, _core }) → { server, port, close() }
 *
 * _core is an optional injection point for firehose-core functions
 * (parseCursor, fetchEvtRange, planReplay). When omitted, the functions are
 * loaded from the sibling infra/lib/lambdas/pds/firehose-core.ts at runtime.
 *
 * If run directly (require.main === module), boots with real AWS clients using
 * env vars: SSM_REGISTRY_PARAM, PORT.
 *
 * Routing:
 *   GET /healthz           → 200 { ok: true }
 *   WS /xrpc/com.atproto.sync.subscribeRepos?cursor=N
 *     header x-pds-instance → routes to named instance (falls back to default)
 *
 * Per-connection isolation: each WS connection is tied to one instance's
 * repoTable. The shared poll interval delivers frames only to connections
 * that belong to that instance.
 */

const http = require('http')
const { WebSocketServer } = require('ws')
const { DynamoDBDocument, GetCommand } = require('@aws-sdk/lib-dynamodb')

// ---------------------------------------------------------------------------
// Log helpers (structured JSON lines)
// ---------------------------------------------------------------------------

function log(obj) {
  try {
    console.log(JSON.stringify(obj))
  } catch {
    console.log(obj)
  }
}

// ---------------------------------------------------------------------------
// DDB helpers
// ---------------------------------------------------------------------------

/**
 * Read the current max seq for an instance's table.
 * pk=SEQ, sk=SEQ → value Number (default 0).
 */
async function readCurrentSeq(docClient, repoTable) {
  const res = await docClient.send(
    new GetCommand({
      TableName: repoTable,
      Key: { pk: 'SEQ', sk: 'SEQ' },
    }),
  )
  return res.Item?.value ?? 0
}

// ---------------------------------------------------------------------------
// createServer
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   ddbClient: import('@aws-sdk/client-dynamodb').DynamoDBClient,
 *   registry: any,
 *   pollMs?: number,
 *   _core?: { parseCursor: Function, fetchEvtRange: Function, planReplay: Function }
 * }} opts
 * @returns {{ server: http.Server, port: number, close(): Promise<void> }}
 */
function createServer({ ddbClient, registry, pollMs = 1000, gapGraceMs = 15000, _core }) {
  // Resolve firehose-core functions (injected or loaded from sibling path).
  // When invoked from the CLI (require.main === module) or in production, we
  // load from the project source via tsx. When injected by tests, the caller
  // provides already-resolved functions.
  let parseCursor, fetchEvtRange, planReplay
  if (_core) {
    ;({ parseCursor, fetchEvtRange, planReplay } = _core)
  } else {
    const core = require('../lib/lambdas/pds/firehose-core')
    ;({ parseCursor, fetchEvtRange, planReplay } = core)
  }

  const docClient = DynamoDBDocument.from(ddbClient)

  // Active connections set: Map<ws, { ws, instanceId, repoTable, lastSeq }>
  const connections = new Map()

  // ---------------------------------------------------------------------------
  // HTTP server
  // ---------------------------------------------------------------------------

  const server = http.createServer((req, res) => {
    if (req.url === '/healthz' || req.url?.startsWith('/healthz?')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    res.writeHead(404)
    res.end('Not Found')
  })

  // ---------------------------------------------------------------------------
  // WebSocket server (noServer: attached via upgrade event)
  // ---------------------------------------------------------------------------

  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req, socket, head) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`)

    // Only accept the subscribeRepos path
    if (parsedUrl.pathname !== '/xrpc/com.atproto.sync.subscribeRepos') {
      socket.destroy()
      return
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, parsedUrl)
    })
  })

  // ---------------------------------------------------------------------------
  // Connection handler
  // ---------------------------------------------------------------------------

  wss.on('connection', async (ws, req, parsedUrl) => {
    const rawInstanceId = req.headers['x-pds-instance']
    let inst = rawInstanceId ? registry.lookup(rawInstanceId) : null
    const resolvedId = rawInstanceId || null

    if (!inst) {
      // Fall back to default instance
      const defaultId = registry.defaultInstanceId
      inst = registry.lookup(defaultId)
      if (!inst) {
        log({ evt: 'error', msg: 'No default instance found', instanceId: resolvedId })
        ws.close(1011, 'No instance configured')
        return
      }
      if (resolvedId !== null) {
        log({ evt: 'warn', msg: `Unknown x-pds-instance '${resolvedId}', falling back to default '${defaultId}'` })
      } else {
        log({ evt: 'warn', msg: `Missing x-pds-instance header, falling back to default '${defaultId}'` })
      }
    }

    const instanceId = resolvedId || registry.defaultInstanceId
    const { repoTable } = inst
    const remote = req.socket?.remoteAddress ?? 'unknown'
    const cursorRaw = parsedUrl.searchParams.get('cursor') ?? undefined
    const cursor = parseCursor(cursorRaw)

    log({ evt: 'connect', remote, instanceId, cursor: cursor ?? null })

    // Safe send helper
    function safeSend(bytes) {
      if (ws.readyState === ws.OPEN) {
        ws.send(bytes, { binary: true })
      }
    }

    try {
      // Read current seq for this instance
      const currentSeq = await readCurrentSeq(docClient, repoTable)

      // Plan replay
      const result = await planReplay(
        currentSeq,
        cursor,
        (from, to) => fetchEvtRange(ddbClient, repoTable, from, to),
      )

      if (result.mode === 'future') {
        // Send error frame + close; no live-tail
        if (result.error) safeSend(result.error)
        ws.close()
        log({ evt: 'close', instanceId, reason: 'FutureCursor' })
        return
      }

      if (result.mode === 'outdated' && result.info) {
        safeSend(result.info)
      }

      // Send replay frames
      for (const frame of result.frames) {
        safeSend(frame)
      }
      log({ evt: 'replay', instanceId, n: result.frames.length })

      // Register connection for live-tail polling
      connections.set(ws, {
        ws,
        instanceId,
        repoTable,
        lastSeq: currentSeq,
        gapSince: null,
        safeSend(bytes) { if (ws.readyState === ws.OPEN) ws.send(bytes, { binary: true }) },
      })

      // Ping every 30s for liveness
      const pingInterval = setInterval(() => {
        if (ws.readyState === ws.OPEN) {
          ws.ping()
        } else {
          clearInterval(pingInterval)
        }
      }, 30_000)

      ws.on('close', () => {
        clearInterval(pingInterval)
        connections.delete(ws)
        log({ evt: 'close', instanceId })
      })

      ws.on('error', (err) => {
        log({ evt: 'socket-error', instanceId, err: String(err) })
        clearInterval(pingInterval)
        connections.delete(ws)
      })
    } catch (err) {
      log({ evt: 'error', instanceId, err: String(err) })
      try { ws.close(1011, 'Internal error') } catch { /* ignore */ }
    }
  })

  // ---------------------------------------------------------------------------
  // Live-tail poll interval (one per server, shared across all connections)
  // ---------------------------------------------------------------------------

  const pollHandle = setInterval(async () => {
    if (connections.size === 0) return

    // Every relay that follows this PDS holds its own connection, and several
    // do. One SEQ read per TABLE per tick, shared by all of them: per
    // connection it was ~46M DynamoDB reads a month (Oct 2026), the single
    // biggest line on the bill, for a counter that is identical to every
    // subscriber of the same instance.
    const seqByTable = new Map()
    const currentSeqFor = async (repoTable) => {
      if (!seqByTable.has(repoTable)) seqByTable.set(repoTable, await readCurrentSeq(docClient, repoTable))
      return seqByTable.get(repoTable)
    }

    for (const [ws, conn] of connections.entries()) {
      if (ws.readyState !== ws.OPEN) {
        connections.delete(ws)
        continue
      }
      try {
        const currentSeq = await currentSeqFor(conn.repoTable)
        if (currentSeq > conn.lastSeq) {
          // The sequencer bumps SEQ/SEQ in its step 1 and writes the EVT# row
          // in its step 6, seconds later for a large repo. Reading the counter
          // and then advancing past every seq up to it therefore skipped any
          // event whose row was not written yet, permanently: the relay never
          // saw the last post before a quiet period (2026-05 "missing posts",
          // 2026-11-01 seq 260). Only advance through CONTIGUOUS delivered
          // frames; a hole waits up to gapGraceMs for its row, then is skipped
          // (a sequencer that failed between step 1 and 6 leaves a real hole).
          const { frames } = await fetchEvtRange(ddbClient, conn.repoTable, conn.lastSeq, currentSeq)
          const from = conn.lastSeq
          let next = conn.lastSeq + 1
          let delivered = 0
          const skipHole = (to) => {
            log({ evt: 'gap-skip', instanceId: conn.instanceId, from: next, to })
            next = to
            conn.gapSince = null
          }
          for (const { seq, frame } of frames) {
            if (seq < next) continue
            if (seq > next) {
              if (conn.gapSince == null) conn.gapSince = Date.now()
              if (Date.now() - conn.gapSince < gapGraceMs) break
              skipHole(seq)
            }
            conn.safeSend(frame)
            delivered++
            next = seq + 1
            conn.gapSince = null
          }
          if (next <= currentSeq && frames.every((f) => f.seq < next)) {
            // Trailing hole: the counter is ahead of the newest row.
            if (conn.gapSince == null) conn.gapSince = Date.now()
            if (Date.now() - conn.gapSince >= gapGraceMs) skipHole(currentSeq + 1)
          }
          conn.lastSeq = next - 1
          if (delivered > 0) {
            log({ evt: 'live', instanceId: conn.instanceId, from, to: conn.lastSeq, n: delivered })
          }
        }
      } catch (err) {
        log({ evt: 'poll-error', instanceId: conn.instanceId, err: String(err) })
      }
    }
  }, pollMs)

  // ---------------------------------------------------------------------------
  // Ephemeral port binding
  // ---------------------------------------------------------------------------

  server.listen(0)
  // listen(0) picks an ephemeral port; s.port is valid after the event loop turns
  // (tests access it via async connectWs, and the require.main block re-listens on the real port).

  function getPort() {
    const addr = server.address()
    return typeof addr === 'object' && addr !== null ? addr.port : 0
  }

  // ---------------------------------------------------------------------------
  // close()
  // ---------------------------------------------------------------------------

  async function close() {
    clearInterval(pollHandle)
    // Close all open connections
    for (const [ws] of connections.entries()) {
      try { ws.close() } catch { /* ignore */ }
    }
    connections.clear()
    return new Promise((resolve, reject) => {
      wss.close(() => {
        server.close((err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    })
  }

  // Return a proxy that resolves port lazily (server.listen(0) is async)
  return {
    server,
    get port() { return getPort() },
    close,
  }
}

// ---------------------------------------------------------------------------
// Main entrypoint (box daemon)
// ---------------------------------------------------------------------------

if (require.main === module) {
  ;(async () => {
    const { DynamoDBClient } = require('@aws-sdk/client-dynamodb')
    const { SSMClient } = require('@aws-sdk/client-ssm')
    const { loadRegistry } = require('./registry')

    const ssmParam = process.env.SSM_REGISTRY_PARAM
    if (!ssmParam) {
      console.error('SSM_REGISTRY_PARAM env var is required')
      process.exit(1)
    }

    const ssmClient = new SSMClient({})
    const registry = await loadRegistry(ssmClient, ssmParam)
    const ddbClient = new DynamoDBClient({})
    const listenPort = parseInt(process.env.PORT ?? '8080', 10)
    const pollMs = 1000

    // Load firehose-core via tsx at runtime (tsx server.js)
    const core = require('../lib/lambdas/pds/firehose-core')

    const s = createServer({ ddbClient, registry, pollMs, _core: core })

    // Re-listen on the configured port
    s.server.close(() => {
      s.server.listen(listenPort, () => {
        log({ evt: 'start', port: listenPort, ssmParam })
      })
    })

    for (const sig of ['SIGTERM', 'SIGINT']) {
      process.on(sig, async () => {
        log({ evt: 'shutdown', signal: sig })
        await s.close()
        process.exit(0)
      })
    }
  })().catch((err) => {
    console.error('Fatal:', err)
    process.exit(1)
  })
}

module.exports = { createServer }
