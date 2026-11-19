import { PutCommand, GetCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb'

const ttl = (sec: number) => Math.floor(Date.now() / 1000) + sec

function isConditionalCheckFailed(err: any): boolean {
  return err?.name === 'ConditionalCheckFailedException'
}

export class OAuthStore {
  constructor(private doc: any, private table: string) {}

  private put(Item: any) { return this.doc.send(new PutCommand({ TableName: this.table, Item })) }
  private get(pk: string, sk: string) { return this.doc.send(new GetCommand({ TableName: this.table, Key: { pk, sk } })) }
  private del(pk: string, sk: string) { return this.doc.send(new DeleteCommand({ TableName: this.table, Key: { pk, sk } })) }

  async putPar(uri: string, req: any, sec: number) {
    await this.put({ pk: `PAR#${uri}`, sk: 'PAR', req, ttl: ttl(sec) })
  }
  async takePar(uri: string) {
    const r = await this.get(`PAR#${uri}`, 'PAR')
    if (!r.Item) return null
    await this.del(`PAR#${uri}`, 'PAR')
    return r.Item.req
  }
  async putAuthRequest(code: string, req: any) {
    await this.put({ pk: `AUTH#${code}`, sk: 'AUTH', ...req, authCode: code, approved: false, ttl: ttl(900) })
  }
  async getAuthRequest(code: string) { return (await this.get(`AUTH#${code}`, 'AUTH')).Item ?? null }
  async approveAuthRequest(code: string, who: { did: string; email: string }) {
    const cur = await this.getAuthRequest(code)
    if (!cur) throw new Error('auth-request not found')
    await this.put({ ...cur, approved: true, did: who.did, email: who.email })
  }
  async consumeAuthRequest(code: string) {
    try {
      const res = await this.doc.send(new DeleteCommand({
        TableName: this.table,
        Key: { pk: `AUTH#${code}`, sk: 'AUTH' },
        ConditionExpression: 'attribute_exists(pk)',
        ReturnValues: 'ALL_OLD',
      }))
      return res.Attributes ?? null
    } catch (err: any) {
      if (isConditionalCheckFailed(err)) return null
      throw err
    }
  }
  async cacheClient(clientId: string, meta: any) {
    await this.put({ pk: `CLIENT#${clientId}`, sk: 'CLIENT', meta, ttl: ttl(3600) })
  }
  async getClient(clientId: string) { return (await this.get(`CLIENT#${clientId}`, 'CLIENT')).Item?.meta ?? null }
  async putRefresh(token: string, data: { did: string; jkt: string; clientId: string; scope: string }) {
    await this.put({ pk: `RT#${token}`, sk: 'RT', ...data, ttl: ttl(60 * 60 * 24 * 90) })
  }
  async takeRefresh(token: string) {
    try {
      const res = await this.doc.send(new DeleteCommand({
        TableName: this.table,
        Key: { pk: `RT#${token}`, sk: 'RT' },
        ConditionExpression: 'attribute_exists(pk)',
        ReturnValues: 'ALL_OLD',
      }))
      return res.Attributes ?? null
    } catch (err: any) {
      if (isConditionalCheckFailed(err)) return null
      throw err
    }
  }
  async seenJti(jti: string, sec: number) {
    try {
      await this.doc.send(new PutCommand({
        TableName: this.table,
        Item: { pk: `JTI#${jti}`, sk: 'JTI', ttl: ttl(sec) },
        ConditionExpression: 'attribute_not_exists(pk)',
      }))
      return false // first sighting
    } catch (err: any) {
      if (isConditionalCheckFailed(err)) return true // already seen
      throw err
    }
  }
}
