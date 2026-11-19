export interface ApActor {
  '@context': string[]
  id: string
  type: 'Person'
  /**
   * The first DNS label of the handle.
   * For an apex handle like "serverless.social" this is "serverless";
   * for a sub-user handle like "alice.serverless.social" this is "alice".
   * This matches how most AP implementations display usernames and avoids
   * redundancy with the domain portion of the webfinger acct: URI.
   */
  preferredUsername: string
  inbox: string
  outbox: string
  followers: string
  publicKey: {
    id: string
    owner: string
    publicKeyPem: string
  }
  /** AT Protocol URI for the underlying DID, enabling Bluesky interop */
  alsoKnownAs: string[]
  name: string
  summary?: string
  url: string
  icon?: ApImage
  image?: ApImage
  following: string
  endpoints: { sharedInbox: string }
  discoverable: boolean
  manuallyApprovesFollowers: boolean
}

export interface ApImage {
  type: 'Image'
  url: string
  mediaType?: string
}

/** Subset of the AT app.bsky.actor.profile record the actor doc needs. */
export interface ApProfile {
  displayName?: string
  description?: string
  avatarCid?: string
  avatarMime?: string
  bannerCid?: string
  bannerMime?: string
}

export interface BuildActorExtra {
  /** Missing/partial profile is fine (fallbacks apply). */
  profile?: ApProfile | null
  /** Origin that serves com.atproto.sync.getBlob (default: `origin`). */
  blobOrigin?: string
  /** Human profile page. Default https://<handle>/ . */
  profileUrl?: string
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Plain-text bio -> minimal HTML paragraphs (Mastodon renders summary as HTML). */
function bioToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('')
}

export function buildActor(
  account: { did: string; handle: string },
  publicKeyPem: string,
  origin: string,
  extra: BuildActorExtra = {},
): ApActor {
  const id = `${origin}/ap/users/${account.handle}`
  // First DNS label: "serverless" for "serverless.social", "alice" for "alice.serverless.social"
  const preferredUsername = account.handle.split('.')[0]

  const profile = extra.profile ?? null
  const blobOrigin = extra.blobOrigin ?? origin
  const blobUrl = (cid: string) =>
    `${blobOrigin}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(
      account.did,
    )}&cid=${encodeURIComponent(cid)}`
  const img = (cid?: string, mime?: string): ApImage | undefined =>
    cid
      ? { type: 'Image', url: blobUrl(cid), ...(mime ? { mediaType: mime } : {}) }
      : undefined
  const icon = img(profile?.avatarCid, profile?.avatarMime)
  const image = img(profile?.bannerCid, profile?.bannerMime)
  const displayName = profile?.displayName?.trim()
  const description = profile?.description?.trim()

  return {
    '@context': [
      'https://www.w3.org/ns/activitystreams',
      'https://w3id.org/security/v1',
    ],
    id,
    type: 'Person',
    preferredUsername,
    inbox: `${id}/inbox`,
    outbox: `${id}/outbox`,
    followers: `${id}/followers`,
    publicKey: {
      id: `${id}#main-key`,
      owner: id,
      publicKeyPem,
    },
    alsoKnownAs: [`at://${account.did}`],
    name: displayName || account.handle,
    ...(description ? { summary: bioToHtml(description) } : {}),
    url: extra.profileUrl ?? `https://${account.handle}/`,
    ...(icon ? { icon } : {}),
    ...(image ? { image } : {}),
    following: `${id}/following`,
    // No shared-inbox route yet: point at this actor's own inbox (safe — we
    // only act on Follow/Undo, which carry the target in the activity).
    endpoints: { sharedInbox: `${id}/inbox` },
    discoverable: true,
    manuallyApprovesFollowers: false,
  }
}
