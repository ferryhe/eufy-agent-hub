import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api, type Device, type Discovery, type ExpectedQuery, type Job, type LegacyRecordings, type WindowInput } from './client'
import { createResults } from '../../components/results.mjs'
import { JobResultCard } from './job-result'

type Language = 'en'|'zh-CN'
type Intent = { requestId:string; input:WindowInput; submitted:boolean; jobId?:string }
type Store = { version:1; intent?:Intent; jobIds:string[] }
const storageKey = 'eufy-agent-hub.recording-workbench'
const fingerprint = (input:WindowInput) => JSON.stringify(input)
const today = () => new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Toronto',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())
const emptyInput = ():WindowInput => ({serial:'',day:today(),start:'16:30',end:'16:50',timezone:'America/Toronto'})

const words = {
  en: {
    title:'Recording workbench', intro:'Choose the exact resident camera and one same-day window. Event recordings and continuous availability are independent results.',
    exact:'Exact camera', choose:'Choose a camera by serial', identity:'Names can repeat; the serial, HomeBase and channel identify the selection.',
    date:'Date', start:'Start time', end:'End time', timezone:'Service timezone', events:'Event recordings', findEvents:'Find event recordings',
    eventsSeparate:'Event recordings are separate from continuous availability.', requeryEvents:'The camera or time no longer matches these event results. Query event recordings again.',
    eventCount:(n:number)=>`${n} event recording${n===1?'':'s'} found.`,
    noEvents:'No event recordings in this window. This does not determine continuous recording availability.', exportEvent:'Export this event recording',
    continuous:'Continuous recording', check:'Check continuous availability', available:'Continuous index ranges are available; they do not prove complete coverage.',
    noContinuous:'The continuous index has no footage for this window.', exportContinuous:'Export requested continuous window', jobs:'Known continuous export tasks',
    saved:'Saved event recordings', savedHint:'Previously saved event exports remain separate from durable continuous jobs.', savedDownload:'Download saved event recording',
    loading:'Loading devices…', working:'Working…', noDevices:'No recording camera was returned. Retry discovery or refresh the resident inventory.',
    ambiguous:'Choose one exact camera. The resident returned multiple possible devices.', missing:'The selected camera is no longer in the resident inventory.',
    discoveryUnknown:'Device discovery succeeded, but account completeness is unknown. This list must not be treated as complete.',
    discoveryFailed:'Device discovery failed or is incomplete. Retry before choosing a camera.', retry:'Retry',
    changed:'The camera or time changed. You must explicitly confirm a new export intent.', acknowledge:'I confirm the camera or time changed and want a new export intent.',
    intent:'Current export request ID', existing:'This window already has a durable export task. Its status was refreshed; no retry was created.',
    storage:'Browser storage is unavailable. A durable request intent cannot be saved, so export is blocked.',
    lost:'The submission connection was lost. The intent is saved; refresh or press export again to reuse the same request ID.',
    crossMidnight:'The end must be later on the same calendar day. Split a cross-midnight request into two same-day windows; the date or timezone was not changed.',
    signedOut:'Sign in to query devices or start recordings. Known jobs and saved event exports remain available.',
  },
  'zh-CN': {
    title:'录像工作台', intro:'选择常驻服务中的确切摄像头和同一天内的时间窗口。事件录像与连续录像范围是相互独立的结果。',
    exact:'确切摄像头', choose:'按序列号选择摄像头', identity:'名称可能重复；序列号、HomeBase 和通道共同确定所选设备。',
    date:'日期', start:'开始时间', end:'结束时间', timezone:'服务时区', events:'事件录像', findEvents:'查询事件录像',
    eventsSeparate:'事件录像结果与连续录像范围分开显示。', requeryEvents:'摄像头或时间已与这些事件结果不符，请重新查询事件录像。',
    eventCount:(n:number)=>`找到 ${n} 段事件录像。`,
    noEvents:'此时间窗口没有事件录像；这不能说明连续录像也为空。', exportEvent:'导出此事件录像',
    continuous:'连续录像', check:'检查连续录像范围', available:'连续录像索引存在可用区间，但不代表覆盖完整。',
    noContinuous:'连续录像索引在此时间窗口没有录像。', exportContinuous:'导出请求的连续录像时段', jobs:'已知连续导出任务',
    saved:'已保存的事件录像', savedHint:'以前保存的事件导出与持久连续任务仍然分开。', savedDownload:'下载已保存的事件录像',
    loading:'正在读取设备…', working:'处理中…', noDevices:'常驻服务未返回录像摄像头。请重试发现或刷新设备清单。',
    ambiguous:'请选择一个确切摄像头。常驻服务返回了多个可能设备。', missing:'所选摄像头已不在常驻服务设备清单中。',
    discoveryUnknown:'设备发现已成功，但账号清单完整度未知，不能把当前列表当作完整清单。',
    discoveryFailed:'设备发现失败或不完整。选择摄像头前请重试。', retry:'重试',
    changed:'摄像头或时间已更改，必须明确确认新的导出意图。', acknowledge:'我确认设备或时间已更改，并要创建新的导出意图。',
    intent:'当前导出请求编号', existing:'此窗口已有持久导出任务。已刷新状态，没有创建重试。',
    storage:'浏览器存储不可用，无法先保存持久请求意图，因此已阻止导出。',
    lost:'提交连接已中断。请求意图已保存；刷新或再次导出会复用同一请求编号。',
    crossMidnight:'结束时间必须晚于同一日的开始时间。跨午夜请求请拆成两个同日窗口；页面没有更改日期或时区。',
    signedOut:'请登录后查询设备或开始录像。已知任务与已保存事件录像仍可访问。',
  },
} as const

function loadStore():Store {
  try {
    const value=JSON.parse(localStorage.getItem(storageKey)||'null')
    if(value?.version===1&&Array.isArray(value.jobIds)) return value
  } catch {}
  return {version:1,jobIds:[]}
}
function saveStore(intent:Intent|undefined,jobIds:string[]) {
  try { localStorage.setItem(storageKey,JSON.stringify({version:1,intent,jobIds})); return true } catch { return false }
}
function fault(error:any) {
  const body=error?.body
  if(body?.error&&typeof body.error==='object') return body.error
  return {code:body?.errorI18n?.key||'SERVICE_UNAVAILABLE',message:typeof body?.error==='string'?body.error:error?.message}
}
const eventFingerprint=(serial:string,window:{day:string;start:string;end:string;timezone:string|null})=>JSON.stringify([serial,window.day,window.start,window.end,window.timezone])

function Timeline({value,i18n,label}:{value:any;i18n:any;label:string}) {
  const root=useRef<HTMLDivElement>(null)
  useEffect(()=>{root.current!.replaceChildren(createResults({document,i18n}).timeline({window:value.window,ranges:value.ranges,label}))},[value,i18n,label])
  return <div ref={root}/>
}
function DeviceCard({device,i18n}:{device:Device;i18n:any}) {
  const root=useRef<HTMLDivElement>(null)
  useEffect(()=>{root.current!.replaceChildren(createResults({document,i18n}).device(device))},[device,i18n])
  return <div ref={root}/>
}
function SavedPlayers({clips,i18n,download}:{clips:LegacyRecordings['saved'];i18n:any;download:string}) {
  const root=useRef<HTMLDivElement>(null)
  useEffect(()=>{const results=createResults({document,i18n}),keys=new Set(clips.map(clip=>clip.id))
    for(const clip of clips){let card=[...root.current!.children].find((item:any)=>item.dataset.artifact===clip.id) as HTMLElement
      if(!card){card=results.player(clip,clip.device);card.dataset.artifact=clip.id;root.current!.append(card)}
      card.querySelector('strong')!.textContent=`${clip.device} · ${clip.start}`;const link=card.querySelector('a')!;link.textContent=download;link.setAttribute('aria-label',download)}
    for(const card of [...root.current!.children] as HTMLElement[]) if(!keys.has(card.dataset.artifact!)) card.remove()
  },[clips,i18n,download])
  return <div className="player-grid" ref={root}/>
}

export function RecordingWorkbench({authenticated,language,catalog,inventoryKey}:{authenticated:boolean;language:Language;catalog:Record<string,string>;inventoryKey:string}) {
  const c=words[language],initial=useRef(loadStore()).current
  const [input,setInput]=useState<WindowInput>(initial.intent?.input||emptyInput)
  const [intent,setIntent]=useState<Intent|undefined>(initial.intent)
  const [jobIds,setJobIds]=useState<string[]>(initial.jobIds)
  const [jobs,setJobs]=useState<Record<string,Job>>({})
  const [jobErrors,setJobErrors]=useState<Record<string,any>>({})
  const [devices,setDevices]=useState<Device[]>([]),[discovery,setDiscovery]=useState<Discovery>(),[deviceError,setDeviceError]=useState<any>(),[deviceLoading,setDeviceLoading]=useState(false),[deviceLoaded,setDeviceLoaded]=useState(false)
  const [legacy,setLegacy]=useState<LegacyRecordings>(),[legacyError,setLegacyError]=useState<any>(),[eventSearching,setEventSearching]=useState(false)
  const [confirmedEvent,setConfirmedEvent]=useState('')
  const [range,setRange]=useState<any>(),[rangeError,setRangeError]=useState<any>(),[rangeLoading,setRangeLoading]=useState(false)
  const [exportError,setExportError]=useState<any>(),[submitting,setSubmitting]=useState(false),[acknowledged,setAcknowledged]=useState(false),[notice,setNotice]=useState('')
  const [storageOk,setStorageOk]=useState(()=>saveStore(initial.intent,initial.jobIds))
  const recoveryStarted=useRef(false)
  const jobRequests=useRef<Record<string,Promise<boolean>>>({})
  const acceptEventResults=useRef(true)
  const i18n=useMemo(()=>({t:(key:string,params:Record<string,any>={},fallback=key)=>(catalog[key]||fallback).replace(/\{(\w+)\}/g,(_:string,k:string)=>String(params[k]??''))}),[catalog])
  const candidates=devices.filter(device=>device.recordingExport.supported||['verified','protocol_hint'].includes(device.capabilities?.eventRecordings?.status))
  const selected=candidates.find(device=>device.serial===input.serial)
  const changed=Boolean(intent&&fingerprint(intent.input)!==fingerprint(input))
  const rangeMatches=Boolean(selected&&range?.request===fingerprint(input))
  const eventRequest=eventFingerprint(input.serial,input)
  const legacyMatches=Boolean(authenticated&&selected&&legacy?.query&&eventFingerprint(legacy.query.serial,legacy.query.window.input)===eventRequest)
  const eventConfirmed=legacyMatches&&confirmedEvent===eventRequest
  const legacyExpected:ExpectedQuery|undefined=legacy?.query?{serial:legacy.query.serial,...legacy.query.window.input}:undefined
  const legacyStatusVisible=Boolean(legacy&&(!legacy.query||(legacyMatches&&(legacy.busy||eventConfirmed||legacy.messageI18n?.key!=='service.recordings.found'))))

  const showError=(error:any) => {
    if(!error)return ''
    if(error.code==='INTENT_CHANGED')return c.changed
    if(error.code==='STORAGE_REQUIRED')return c.storage
    if(error.code==='RESPONSE_LOST')return c.lost
    if(error.code==='INVALID_WINDOW'&&input.end<=input.start)return c.crossMidnight
    if(typeof error.code==='string'&&catalog['ui.error.'+error.code])return catalog['ui.error.'+error.code]
    if(typeof error.code==='string'&&catalog[error.code])return catalog[error.code]
    return error.message||catalog['ui.error.SERVICE_UNAVAILABLE']||'Request failed'
  }
  const update=(field:keyof WindowInput,value:string)=>{setInput(current=>({...current,[field]:value}));setAcknowledged(false);setNotice('')}
  const remember=(next:Intent|undefined,ids:string[])=>{setIntent(next);setJobIds(ids);if(!saveStore(next,ids))setStorageOk(false)}
  const fetchDevices=async()=>{setDevices([]);setDeviceLoaded(false);setRange(undefined);setRangeError(undefined)
    if(!authenticated){setDiscovery(undefined);setDeviceError(undefined);return}setDeviceLoading(true);setDeviceError(undefined)
    try{const value=await api.devices();setDevices(value.devices);setDiscovery(value.discovery);setDeviceLoaded(true)}catch(error){setDeviceError(fault(error));setDiscovery((error as any)?.body?.discovery)}finally{setDeviceLoading(false)}}
  const receiveLegacy=(value:LegacyRecordings)=>{setLegacy(value)
    if(acceptEventResults.current&&!value.busy&&value.messageI18n?.key==='service.recordings.found'&&value.query)setConfirmedEvent(eventFingerprint(value.query.serial,value.query.window.input))}
  const fetchLegacy=async()=>{try{const value=await api.recordings();receiveLegacy(value);setLegacyError(undefined);if(!intent&&input.timezone==='America/Toronto'&&value.timezone!==input.timezone)setInput(current=>({...current,timezone:value.timezone}))}catch(error){setLegacyError(fault(error))}}
  const fetchJob=(id:string)=>{if(jobRequests.current[id])return jobRequests.current[id]
    const request=api.job(id).then(({job})=>{setJobs(current=>({...current,[id]:job}));setJobErrors(current=>{if(!current[id])return current;const next={...current};delete next[id];return next});return true},error=>{setJobErrors(current=>({...current,[id]:fault(error)}));return false}).finally(()=>{delete jobRequests.current[id]})
    return jobRequests.current[id]=request}
  const fetchJobs=(ids=jobIds)=>Promise.all(ids.map(fetchJob))
  const acceptJob=(job:Job,baseIntent:Intent,baseIds=jobIds)=>{const ids=[...new Set([...baseIds,job.jobId])],next={...baseIntent,submitted:false,jobId:job.jobId};setJobs(current=>({...current,[job.jobId]:job}));remember(next,ids)}
  const sendIntent=async(next:Intent,baseIds=jobIds)=>{setSubmitting(true);setExportError(undefined)
    try{const value=await api.export(next.requestId,next.input);acceptJob(value.job,next,baseIds);setNotice(value.reused?c.existing:'')}
    catch(error){const definite=(error as any)?.body!==undefined;if(definite)remember({...next,submitted:false},baseIds);setExportError(definite?fault(error):{code:'RESPONSE_LOST'})}finally{setSubmitting(false)}}

  useEffect(()=>{fetchDevices()},[authenticated,inventoryKey])
  useEffect(()=>{fetchLegacy();fetchJobs();const timer=setInterval(()=>{fetchLegacy();fetchJobs()},1200);return()=>clearInterval(timer)},[jobIds.join('|')])
  useEffect(()=>{if(candidates.length===1&&!input.serial&&!intent)setInput(current=>({...current,serial:candidates[0].serial}))},[candidates.length])
  useEffect(()=>{if(!recoveryStarted.current&&initial.intent?.submitted&&!initial.intent.jobId){recoveryStarted.current=true;sendIntent(initial.intent,initial.jobIds)}},[])

  const waitForLegacy=async()=>{for(let count=0;count<100;count++){const value=await api.recordings();receiveLegacy(value);if(!value.busy)return value;await new Promise(resolve=>setTimeout(resolve,100))}}
  const findEvents=async()=>{setEventSearching(true);acceptEventResults.current=false;setConfirmedEvent('');setLegacyError(undefined)
    try{await api.eventQuery(input);acceptEventResults.current=true;setConfirmedEvent('');await waitForLegacy()}catch(error){setLegacyError(fault(error))}finally{setEventSearching(false)}}
  const downloadEvent=async(id:string,expectedQuery:ExpectedQuery)=>{setLegacyError(undefined);try{await api.eventDownload(id,expectedQuery);await waitForLegacy()}catch(error){setLegacyError(fault(error))}}
  const findRanges=async()=>{setRangeLoading(true);setRange(undefined);setRangeError(undefined);try{const value=await api.ranges(input);setRange({...value,request:fingerprint(input)})}catch(error){setRangeError(fault(error))}finally{setRangeLoading(false)}}
  const submitExport=async()=>{
    setNotice('')
    if(!storageOk)return setExportError({code:'STORAGE_REQUIRED'})
    if(changed&&!acknowledged)return setExportError({code:'INTENT_CHANGED'})
    if(intent&&!changed&&intent.jobId){const [refreshed]=await fetchJobs([intent.jobId]);if(refreshed){setExportError(undefined);setNotice(c.existing)}return}
    const next=!intent||changed?{requestId:`recording-${crypto.randomUUID()}`,input:{...input},submitted:true as const}:{...intent,submitted:true as const}
    if(!saveStore(next,jobIds)){setStorageOk(false);return setExportError({code:'STORAGE_REQUIRED'})}
    setIntent(next);setAcknowledged(false);await sendIntent(next)
  }
  const discoveryText=deviceError||discovery?.status==='failed'||discovery?.completeness==='incomplete'?c.discoveryFailed:discovery?.completeness==='unknown'?c.discoveryUnknown:''
  const selectionText=!authenticated||deviceLoading||!deviceLoaded?'':input.serial&&!selected?c.missing:!candidates.length?c.noDevices:!input.serial&&candidates.length>1?c.ambiguous:''

  return <section className="workbench" aria-labelledby="recording-workbench-title">
    <h2 id="recording-workbench-title">{c.title}</h2><p>{c.intro}</p>
    {!authenticated&&<div className="notice">{c.signedOut}</div>}
    <div className="card">
      <label>{c.exact}<select value={input.serial} onChange={event=>update('serial',event.target.value)} disabled={!authenticated||deviceLoading}>
        <option value="">{c.choose}</option>{candidates.map(device=><option key={device.serial} value={device.serial}>{device.name} · {device.model||'?'} · {device.serial}</option>)}</select></label>
      <small>{c.identity}</small>{deviceLoading&&<p>{c.loading}</p>}{selectionText&&<p className="state-warning">{selectionText}</p>}
      {discoveryText&&<div className="state-warning"><p>{discoveryText}</p><button type="button" onClick={fetchDevices}>{c.retry}</button></div>}
      {deviceError&&<p role="status" className="error">{showError(deviceError)}</p>}
      <div className="form-grid">
        <label>{c.date}<input type="date" value={input.day} onChange={event=>update('day',event.target.value)} required/></label>
        <label>{c.start}<input type="time" value={input.start} onChange={event=>update('start',event.target.value)} required/></label>
        <label>{c.end}<input type="time" value={input.end} onChange={event=>update('end',event.target.value)} required/></label>
        <label>{c.timezone}<input value={input.timezone} readOnly/></label>
      </div>
      {selected&&<><p className="identity">{selected.name} · {selected.serial} · HomeBase {selected.homeBaseId||'?'} · channel {selected.channel??'?'}</p><DeviceCard device={selected} i18n={i18n}/></>}
    </div>
    <div className="workbench-columns">
      <section className="card result-section" role="region" aria-label={c.events}><h3>{c.events}</h3><p>{c.eventsSeparate}</p>
        <button type="button" disabled={!authenticated||!selected||eventSearching||legacy?.busy} onClick={findEvents}>{eventSearching?c.working:c.findEvents}</button>
        {legacyError&&<p role="status" className="error">{showError(legacyError)}</p>}
        {legacyStatusVisible&&<p role="status">{legacy!.messageI18n?i18n.t(legacy!.messageI18n.key,legacy!.messageI18n.params,legacy!.message):legacy!.message}</p>}
        {legacy?.query&&!legacyMatches&&<p className="state-warning">{c.requeryEvents}</p>}
        {legacy?.query&&legacyMatches&&<p className="normalized">{catalog['ui.normalizedWindow']?.replace('{start}',legacy.query.window.normalized.start).replace('{end}',legacy.query.window.normalized.end).replace('{timezone}',legacy.query.window.normalized.timezone)}</p>}
        {eventConfirmed&&!eventSearching&&!legacy?.busy&&(legacy!.records.length?<><p>{c.eventCount(legacy!.records.length)}</p><ol>{legacy!.records.map(record=><li key={record.id}>{record.start} — {record.end} <button type="button" onClick={()=>downloadEvent(record.id,legacyExpected!)}>{c.exportEvent}</button></li>)}</ol></>:<p>{c.noEvents}</p>)}
      </section>
      <section className="card result-section" role="region" aria-label={c.continuous}><h3>{c.continuous}</h3>
        <button type="button" disabled={!authenticated||!selected||rangeLoading} onClick={findRanges}>{rangeLoading?c.working:c.check}</button>
        {rangeError&&<div role="status" className="error">{showError(rangeError)} <button type="button" onClick={findRanges}>{c.retry}</button></div>}
        {rangeMatches&&<><Timeline value={range} i18n={i18n} label={selected?.name||input.serial}/><p>{range.ranges.length?c.available:c.noContinuous}</p>
          <button type="button" disabled={submitting||!range.ranges.length} onClick={submitExport}>{c.exportContinuous}</button></>}
        {changed&&rangeMatches&&<label className="acknowledge"><input type="checkbox" checked={acknowledged} onChange={event=>setAcknowledged(event.target.checked)}/>{c.acknowledge}</label>}
        {intent&&<p><strong>{c.intent}:</strong> <code>{intent.requestId}</code></p>}{exportError&&<p role="status" className="error">{showError(exportError)}</p>}{notice&&<p role="status">{notice}</p>}
      </section>
    </div>
    <section className="result-section" aria-label={c.jobs}><h3>{c.jobs}</h3>{jobIds.map(id=><React.Fragment key={id}>{jobErrors[id]&&<p role="status" className="error">{showError(jobErrors[id])}</p>}{jobs[id]&&<JobResultCard job={jobs[id]} i18n={i18n}/>}</React.Fragment>)}</section>
    <section className="result-section" aria-label={c.saved}><h3>{c.saved}</h3><p>{c.savedHint}</p>{legacy?.saved?.length?<SavedPlayers clips={legacy.saved} i18n={i18n} download={c.savedDownload}/>:null}</section>
  </section>
}
