/**
 * Shared error type for Spec #6 T6–T8 MCP tools.
 *
 * Codes used by T6 (create_post):
 *   - 'invalid_account'    — input failed shape validation
 *   - 'not_entitled'       — account arg not in caller's entitlement list
 *   - 'pds_error'          — PDS returned non-2xx (detail = {status, body})
 *   - 'payload_too_large'  — embed image > 7.5 MB raw
 *
 * Reserved for T7/T8 (so neither file has to re-extend this class):
 *   - 'slug_conflict'  (T7)
 *   - 'uri_mismatch'   (T8)
 *   - 'not_found'      (T8)
 */
export class McpToolError extends Error {
  constructor(
    public code:
      | 'not_entitled'
      | 'invalid_account'
      | 'pds_error'
      | 'payload_too_large'
      | 'slug_conflict' // reserved for T7
      | 'uri_mismatch' // reserved for T8
      | 'not_found' // reserved for T8; also get_page_views: slug not in the index
      | 'invalid_days' // get_page_views
      | 'invalid_slug', // get_page_views
    public detail?: unknown,
  ) {
    super(code)
    this.name = 'McpToolError'
  }
}
