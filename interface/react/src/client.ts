export type Session = { authenticated: boolean; phase: string; captcha: string | null; busy: boolean; loginUrl: string; verificationUrl: string; logoutUrl: string }
export type Message = { key: string; params?: Record<string,string|number> }
export type LegacyStatus = Session & { message?: string; messageI18n?: Message; diagnostics?: string[]; diagnosticsI18n?: Array<Message|null>; devices?: unknown[] }
export type WindowInput = { serial: string; day: string; start: string; end: string; timezone: string }
export type ExpectedQuery = { serial: string; day: string; start: string; end: string; timezone: string|null }
export type NormalizedWindow = { version: 1; input: { day:string;start:string;end:string;timezone:string|null }; normalized: { start: string; end: string; timezone: string } }
export type Discovery = { status: string; completeness: string; retryable: boolean; reasons: string[]; receivedCount: number; uniqueCount: number; limitReached: boolean }
export type Device = { serial: string; name: string; model: string|null; homeBaseId: string|null; channel: number|null; availability: string; state: { reason: string; observedAt: string|null }; recordingExport: { supported: boolean; status: string }; capabilities: Record<string,{status:string;reason:string}> }
export type Artifact = { id: string; name: string; url: string; playable: boolean; validated: boolean; outcome: string|null }
export type Job = { jobId: string; requestId: string; serial: string; window: NormalizedWindow; state: string; stage: string; progress: number; result: any; artifacts: Artifact[]; error: {code:string;message:string}|null; retryOfJobId:string|null; attempt:number; cancellationRequestedAt:string|null; createdAt:string; updatedAt:string }
export type JobPage = { jobs:Job[]; nextCursor:string|null }
export type LegacyRecordings = { busy: boolean; timezone: string; message: string; messageI18n?: Message; query: ({serial:string;window:NormalizedWindow}|null); records: Array<{id:string;start:string;end:string}>; saved: Array<{id:string;device:string;serial?:string;start:string;end:string;bytes:number;url:string}> }
export type AgentTurn = { id:string; text:string; locale:'en'|'zh-CN'; state:'running'|'completed'|'failed'|'interrupted'; response:string; error?:{code:string;message:string}; notices?:Array<any> }
export type AgentState = { turns:AgentTurn[]; receipts:Array<any>; jobs:Array<any>; presentation?:any; notices:Array<any>; busy:boolean }
type Contract = { $id: string; definitions: Record<string, unknown> }
let contract: Contract | undefined
export async function getContract(): Promise<Contract> { return contract ??= await json('/api/v1/contract') }
async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = typeof body?.error === 'string' ? body.error : body?.error?.message
    throw Object.assign(new Error(message || 'Request failed'), { body, status: response.status })
  }
  return body
}
const post = <T>(url:string, body:unknown) => json<T>(url, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) })
export const api = {
  session: () => json<Session>('/api/v1/session'),
  status: () => json<LegacyStatus>('/status'),
  login: (email: string, password: string, country: string) => post('/api/v1/session/login', {email,password,country}),
  verify: (code: string) => post('/api/v1/session/verify', {code}),
  refresh: () => post('/api/v1/session/refresh', {}),
  logout: () => post('/api/v1/session/logout', {}),
  devices: () => json<{devices:Device[];discovery:Discovery}>('/api/v1/devices'),
  ranges: (input:WindowInput) => post<any>(`/api/v1/devices/${encodeURIComponent(input.serial)}/recording-ranges`, withoutSerial(input)),
  export: (requestId:string,input:WindowInput) => post<{job:Job;reused:boolean}>('/api/v1/exports', {requestId,...input}),
  job: (jobId:string) => json<{job:Job}>(`/api/v1/jobs/${encodeURIComponent(jobId)}`),
  jobs: (query:{pageSize:number;cursor?:string|null;state?:string;serial?:string}) => {
    const params=new URLSearchParams({pageSize:String(query.pageSize)})
    if(query.cursor)params.set('cursor',query.cursor);if(query.state)params.set('state',query.state);if(query.serial)params.set('serial',query.serial)
    return json<JobPage>(`/api/v1/jobs?${params}`)
  },
  cancelJob: (jobId:string) => post<{job:Job}>(`/api/v1/jobs/${encodeURIComponent(jobId)}/cancel`, {}),
  retryJob: (jobId:string,requestId:string) => post<{job:Job;reused:boolean}>(`/api/v1/jobs/${encodeURIComponent(jobId)}/retry`, {requestId}),
  recordings: () => json<LegacyRecordings>('/recordings/status'),
  eventQuery: (input:WindowInput) => post<any>('/recordings/query', input),
  eventDownload: (recordId:string,expectedQuery:ExpectedQuery) => post<any>('/recordings/download', {recordId,expectedQuery}),
  agentState: (jobIds:string[]=[]) => json<AgentState>('/interface/agent/state'+(jobIds.length?'?'+new URLSearchParams(jobIds.map(id=>['jobId',id])):'')),
  agentTurn: (turn:{id:string;text:string;locale:'en'|'zh-CN'}) => post<{id:string;reused:boolean}>('/interface/agent/turn',turn),
}
function withoutSerial({serial:_serial,...window}:WindowInput){ return window }
