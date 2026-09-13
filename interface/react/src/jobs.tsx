import React, { FormEvent, useEffect, useMemo, useState } from 'react'
import { api, type Job, type JobPage } from './client'
import { JobResultCard, jobStatus } from './job-result'

type Language='en'|'zh-CN'
type Filters={state:string;serial:string;pageSize:number}
const retryStorageKey='eufy-agent-hub.job-retry-actions'
const initialFilters:Filters={state:'',serial:'',pageSize:25}
const words={
  en:{title:'Export task center',intro:'Durable tasks from the browser, CLI and assistant are listed by the resident. State filters are evaluated when each page is read, not from a transaction snapshot.',state:'State',allStates:'All states',device:'Camera serial',deviceHint:'All cameras',pageSize:'Rows per page',apply:'Apply filters',loading:'Loading tasks…',empty:'No retained export tasks match these filters.',task:'Task',updated:'Updated',inspect:'Inspect task',previous:'Previous page',next:'Next page',details:'Task details',attempt:'Attempt',retryOf:'Retry of',cancel:'Cancel task',retry:'Retry task',working:'Working…',storage:'Browser storage is unavailable. A stable retry request ID could not be saved, so retry was blocked.',queued:'Queued',running:'Running',succeeded:'Succeeded',failed:'Failed',cancelled:'Cancelled'},
  'zh-CN':{title:'导出任务中心',intro:'常驻服务会列出浏览器、CLI 和助手提交的持久任务。状态过滤在读取每一页时计算，并非事务快照。',state:'状态',allStates:'全部状态',device:'摄像头序列号',deviceHint:'全部摄像头',pageSize:'每页行数',apply:'应用过滤',loading:'正在读取任务…',empty:'没有符合过滤条件的持久导出任务。',task:'任务',updated:'更新时间',inspect:'查看任务',previous:'上一页',next:'下一页',details:'任务详情',attempt:'尝试次数',retryOf:'重试来源',cancel:'取消任务',retry:'重试任务',working:'处理中…',storage:'浏览器存储不可用，无法先保存稳定的重试请求编号，因此已阻止重试。',queued:'排队中',running:'进行中',succeeded:'成功',failed:'失败',cancelled:'已取消'},
} as const

function loadRetryActions(){try{const value=JSON.parse(localStorage.getItem(retryStorageKey)||'{}');return value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).filter(([,id])=>typeof id==='string'&&id)):{} }catch{return {}}}
function problem(error:any){return error?.body?.error||{code:'SERVICE_UNAVAILABLE',message:error?.message||'Request failed'}}

export function JobCenter({language,catalog}:{language:Language;catalog:Record<string,string>}){
  const c=words[language],i18n=useMemo(()=>({t:(key:string,params:Record<string,any>={},fallback=key)=>(catalog[key]||fallback).replace(/\{(\w+)\}/g,(_:string,k:string)=>String(params[k]??''))}),[catalog])
  const [draft,setDraft]=useState<Filters>(initialFilters),[filters,setFilters]=useState<Filters>(initialFilters)
  const [cursor,setCursor]=useState<string|null>(null),[history,setHistory]=useState<Array<string|null>>([])
  const [page,setPage]=useState<JobPage>(),[selected,setSelected]=useState<Job>(),[loading,setLoading]=useState(true),[error,setError]=useState<any>(),[actionError,setActionError]=useState<any>()
  const [busy,setBusy]=useState(false),[refreshKey,setRefreshKey]=useState(0),[retryActions,setRetryActions]=useState(loadRetryActions)
  const message=(value:any)=>value?.code==='STORAGE_REQUIRED'?c.storage:catalog[`ui.error.${value?.code}`]||value?.message||catalog['ui.error.SERVICE_UNAVAILABLE']||'Request failed'

  useEffect(()=>{let active=true,inFlight=false
    const load=async(first=false)=>{if(inFlight)return;inFlight=true;if(first)setLoading(true)
      try{const value=await api.jobs({...filters,cursor});if(!active)return;setPage(value);setError(undefined);setSelected(current=>value.jobs.find(job=>job.jobId===current?.jobId)||value.jobs[0])}
      catch(value){if(active)setError(problem(value))}finally{inFlight=false;if(active)setLoading(false)}}
    load(true);const timer=setInterval(()=>load(),1200);return()=>{active=false;clearInterval(timer)}
  },[filters,cursor,refreshKey])

  const apply=(event:FormEvent)=>{event.preventDefault();setFilters({...draft,serial:draft.serial.trim()});setCursor(null);setHistory([]);setActionError(undefined)}
  const replace=(job:Job)=>{setPage(current=>current?{...current,jobs:current.jobs.map(item=>item.jobId===job.jobId?job:item)}:current);setSelected(job)}
  const cancel=async()=>{if(!selected)return;setBusy(true);setActionError(undefined);try{replace((await api.cancelJob(selected.jobId)).job)}catch(value){setActionError(problem(value))}finally{setBusy(false)}}
  const retry=async()=>{if(!selected)return;setBusy(true);setActionError(undefined);let requestId=retryActions[selected.jobId]
    if(!requestId){requestId=`job-retry-${crypto.randomUUID()}`;const next={...retryActions,[selected.jobId]:requestId};try{localStorage.setItem(retryStorageKey,JSON.stringify(next));setRetryActions(next)}catch{setActionError({code:'STORAGE_REQUIRED'});setBusy(false);return}}
    try{const value=await api.retryJob(selected.jobId,requestId);const next={...retryActions};delete next[selected.jobId];try{localStorage.setItem(retryStorageKey,JSON.stringify(next))}catch{}setRetryActions(next);if(filters.state&&filters.state!==value.job.state){setFilters({...filters,state:''});setDraft(current=>({...current,state:''}))}setSelected(value.job);setCursor(null);setHistory([]);setRefreshKey(key=>key+1)}
    catch(value){setActionError(problem(value))}finally{setBusy(false)}}
  const status=(job:Job)=>catalog[`ui.job.${jobStatus(job)}`]||jobStatus(job)
  const canCancel=selected&&['queued','running'].includes(selected.state),canRetry=selected&&['failed','cancelled'].includes(selected.state)

  return <section className="task-center" aria-labelledby="task-center-title"><h2 id="task-center-title">{c.title}</h2><p>{c.intro}</p>
    <form className="task-filters" onSubmit={apply}><label>{c.state}<select value={draft.state} onChange={event=>setDraft(value=>({...value,state:event.target.value}))}><option value="">{c.allStates}</option>{(['queued','running','succeeded','failed','cancelled'] as const).map(value=><option key={value} value={value}>{c[value]}</option>)}</select></label><label>{c.device}<input value={draft.serial} placeholder={c.deviceHint} onChange={event=>setDraft(value=>({...value,serial:event.target.value}))}/></label><label>{c.pageSize}<select value={draft.pageSize} onChange={event=>setDraft(value=>({...value,pageSize:Number(event.target.value)}))}>{[1,25,100].map(value=><option key={value}>{value}</option>)}</select></label><button type="submit">{c.apply}</button></form>
    {loading&&<p role="status">{c.loading}</p>}{error&&<p role="status" className="error">{message(error)}</p>}
    {!loading&&!error&&page&&!page.jobs.length&&<p>{c.empty}</p>}
    {page?.jobs.length?<div className="task-table-wrap"><table className="task-table"><thead><tr><th>{c.task}</th><th>{c.device}</th><th>{c.state}</th><th>{c.updated}</th></tr></thead><tbody>{page.jobs.map(job=><tr key={job.jobId} className={selected?.jobId===job.jobId?'selected':''}><td><button type="button" className="link" aria-label={`${c.inspect} ${job.requestId}`} onClick={()=>{setSelected(job);setActionError(undefined)}}>{job.requestId}</button></td><td>{job.serial}</td><td>{status(job)}</td><td><time dateTime={job.updatedAt}>{job.updatedAt}</time></td></tr>)}</tbody></table></div>:null}
    <div className="pager"><button type="button" disabled={!history.length||loading} onClick={()=>{const previous=history.at(-1)??null;setHistory(value=>value.slice(0,-1));setCursor(previous)}}>{c.previous}</button><button type="button" disabled={!page?.nextCursor||loading} onClick={()=>{setHistory(value=>[...value,cursor]);setCursor(page!.nextCursor)}}>{c.next}</button></div>
    {selected&&<section className="task-details" aria-labelledby="task-details-title"><h3 id="task-details-title">{c.details}</h3><p>{c.attempt}: {selected.attempt}{selected.retryOfJobId?` · ${c.retryOf}: ${selected.retryOfJobId}`:''}</p><div className="task-actions">{canCancel&&<button type="button" disabled={busy||Boolean(selected.cancellationRequestedAt)} onClick={cancel}>{busy?c.working:c.cancel}</button>}{canRetry&&<button type="button" disabled={busy} onClick={retry}>{busy?c.working:c.retry}</button>}</div>{actionError&&<p role="status" className="error">{message(actionError)}</p>}<JobResultCard key={selected.jobId} job={selected} i18n={i18n}/></section>}
  </section>
}
