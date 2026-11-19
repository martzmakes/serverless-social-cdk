import { Repo } from '@atproto/repo'
import type { RepoStorage } from '@atproto/repo/dist/storage/types.js'

/** Load the single-tenant repo, mapping "no repo / storage unavailable" to a
 *  RepoNotFound xrpc error so handlers return 404 not 500. */
export async function loadRepoOrThrow(storage: RepoStorage) {
  let root: unknown
  try {
    root = await (storage as any).getRoot()
  } catch {
    const e: any = new Error('RepoNotFound'); e.xrpcError = 'RepoNotFound'; throw e
  }
  if (!root) { const e: any = new Error('RepoNotFound'); e.xrpcError = 'RepoNotFound'; throw e }
  return { root, repo: await Repo.load(storage, root as any) }
}
