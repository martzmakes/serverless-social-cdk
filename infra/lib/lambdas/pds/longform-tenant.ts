export interface TenantLike { did: string; handle: string; isApex: boolean }
export interface ApexCfg { apexOrigin: string; apexSiteName: string; apexHandle: string }
export interface RenderTarget { origin: string; siteName: string; author: string; s3Prefix: string }

export function renderTargetForTenant(t: TenantLike, apex: ApexCfg): RenderTarget {
  if (t.isApex) return { origin: apex.apexOrigin, siteName: apex.apexSiteName, author: apex.apexHandle, s3Prefix: '' }
  return { origin: `https://${t.handle}`, siteName: t.handle, author: t.handle, s3Prefix: `t/${t.handle}/` }
}
