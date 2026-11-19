import { generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dispatch, type ApDeps } from '../lib/lambdas/ap/handler'
import { realFetchJson, realFetchRemoteActor } from '../lib/lambdas/ap-deps'
import type { FollowingRow } from '../lib/lambdas/ap/following'
import { articleRepliesPartition, ingestArticleReply, type InboundRecord } from '../lib/lambdas/ap/ingest'
import { parseSignatureHeader, signRequest, verifyRequest } from '../lib/lambdas/ap/httpsig'

const keys = () => generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})
const publisher = keys()
const follower = keys()
const remote = 'https://mastodon.example/ap/users/test'
const inbox = remote + '/inbox'
const keyId = remote + '#rsa-current-key'
const actorDocument = {
  id: remote, inbox, type: 'Person', preferredUsername: 'test',
  publicKey: { id: keyId, owner: remote, publicKeyPem: follower.publicKey },
}
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }]
const lowercase = (headers: Record<string, string>) =>
  Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))

afterEach(() => vi.unstubAllGlobals())

describe('ActivityPub signed fetch federation', () => {
  it.each(['serverless.social', 'martzmakes.com'])('accepts a real signed Follow at %s after signed actor discovery', async handle => {
    const origin = `https://${handle}`
    const actor = `${origin}/ap/users/${handle}`
    const localKey = actor + '#main-key'
    const localInbox = actor + '/inbox'
    const follow = { type: 'Follow', actor: remote, object: actor, id: remote + '/activities/follow-1' }
    const body = Buffer.from(JSON.stringify(follow))
    const get = vi.fn(async (url: string, request: RequestInit) => {
      expect(url).toBe(remote)
      expect(request.redirect).toBe('manual')
      const signature = new Headers(request.headers).get('signature')
      if (!signature) return new Response(null, { status: 401 })
      expect(parseSignatureHeader(signature).keyId).toBe(localKey)
      const headers = Object.fromEntries(new Headers(request.headers))
      expect(headers).not.toHaveProperty('digest')
      expect(await verifyRequest({
        method: 'GET', path: new URL(remote).pathname, headers, body: Buffer.alloc(0),
      }, publisher.publicKey)).toBe(true)
      return Response.json(actorDocument)
    })
    vi.stubGlobal('fetch', get)

    const add = vi.fn(async () => {})
    const deliverActivity = vi.fn(async (target: string, body: Buffer, headers: Record<string, string>) => {
      expect(target).toBe(inbox)
      expect(parseSignatureHeader(headers.Signature).keyId).toBe(localKey)
      expect(await verifyRequest({ method: 'POST', path: new URL(inbox).pathname, headers, body }, publisher.publicKey)).toBe(true)
      expect(JSON.parse(body.toString())).toMatchObject({ type: 'Accept', actor, object: follow })
      return { status: 202 }
    })
    const deps: ApDeps = {
      tenantStore: {
        byHandle: async name => ({ did: 'did:plc:example', handle: name, status: 'active' }),
        byDid: async () => null,
        listActive: async () => [],
      },
      customHosts: ['martzmakes.com'],
      getApKey: async () => ({ privatePem: publisher.privateKey, publicPem: publisher.publicKey }),
      verifyRequest, signRequest, deliverActivity,
      fetchRemoteActor: (id, from) => {
        expect(from).toEqual({ handle, origin })
        return realFetchRemoteActor(id, publicLookup, url => signRequest({
          method: 'GET', url, body: Buffer.alloc(0), keyId: localKey, privateKeyPem: publisher.privateKey,
        }))
      },
      actorCache: { get: async () => null, put: async () => {} },
      followers: { add, remove: async () => {}, list: async () => [] },
      listOutbox: async () => ({ records: [] }),
      countOutbox: async () => 0,
      getOutboxPost: async () => null,
    }
    const headers = lowercase(await signRequest({
      method: 'POST', url: localInbox, body, keyId, privateKeyPem: follower.privateKey,
    }))
    const request = { method: 'POST', url: localInbox, path: new URL(localInbox).pathname, query: {}, headers, rawBody: body }
    const response = await dispatch(request, deps)
    expect(response.status).toBe(202)
    expect(get).toHaveBeenCalledTimes(2)
    expect(add).toHaveBeenCalledExactlyOnceWith(handle, remote, inbox)
    expect(deliverActivity).toHaveBeenCalledTimes(1)

    add.mockClear()
    deliverActivity.mockClear()
    const tampered = await dispatch({ ...request, rawBody: Buffer.concat([body, Buffer.from(' ')]) }, deps)
    expect(tampered.status).toBe(401)
    expect(add).not.toHaveBeenCalled()
    expect(deliverActivity).not.toHaveBeenCalled()
  })

  it('does not sign public actor lookups or follow redirects', async () => {
    const signer = vi.fn(async () => ({}))
    const get = vi.fn()
      .mockResolvedValueOnce(Response.json(actorDocument))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://elsewhere.example' } }))
    vi.stubGlobal('fetch', get)
    await expect(realFetchRemoteActor(keyId, publicLookup, signer)).resolves.toMatchObject({ id: remote, inbox })
    await expect(realFetchRemoteActor(keyId, publicLookup, signer)).rejects.toThrow('refusing to follow redirect')
    expect(signer).not.toHaveBeenCalled()
    expect(get).toHaveBeenCalledTimes(2)
  })
})

describe('Following a Mastodon account from the sites', () => {
  it.each(['serverless.social', 'martzmakes.com'])('follows and ingests a standalone post for %s', async handle => {
    const origin = `https://${handle}`
    const actor = `${origin}/ap/users/${handle}`
    const localKey = actor + '#main-key'
    const did = handle === 'serverless.social' ? 'did:web:serverless.social' : 'did:plc:example'
    const postId = remote + '/statuses/test-post'
    const post = { type: 'Create', actor: remote, object: {
      type: 'Note', id: postId, attributedTo: remote, content: '<p>A standalone QA post</p>',
      to: ['https://www.w3.org/ns/activitystreams#Public'], published: new Date().toISOString(),
    } }
    const lookup = vi.fn(async (url: string, init: RequestInit) => {
      const sig = new Headers(init.headers).get('signature')
      if (new URL(url).pathname === '/.well-known/webfinger') {
        expect(sig).toBeNull()
        return Response.json({ links: [{ rel: 'self', type: 'application/activity+json', href: remote }] })
      }
      expect(url).toBe(remote)
      if (!sig) return new Response(null, { status: 401 })
      expect(parseSignatureHeader(sig).keyId).toBe(localKey)
      expect(await verifyRequest({
        method: 'GET', path: new URL(remote).pathname,
        headers: Object.fromEntries(new Headers(init.headers)), body: Buffer.alloc(0),
      }, publisher.publicKey)).toBe(true)
      return Response.json(actorDocument)
    })
    vi.stubGlobal('fetch', lookup)
    const following = new Map<string, FollowingRow>()
    const entries = new Map<string, InboundRecord>()
    let followId = ''
    const deps: ApDeps = {
      tenantStore: {
        byHandle: async name => ({ did, handle: name, status: 'active' }),
        byDid: async () => null,
        listActive: async () => [],
      },
      customHosts: ['martzmakes.com'],
      getApKey: async () => ({ privatePem: publisher.privateKey, publicPem: publisher.publicKey }),
      authenticateOwner: async authorization => authorization === 'Bearer owner' ? did : null,
      verifyRequest, signRequest,
      deliverActivity: async (url, body, headers) => {
        expect(url).toBe(inbox)
        expect(await verifyRequest({ method: 'POST', path: new URL(url).pathname, headers, body }, publisher.publicKey)).toBe(true)
        const activity = JSON.parse(body.toString())
        expect(activity).toMatchObject({ type: 'Follow', actor, object: remote })
        followId = activity.id
        return { status: 202 }
      },
      fetchJson: url => realFetchJson(url, publicLookup),
      fetchActorJson: (url, from) => {
        expect(from).toEqual({ handle, origin })
        return realFetchJson(url, publicLookup, target => signRequest({
          method: 'GET', url: target, body: Buffer.alloc(0), keyId: localKey, privateKeyPem: publisher.privateKey,
        }))
      },
      fetchRemoteActor: async id => {
        expect(id).toBe(keyId)
        return { id: remote, inbox, publicKeyPem: follower.publicKey }
      },
      actorCache: { get: async () => null, put: async () => {} },
      followers: { add: async () => {}, remove: async () => {}, list: async () => [] },
      following: {
        get: async (owner, id) => following.get(owner + ':' + id) ?? null,
        put: async (owner, row) => { following.set(owner + ':' + row.actorId, row) },
        setAccepted: async (owner, id) => {
          const row = following.get(owner + ':' + id)
          if (!row) return false
          row.state = 'accepted'
          return true
        },
        remove: async () => {},
        list: async () => [...following.values()],
      },
      inbound: {
        putIfAbsent: async (owner, row) => {
          const key = owner + ':' + row.key
          if (entries.has(key)) return false
          entries.set(key, row)
          return true
        },
        page: async () => ({ records: [...entries.values()] }),
        update: async () => false,
        remove: async () => false,
      },
      listOutbox: async () => ({ records: [] }),
      countOutbox: async () => 0,
      getOutboxPost: async () => null,
    }
    const deliver = async (activity: unknown) => {
      const url = actor + '/inbox'
      const rawBody = Buffer.from(JSON.stringify(activity))
      const headers = lowercase(await signRequest({ method: 'POST', url, body: rawBody, keyId, privateKeyPem: follower.privateKey }))
      return dispatch({ method: 'POST', url, path: new URL(url).pathname, query: {}, rawBody, headers }, deps)
    }
    const followUrl = actor + '/following'
    const headers = { authorization: 'Bearer owner' }
    const request = await dispatch({
      method: 'POST', path: new URL(followUrl).pathname, url: followUrl,
      headers, query: {}, rawBody: Buffer.from(JSON.stringify({ acct: 'test@mastodon.example' })),
    }, deps)
    expect(request.status).toBe(201)
    expect(lookup).toHaveBeenCalledTimes(3)
    expect(JSON.parse(request.body)).toMatchObject({ state: 'pending', id: remote })
    expect(followId).toBeTruthy()
    expect(JSON.parse((await deliver(post)).body)).toMatchObject({ status: 'ignored' })
    expect((await deliver({ type: 'Accept', actor: remote, object: followId })).status).toBe(202)
    expect(JSON.parse((await deliver(post)).body)).toMatchObject({ status: 'accepted' })
    expect((await deliver(post)).status).toBe(202)
    expect(entries.size).toBe(1)

    const timeline = actor + '/timeline'
    const response = await dispatch({
      method: 'GET', path: new URL(timeline).pathname, url: timeline,
      headers, query: {}, rawBody: Buffer.alloc(0),
    }, deps)
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({
      items: [{ id: postId, actor: { id: remote }, content: '<p>A standalone QA post</p>' }],
    })
  })
})

it('records article replies from a verified non-followee and rejects private, forged, and wrong-site replies', async () => {
  const origin = 'https://martzmakes.com'
  const handle = 'martzmakes.com'
  const uri = remote + '/statuses/reply'
  const note = {
    id: uri, type: 'Note', attributedTo: remote,
    inReplyTo: `${origin}/ap/users/${handle}/articles/post1`,
    to: ['https://www.w3.org/ns/activitystreams#Public'], content: '<p>A reply<script>hidden</script></p>',
  }
  const putIfAbsent = vi.fn(async () => true)
  const remove = vi.fn(async () => true)
  const hasArticle = vi.fn(async (rkey: string) => rkey === 'post1')
  const now = Date.parse('2026-11-19T18:44:00Z')
  const ctx = {
    origin, handle, signerId: remote, followee: null, now: () => now, hasArticle,
    store: { putIfAbsent, remove, update: async () => false, page: async () => ({ records: [] }) },
  }
  expect(await ingestArticleReply('Create', { object: { ...note, inReplyTo: 'https://elsewhere.example/articles/post1' } }, ctx)).toBe('ignored')
  expect(await ingestArticleReply('Create', { object: { ...note, to: [origin] } }, ctx)).toBe('ignored')
  expect(await ingestArticleReply('Create', { object: { ...note, attributedTo: origin } }, ctx)).toBe('ignored')
  expect(putIfAbsent).not.toHaveBeenCalled()
  expect(await ingestArticleReply('Create', { object: note }, ctx)).toBe('stored')
  expect(putIfAbsent).toHaveBeenCalledExactlyOnceWith(articleRepliesPartition(handle), expect.objectContaining({
    owner: remote, sortKey: expect.stringMatching(/^post1#2026-11-19T18:44:00/),
    item: expect.objectContaining({ id: uri, actor: { id: remote, handle: 'mastodon.example' }, content: '<p>A reply</p>' }),
  }))
  expect(await ingestArticleReply('Update', { object: { ...note, to: [origin] } }, ctx)).toBe('deleted')
  expect(await ingestArticleReply('Delete', { object: uri }, ctx)).toBe('deleted')
  expect(remove).toHaveBeenCalledTimes(2)
})
