export function asMetadata(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/atproto/authorize`,
    token_endpoint: `${issuer}/oauth/atproto/token`,
    pushed_authorization_request_endpoint: `${issuer}/oauth/atproto/par`,
    require_pushed_authorization_requests: true,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
    token_endpoint_auth_signing_alg_values_supported: ['ES256'],
    scopes_supported: ['atproto', 'transition:generic', 'transition:chat.bsky'],
    dpop_signing_alg_values_supported: ['ES256'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  }
}

export function protectedResourceMetadata(issuer: string) {
  return {
    resource: issuer,
    authorization_servers: [issuer],
    scopes_supported: ['atproto', 'transition:generic', 'transition:chat.bsky'],
    bearer_methods_supported: ['header'],
  }
}
