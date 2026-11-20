import { generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dispatch, type ApDeps } from '../lib/lambdas/ap/handler'
import { outboxIndexFromItems, realFetchJson, realFetchRemoteActor } from '../lib/lambdas/ap-deps'
import type { FollowingRow } from '../lib/lambdas/ap/following'
import { articleRepliesPartition, ingestArticleReply, type InboundRecord } from '../lib/lambdas/ap/ingest'
import type { OutgoingArticleReply } from '../lib/lambdas/ap/article-replies'
import { deliverOne, processOne, type DeliverDeps } from '../lib/lambdas/ap/deliver'
import { wrapCreate } from '../lib/lambdas/ap/outbox'
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
    const outgoing = new Map<string, OutgoingArticleReply>()
    const commentId = remote + '/statuses/comment'
    const send = vi.fn(async () => 'delivered' as const)
    const sendBluesky = vi.fn(async () => ({ status: 'sent' as const, url: 'https://bsky.app/profile/test/post/3test' }))
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
      articleReplies: {
        incoming: async () => undefined,
        outgoing: async (_handle, id) => outgoing.get(id),
        putOutgoing: async (_handle, value) => { outgoing.set(value.requestId, value); return true },
      },
      deliverArticleReply: send,
      sendBlueskyInboxReply: sendBluesky,
      inbound: {
        get: async (owner, key) => entries.get(owner + ':' + key),
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
    deps.fetchActorJson = vi.fn(async target => {
      if (target === postId) return { ...post.object, replies: { items: [commentId] } }
      if (target === commentId) return { ...post.object, id: commentId, inReplyTo: postId, content: '<p>Comment<script>hidden</script></p>' }
      throw new Error('Unexpected fetch')
    })
    deps.fetchRemoteActor = async author => ({ id: author, inbox, publicKeyPem: follower.publicKey })
    const threadRoute = { method: 'GET', url: timeline + '/thread', path: new URL(timeline + '/thread').pathname,
      headers, query: { post: postId }, rawBody: Buffer.alloc(0) }
    expect((await dispatch({ ...threadRoute, headers: {} }, deps)).status).toBe(401)
    expect((await dispatch({ ...threadRoute, query: { post: 'https://another.example/not-followed' } }, deps)).status).toBe(422)
    expect(deps.fetchActorJson).not.toHaveBeenCalled()
    expect(JSON.parse((await dispatch(threadRoute, deps)).body)).toMatchObject({
      canReply: true, replies: [{ id: commentId, content: '<p>Comment</p>', depth: 0 }],
    })
    const requestId = '46a13253-7c58-41be-9f2e-bb3aa900943b'
    const responseFor = (data: object) => dispatch({ ...threadRoute, method: 'POST',
      rawBody: Buffer.from(JSON.stringify({ post: postId, requestId, text: 'My reply', ...data })) }, deps)
    expect((await responseFor({ network: 'Fediverse' })).status).toBe(200)
    expect((await responseFor({ network: 'Fediverse' })).status).toBe(200)
    expect((await responseFor({ network: 'Fediverse', text: 'Different reply' })).status).toBe(409)
    expect(outgoing.size).toBe(1)
    expect(send).toHaveBeenLastCalledWith(handle, actor, expect.objectContaining({
      note: expect.objectContaining({ attributedTo: actor, inReplyTo: postId, to: [remote] }),
    }))
    const bskyPost = 'at://did:plc:note/app.bsky.feed.post/3test'
    expect((await responseFor({ network: 'Bluesky', post: bskyPost })).status).toBe(200)
    expect(sendBluesky).toHaveBeenCalledExactlyOnceWith({ did, origin, token: 'owner', post: bskyPost, requestId, text: 'My reply' })

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

it('authorizes the addressed AP identity, sends a signed threaded reply, and routes a response back to the article', async () => {
  const did = 'did:plc:example'
  const handle = 'martzmakes.com'
  const origin = `https://${handle}`
  const actor = `${origin}/ap/users/${handle}`
  const apParent = remote + '/statuses/reply'
  const apRecord: InboundRecord = {
    key: 'stored', sortKey: 'post1#2026-11-19T18:44:00.000Z#abcdef0123456789',
    owner: remote, ttl: Math.floor(Date.now() / 1000) + 1000,
    item: { id: apParent, url: apParent, actor: { id: remote, handle: 'test@mastodon.example' }, content: '<p>Reply</p>',
      published: new Date().toISOString(), attachments: [] },
  }
  const saved = new Map<string, OutgoingArticleReply>()
  const received = vi.fn(async (_handle: string, _record: InboundRecord) => true)
  const ledger = new Set<string>()
  const accepted = vi.fn(async (to: string, opts: { headers: Record<string, string>; body: Buffer }) => {
    expect(to).toBe(inbox)
    expect(await verifyRequest({ method: 'POST', path: new URL(inbox).pathname, headers: opts.headers, body: opts.body }, publisher.publicKey)).toBe(true)
    expect(JSON.parse(opts.body.toString())).toMatchObject({
      actor, type: 'Create', object: { type: 'Note', attributedTo: actor, inReplyTo: apParent, content: '<p>Thanks &lt;friend&gt;</p>',
        to: [remote], cc: ['https://www.w3.org/ns/activitystreams#Public'],
        tag: [{ type: 'Mention', href: remote, name: '@test@mastodon.example' }],
      },
    })
    return { status: 202 }
  })
  const deps: ApDeps = {
    tenantStore: { byHandle: async name => ({ did, handle: name, status: 'active' }), byDid: async () => null, listActive: async () => [] },
    customHosts: [handle],
    getApKey: async () => ({ privatePem: publisher.privateKey, publicPem: publisher.publicKey }),
    authenticateOwner: async auth => auth === 'Bearer writer' ? did : 'did:plc:other',
    verifyRequest, signRequest, deliverActivity: async () => { throw new Error('No short-post or follow delivery expected') },
    fetchRemoteActor: async () => ({ id: remote, inbox, publicKeyPem: follower.publicKey }),
    actorCache: { get: async () => null, put: async () => {} },
    followers: { add: async () => {}, remove: async () => {}, list: async () => [] },
    following: { get: async () => null, put: async () => {}, setAccepted: async () => false, remove: async () => {}, list: async () => [] },
    fetchJson: async () => { throw new Error('Unexpected object lookup') },
    inbound: { putIfAbsent: received, page: async () => ({ records: [] }), update: async () => false, remove: async () => false },
    getArticle: async (selected, key) => selected === did && key === 'post1'
      ? { slug: 'article', record: { title: 'Article', slug: 'article', content: 'body', createdAt: new Date().toISOString() } } : null,
    listOutbox: async () => ({ records: [] }), countOutbox: async () => 0, getOutboxPost: async () => null,
    articleReplies: {
      incoming: async (owner, id) => owner === handle && id === apParent ? apRecord : undefined,
      outgoing: async (owner, id) => owner === handle ? saved.get(id) : undefined,
      putOutgoing: async (_owner, item) => {
        if (saved.has(item.requestId)) return false
        saved.set(item.requestId, item)
        return true
      },
    },
    deliverArticleReply: (owner, author, item) => {
      const create = wrapCreate(author, item.note)
      return deliverOne({
        handle: owner, activityId: create.id, inbox: item.inbox, actorIds: [],
        body: Buffer.from(JSON.stringify(create)),
      }, { keyId: actor + '#main-key', privatePem: publisher.privateKey }, {
        followers: { list: async () => [], remove: async () => {} },
        ledger: {
          claim: async key => !ledger.has(key), complete: async key => { ledger.add(key) }, release: async () => {},
        },
        retryQueue: { enqueue: async () => { throw new Error('Unexpected retry') } },
        signRequest, postFetch: accepted,
      }, 'stream')
    },
  }
  const requestId = 'd79baf35-8709-4c9c-92f9-85b561438fdc'
  const url = actor + '/replies'
  const body = { articleRkey: 'post1', parentId: apParent, text: 'Thanks <friend>', requestId }
  const request = (value: object, token = 'writer') => dispatch({
    method: 'POST', url, path: new URL(url).pathname, query: {},
    headers: { authorization: 'Bearer ' + token }, rawBody: Buffer.from(JSON.stringify(value)),
  }, deps)
  expect((await request(body, 'other')).status).toBe(401)
  expect((await request({ ...body, articleRkey: 'other' })).status).toBe(422)
  const sent = await request(body)
  expect(JSON.parse(sent.body)).toEqual({ status: 'sent', url: `${url}/${requestId}` })
  await request(body)
  expect((await request({ ...body, text: 'different' })).status).toBe(409)
  expect(accepted).toHaveBeenCalledTimes(1)
  const outUrl = `${url}/${requestId}`
  const object = await dispatch({ method: 'GET', url: outUrl, path: new URL(outUrl).pathname, query: {}, headers: {}, rawBody: Buffer.alloc(0) }, deps)
  expect(object.status).toBe(200)
  expect(JSON.parse(object.body)).toMatchObject({ id: outUrl, attributedTo: actor, inReplyTo: apParent })

  const inboxUrl = actor + '/inbox'
  const inbound = Buffer.from(JSON.stringify({ type: 'Create', actor: remote, object: {
    type: 'Note', id: remote + '/statuses/reply-to-reply',
    attributedTo: remote, inReplyTo: outUrl, content: '<p>Thanks!</p>', cc: ['https://www.w3.org/ns/activitystreams#Public'],
  } }))
  const headers = lowercase(await signRequest({ method: 'POST', url: inboxUrl, body: inbound, keyId, privateKeyPem: follower.privateKey }))
  const inboundResult = await dispatch({
    method: 'POST', url: inboxUrl, path: new URL(inboxUrl).pathname, query: {}, headers, rawBody: inbound,
  }, deps)
  expect(inboundResult.status).toBe(202)
  expect(received).toHaveBeenCalledExactlyOnceWith(articleRepliesPartition(handle), expect.objectContaining({
    owner: remote, sortKey: expect.stringMatching(/^post1#/),
  }))
})

it('keeps control-room Bluesky replies out of AP push delivery and the outbox', async () => {
  const did = 'did:plc:example'
  const sender = vi.fn()
  const deps: DeliverDeps = {
    resolveHandle: async () => ({ handle: 'martzmakes.com' }),
    loadPostRecord: async () => ({ text: 'a reply', reply: true }),
    loadLongform: async () => null, getLongformIndex: async () => null,
    isSyndicationLink: async () => false,
    isBlueskyOnly: async (selected, rkey) => selected === did && rkey === 'blue-only',
    followers: { list: async () => [{ actorId: remote, inbox }], remove: async () => {} },
    ledger: { claim: async () => true, complete: async () => {}, release: async () => {} },
    retryQueue: { enqueue: async () => {} },
    getApKey: async () => ({ privatePem: publisher.privateKey }), signRequest, postFetch: sender,
  }
  for (const op of ['create', 'update', 'delete'] as const) await processOne({ did, rkey: 'blue-only', op }, deps, 'stream')
  expect(sender).not.toHaveBeenCalled()
  expect(outboxIndexFromItems([], ['blue-only']).suppressedPostRkeys).toEqual(new Set(['blue-only']))
})
