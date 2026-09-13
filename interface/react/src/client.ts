export type Session = { authenticated: boolean; phase: string; captcha: string | null; busy: boolean; loginUrl: string; verificationUrl: string; logoutUrl: string }
export type LegacyStatus = Session & { message?: string; messageI18n?: { key: string; params?: Record<string,string|number> }; diagnostics?: string[]; diagnosticsI18n?: Array<{key:string;params?:Record<string,string|number>}|null>; devices?: unknown[] }
type Contract = { $id: string; definitions: Record<string, unknown> }
let contract: Contract | undefined
export async function getContract(): Promise<Contract> { return contract ??= await json('/api/v1/contract') }
async function json<T>(url: string, init?: RequestInit): Promise<T> { const r = await fetch(url, init); const body = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(body?.error?.message || 'Request failed'), { body, status: r.status }); return body }
export const api = {
  session: () => json<Session>('/api/v1/session'),
  status: () => json<LegacyStatus>('/status'),
  login: (email: string, password: string, country: string) => json('/api/v1/session/login', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({email,password,country}) }),
  verify: (code: string) => json('/api/v1/session/verify', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({code}) }),
  refresh: () => json('/api/v1/session/refresh', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' }),
  logout: () => json('/api/v1/session/logout', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' }),
}
