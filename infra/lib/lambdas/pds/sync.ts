/**
 * sync.ts — AT Protocol sync read surface (com.atproto.sync.*).
 *
 * Implements the three sync endpoints that a Bluesky relay/AppView uses when
 * crawling a PDS:
 *
 *   getRepoCar       → com.atproto.sync.getRepo
 *   getLatestCommit  → com.atproto.sync.getLatestCommit
 *   listRepos        → com.atproto.sync.listRepos
 *
 * CAR export uses the canonical @atproto/repo `getFullRepo` helper which
 * produces an authenticated CAR stream (commit block + full MST) that can be
 * verified by `verifyRepoCar(bytes, did, signingKey)` — the exact check a relay
 * performs.
 *
 * API symbols used from @atproto/repo@0.9.1:
 *   - `getFullRepo(storage, commitCid)` → AsyncIterable<Uint8Array>  (sync/provider)
 *   - `concatBytesAsync(stream)`        → Promise<Uint8Array>         (util)
 *   - `Repo.load(storage, cid?)`        → Promise<Repo>              (repo)
 */

import { getFullRepo, concatBytesAsync } from '@atproto/repo'
import type { RepoStorage } from '@atproto/repo/dist/storage/types.js'
import { DID } from './lexicons'
import { loadRepoOrThrow } from './repo-root'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LatestCommit = {
  cid: string
  rev: string
}

export type RepoListEntry = {
  did: string
  head: string
  rev: string
  active: boolean
}

export type ListReposOutput = {
  repos: RepoListEntry[]
}

// ---------------------------------------------------------------------------
// getRepoCar
// ---------------------------------------------------------------------------

/**
 * Export the full repository as a CAR byte array.
 *
 * The CAR contains the signed commit block + every MST node and record leaf,
 * which is exactly what the Bluesky relay fetches when it crawls a PDS.
 * Callers can verify the result with:
 *   verifyRepoCar(car, did, signingKeyDidStr)
 *
 * Throws with xrpcError='RepoNotFound' if no root is present in storage.
 */
export async function getRepoCar(storage: RepoStorage): Promise<Uint8Array> {
  const { root } = await loadRepoOrThrow(storage)

  // getFullRepo returns an AsyncIterable<Uint8Array> (CAR stream).
  // concatBytesAsync collects the stream into a single Uint8Array.
  const stream = getFullRepo(storage, root as any)
  return concatBytesAsync(stream)
}

// ---------------------------------------------------------------------------
// getLatestCommit
// ---------------------------------------------------------------------------

/**
 * Return the current head CID and rev for the single-tenant repo.
 * Throws with xrpcError='RepoNotFound' if no root exists.
 */
export async function getLatestCommit(storage: RepoStorage): Promise<LatestCommit> {
  const { repo } = await loadRepoOrThrow(storage)
  return {
    cid: repo.cid.toString(),
    rev: repo.commit.rev,
  }
}

// ---------------------------------------------------------------------------
// listRepos
// ---------------------------------------------------------------------------

/**
 * List repos hosted by this PDS. Apex entry is always first and byte-identical
 * to the original single-tenant stub. Active tenants from the store follow.
 *
 * head/rev are intentionally left as empty strings — the relay uses
 * getRepoCar/getLatestCommit for the actual data; this endpoint is a directory.
 */
export async function listRepos(
  store: { listActive: () => Promise<Array<{ did: string }>> },
): Promise<ListReposOutput> {
  const tenants = await store.listActive()
  return {
    repos: [
      {
        did: DID,
        head: '',
        rev: '',
        active: true,
      },
      ...tenants.map((t) => ({ did: t.did, head: '', rev: '', active: true as const })),
    ],
  }
}

