export interface Jrd {
  subject: string
  links: { rel: string; type?: string; href: string }[]
}

export function buildWebfinger(
  handle: string,
  origin: string,
  host: string = 'serverless.social',
): Jrd {
  // Webfinger acct: local-part MUST equal the actor's preferredUsername
  // (Mastodon and most strict AP implementations validate this). actor.ts
  // publishes the first DNS label, so we mirror that here. Example:
  //   handle "martzmakes.com" → subject "acct:martzmakes@serverless.social"
  //   (or acct:martzmakes@martzmakes.com when `host` is its custom host).
  const username = handle.split('.')[0]
  return {
    subject: `acct:${username}@${host}`,
    links: [
      {
        rel: 'self',
        type: 'application/activity+json',
        href: `${origin}/ap/users/${handle}`,
      },
    ],
  }
}
