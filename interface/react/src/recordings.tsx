import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api, type Device, type Discovery, type ExpectedQuery, type Job, type LegacyRecordings, type Playback, type WindowInput } from './client'
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
    preview:'Direct historical preview', previewHint:'Video-only H.264/HEVC preview, up to 5 fps and 960 px. Choose a 1–60 second window fully inside one listed recording.',
    play:'Play selected timestamp', pause:'Pause preview', resume:'Resume preview', seek:'Seek to selected timestamp', close:'Close preview',
    sourcePosition:'Source received position', sourceCaution:'Preview decoding is delayed; this is a source-receive observation, not a JPEG PTS or frame-accurate position.',
    firstFrame:'Measured browser first-frame latency', frameSequence:'Displayed frame', waitingFrame:'Waiting for a decodable keyframe…',
    resumeWaiting:'Resuming with a fresh decoder…', recovered:'A saved playback request was recovered. Open it explicitly to display media.', openRecovered:'Open recovered preview',
    playbackRange:'Direct preview requires a 1–60 second same-recording window.', playbackGap:'The selected target is not fully contained in one available recording. Older footage will not be substituted.',
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
    preview:'直接历史预览', previewHint:'仅视频 H.264/HEVC 预览，最高 5 fps、960 px。请选择完整落在同一条录像内的 1–60 秒窗口。',
    play:'播放所选时间', pause:'暂停预览', resume:'继续预览', seek:'跳转到所选时间', close:'关闭预览',
    sourcePosition:'源接收位置', sourceCaution:'预览存在解码延迟；该时间是源接收观测值，不是 JPEG 精确 PTS，也不代表逐帧定位。',
    firstFrame:'浏览器实测首帧延迟', frameSequence:'已显示帧', waitingFrame:'正在等待可解码关键帧…',
    resumeWaiting:'正在用新解码器继续…', recovered:'已恢复保存的播放请求。请明确打开后再显示媒体。', openRecovered:'打开已恢复的预览',
    playbackRange:'直接预览要求 1–60 秒且完整位于同一条录像内。', playbackGap:'所选目标未完整落在一条可用录像内，不会用更早录像替代。',
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
  if(typeof error?.code==='string')return {code:error.code,message:error.message||error.code}
  if(typeof error?.message==='string'&&/^[A-Z][A-Z0-9_]+$/.test(error.message))return {code:error.message,message:error.message}
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

type MediaPart={sessionId:string;requestId:string;mediaEpoch:number;frameSequence:number;sourceReceivedPositionMs:number;jpeg:Uint8Array}
const playbackStorageKey='eufy-agent-hub.playback-intent'
const decoder=new TextDecoder('ascii',{fatal:true})
const findHeaderEnd=(bytes:Uint8Array)=>{for(let i=0;i+3<bytes.length;i++)if(bytes[i]===13&&bytes[i+1]===10&&bytes[i+2]===13&&bytes[i+3]===10)return i;return -1}
const appendBytes=(left:Uint8Array,right:Uint8Array)=>{const value=new Uint8Array(left.length+right.length);value.set(left);value.set(right,left.length);return value}
export async function readPlaybackParts(response:Response,onPart:(part:MediaPart)=>void){
  if(!response.ok||response.headers.get('content-type')!=='multipart/x-mixed-replace; boundary=frame')throw new Error('PLAYBACK_MEDIA_UNAVAILABLE')
  const reader=response.body!.getReader();let buffer=new Uint8Array(),length:number|undefined,headers:Record<string,string>|undefined
  for(;;){const value=await reader.read();if(value.done)return;buffer=appendBytes(buffer,value.value)
    if(buffer.length>1024*1024+4098)throw new Error('PLAYBACK_MEDIA_UNAVAILABLE')
    for(;;){if(length===undefined){const end=findHeaderEnd(buffer);if(end<0){if(buffer.length>4096)throw new Error('PLAYBACK_MEDIA_UNAVAILABLE');break}
        const lines=decoder.decode(buffer.slice(0,end)).split('\r\n');if(lines.shift()!=='--frame')throw new Error('PLAYBACK_MEDIA_UNAVAILABLE');headers={}
        for(const line of lines){const split=line.indexOf(':');if(split<1)throw new Error('PLAYBACK_MEDIA_UNAVAILABLE');const name=line.slice(0,split).toLowerCase(),value=line.slice(split+1).trim();if(name.length>80||value.length>256||Object.hasOwn(headers,name))throw new Error('PLAYBACK_MEDIA_UNAVAILABLE');headers[name]=value}
        if(headers['content-type']!=='image/jpeg'||!/^[1-9]\d{0,6}$/.test(headers['content-length']||''))throw new Error('PLAYBACK_MEDIA_UNAVAILABLE')
        length=Number(headers['content-length']);if(length>1024*1024)throw new Error('PLAYBACK_MEDIA_UNAVAILABLE');buffer=buffer.slice(end+4)}
      if(buffer.length<length+2)break;if(buffer[length]!==13||buffer[length+1]!==10)throw new Error('PLAYBACK_MEDIA_UNAVAILABLE')
      const integer=(name:string)=>{const value=headers![name];if(!/^\d+$/.test(value||''))throw new Error('PLAYBACK_MEDIA_UNAVAILABLE');const number=Number(value);if(!Number.isSafeInteger(number))throw new Error('PLAYBACK_MEDIA_UNAVAILABLE');return number}
      onPart({sessionId:headers!['x-playback-session-id'],requestId:headers!['x-playback-request-id'],mediaEpoch:integer('x-playback-media-epoch'),frameSequence:integer('x-playback-frame-sequence'),sourceReceivedPositionMs:integer('x-playback-source-received-ms'),jpeg:buffer.slice(0,length)})
      buffer=buffer.slice(length+2);length=undefined;headers=undefined
    }
  }
}

function HistoricalPlayer({input,range,rangeMatches,authenticated,c,showError,onSerialLock,onRecoverSerial}:{input:WindowInput;range:any;rangeMatches:boolean;authenticated:boolean;c:any;showError:(error:any)=>string;onSerialLock:(serial?:string)=>void;onRecoverSerial:(serial:string)=>void}){
  const canvas=useRef<HTMLCanvasElement>(null),generation=useRef(0),streamGeneration=useRef(0),identityGeneration=useRef(0),current=useRef<Playback>(),ownerSerial=useRef<string>(),visibleSerial=useRef(input.serial),terminal=useRef(false),paused=useRef(false),resumeAcknowledged=useRef(true),stream=useRef<AbortController>(),decoding=useRef(false),pending=useRef<(MediaPart&{generation:number})>(),minimumEpoch=useRef(0),seekRunning=useRef(false),queuedSeek=useRef<WindowInput>();visibleSerial.current=input.serial
  const [playback,setPlayback]=useState<Playback>(),[state,setState]=useState('idle'),[error,setError]=useState<any>(),[display,setDisplay]=useState<{source:number;sequence:number;epoch:number;latency:number}>(),[recovered,setRecovered]=useState(false)
  const duration=rangeMatches?Date.parse(range.window.normalized.end)-Date.parse(range.window.normalized.start):0
  const [startHour,startMinute]=input.start.split(':').map(Number),[endHour,endMinute]=input.end.split(':').map(Number),seekDuration=((endHour*60+endMinute)-(startHour*60+startMinute))*60000
  const contained=Boolean(rangeMatches&&range.ranges?.some((item:any)=>Date.parse(item.start)<=Date.parse(range.window.normalized.start)&&Date.parse(item.end)>=Date.parse(range.window.normalized.end)))
  const eligible=authenticated&&contained&&duration>=1000&&duration<=60000
  const remember=(value:any)=>{try{localStorage.setItem(playbackStorageKey,JSON.stringify(value));return true}catch{return false}}
  const clearRemembered=()=>{try{localStorage.removeItem(playbackStorageKey)}catch{}}
  const clearSurface=()=>{generation.current++;pending.current=undefined;paused.current=true;setDisplay(undefined);const surface=canvas.current;if(!surface)return;surface.getContext('2d')?.clearRect(0,0,surface.width,surface.height);for(const key of Object.keys(surface.dataset))delete surface.dataset[key]}
  const isTerminal=(value:Playback)=>value.state==='closed'||value.cleanupComplete
  const scopeMatches=(value:Playback,serial=ownerSerial.current)=>Boolean(serial&&value.verificationScope?.serial===serial)
  const visibleMatches=(value:Playback)=>scopeMatches(value)&&visibleSerial.current===ownerSerial.current
  const rejectIdentity=(value:Playback)=>{current.current=value;setPlayback(value);setRecovered(false);clearSurface();setError({code:'CONTROL_SCOPE_CHANGED',message:'CONTROL_SCOPE_CHANGED'});setState('error')}
  const retainOwner=(value:Playback,failure=value.error)=>{current.current=value;terminal.current=false;setPlayback(value);setRecovered(true);setError(failure||undefined);setState(failure?'error':value.state)}
  const finishTerminal=(value:Playback)=>{terminal.current=true;identityGeneration.current++;streamGeneration.current++;stream.current?.abort();stream.current=undefined;current.current=value;setPlayback(value);setRecovered(false);setError(value.error||undefined);clearSurface();clearRemembered();ownerSerial.current=undefined;onSerialLock(undefined);setState(value.error||value.state==='failed'?'error':'closed')}
  const releaseDeadIntent=(failure:any)=>{terminal.current=true;identityGeneration.current++;streamGeneration.current++;stream.current?.abort();stream.current=undefined;current.current=undefined;setPlayback(undefined);setRecovered(false);clearSurface();clearRemembered();ownerSerial.current=undefined;onSerialLock(undefined);setError(failure);setState('error')}
  const draw=async(part:MediaPart&{generation:number})=>{decoding.current=true;let bitmap:ImageBitmap|undefined
    try{bitmap=await createImageBitmap(new Blob([part.jpeg as BlobPart],{type:'image/jpeg'}));if(part.generation!==generation.current||paused.current||current.current?.sessionId!==part.sessionId||!visibleMatches(current.current)||part.mediaEpoch<minimumEpoch.current)return
      const context=canvas.current?.getContext('2d');if(!context)return;context.drawImage(bitmap,0,0,canvas.current!.width,canvas.current!.height)
      const firstLatency=Number(canvas.current!.dataset.firstFrameLatencyMs||performance.now()-Number(canvas.current!.dataset.startedAt||performance.now()));canvas.current!.dataset.firstFrameLatencyMs=String(firstLatency)
      canvas.current!.dataset.sessionId=part.sessionId;canvas.current!.dataset.requestId=part.requestId;canvas.current!.dataset.sourceReceivedPositionMs=String(part.sourceReceivedPositionMs);canvas.current!.dataset.frameSequence=String(part.frameSequence);canvas.current!.dataset.mediaEpoch=String(part.mediaEpoch)
      setDisplay(previous=>({source:part.sourceReceivedPositionMs,sequence:part.frameSequence,epoch:part.mediaEpoch,latency:previous?.latency??firstLatency}));if(resumeAcknowledged.current)setState('playing')
    }finally{bitmap?.close();decoding.current=false;const latest=pending.current;pending.current=undefined;if(latest)void draw(latest)}}
  const receive=(part:MediaPart)=>{if(paused.current||part.sessionId!==current.current?.sessionId||!current.current||!visibleMatches(current.current)||part.requestId!==current.current?.requestId||part.mediaEpoch<minimumEpoch.current)return
    const value={...part,generation:generation.current};if(decoding.current)pending.current=value;else void draw(value)}
  const reconcileEnd=async(localStreamGeneration:number,sessionId:string,requestId:string|undefined,controller:AbortController)=>{try{let value:Playback|undefined,surfaceCleared=false
      for(let count=0;count<40;count++){value=(await api.playback(sessionId)).playback;if(value.state==='failed'&&!surfaceCleared){surfaceCleared=true;clearSurface()}if(value.state==='closed'||value.cleanupComplete)break;await new Promise(resolve=>setTimeout(resolve,250))}
      if(controller.signal.aborted||stream.current!==controller||streamGeneration.current!==localStreamGeneration||current.current?.sessionId!==sessionId||current.current?.requestId!==requestId||!value)return
      if(!scopeMatches(value))rejectIdentity(value);else if(isTerminal(value))finishTerminal(value);else if(value.state==='failed'){clearSurface();retainOwner(value)}else{current.current=value;setPlayback(value);setError(value.error||undefined);setState(value.state)}
    }catch(reason){if(!controller.signal.aborted&&stream.current===controller&&streamGeneration.current===localStreamGeneration&&current.current?.sessionId===sessionId){setError(fault(reason));setState('error')}}}
  const attach=async(value:Playback,startedAt=performance.now(),serial=ownerSerial.current)=>{if(ownerSerial.current!==serial)return;if(!visibleMatches(value))return rejectIdentity(value);if(isTerminal(value))return finishTerminal(value);if(value.state==='failed'||!value.media)return retainOwner(value);stream.current?.abort();const controller=new AbortController(),localStreamGeneration=++streamGeneration.current;stream.current=controller;terminal.current=false;current.current=value;paused.current=false;resumeAcknowledged.current=true;setPlayback(value);setRecovered(false);setState('loading');setError(undefined);minimumEpoch.current=value.media?.mediaEpoch||0;if(canvas.current)canvas.current.dataset.startedAt=String(startedAt)
    try{const response=await fetch(value.media!.url,{signal:controller.signal});void readPlaybackParts(response,receive).then(()=>{if(!controller.signal.aborted)void reconcileEnd(localStreamGeneration,value.sessionId,value.requestId,controller)},()=>{if(!controller.signal.aborted)void reconcileEnd(localStreamGeneration,value.sessionId,value.requestId,controller)})}catch(reason){if(!controller.signal.aborted&&stream.current===controller&&streamGeneration.current===localStreamGeneration){setError(fault(reason));setState('error')}}}
  const recover=async(intent:any,reload=false)=>{for(let count=0;count<120;count++){const request=(await api.playbackRequest(intent.requestId,intent.residentEpoch)).request
      if((request.state==='succeeded'||request.state==='failed')&&request.sessionId){let value:Playback;try{value=(await api.playback(request.sessionId)).playback}catch(reason){throw Object.assign(reason as object,{playbackSessionId:request.sessionId})}
        if(reload&&intent.sessionId&&(value.media?.connected||value.state==='closing')&&!isTerminal(value))for(let wait=0;wait<60&&!isTerminal(value);wait++){await new Promise(resolve=>setTimeout(resolve,250));value=(await api.playback(request.sessionId!)).playback}
        return value}
      if(request.state==='failed')throw Object.assign(new Error(request.error?.message),{body:{error:request.error}});await new Promise(resolve=>setTimeout(resolve,250))}throw new Error('PLAYBACK_MEDIA_TIMEOUT')}
  const recoveryFailure=async(reason:any,intent:any,token:number)=>{const failure=fault(reason);if(token!==identityGeneration.current)return
    if(failure.code==='PLAYBACK_REQUEST_EXPIRED')return releaseDeadIntent(failure)
    const definitive=['PLAYBACK_REQUEST_NOT_FOUND','PLAYBACK_SESSION_NOT_FOUND'].includes(failure.code)
    const missing=reason?.playbackSessionId,candidates=[...new Set([current.current?.sessionId,intent.sessionId,intent.operation==='seek'?intent.fromSessionId:undefined]
      .filter((id):id is string=>typeof id==='string'&&Boolean(id)&&id!==missing))]
    for(const id of candidates){let value:Playback;try{value=(await api.playback(id)).playback}catch(check){if(token!==identityGeneration.current)return;if(fault(check).code==='PLAYBACK_SESSION_NOT_FOUND')continue;setError(failure);setState('error');return}
      if(token!==identityGeneration.current)return;if(!scopeMatches(value,intent.input.serial))return rejectIdentity(value)
      if(!isTerminal(value)){retainOwner(value,failure);return}}
    if(token!==identityGeneration.current)return;if(definitive)releaseDeadIntent(failure);else{setError(failure);setState('error')}}
  useEffect(()=>{let active=true;try{const intent=JSON.parse(localStorage.getItem(playbackStorageKey)||'null');if(intent?.requestId&&intent?.residentEpoch&&intent?.input?.serial){ownerSerial.current=intent.input.serial;onRecoverSerial(intent.input.serial);const token=++identityGeneration.current;recover(intent,true).then(value=>{if(!active||token!==identityGeneration.current||ownerSerial.current!==intent.input.serial)return;if(!scopeMatches(value,intent.input.serial))rejectIdentity(value);else if(isTerminal(value))finishTerminal(value);else retainOwner(value)}).catch(reason=>{if(active&&token===identityGeneration.current)void recoveryFailure(reason,intent,token)})}}catch{}return()=>{active=false;stream.current?.abort();generation.current++;streamGeneration.current++;identityGeneration.current++}},[])
  const start=async()=>{if(!eligible)return;const serial=input.serial,token=++identityGeneration.current;ownerSerial.current=serial;onSerialLock(serial);terminal.current=false;streamGeneration.current++;clearSurface();setError(undefined);const startedAt=performance.now();let intent:any,submitted=false
    try{const residentEpoch=(await api.session()).residentEpoch,requestId=`playback-${crypto.randomUUID()}`;intent={requestId,residentEpoch,operation:'create',input:{...input}};if(!remember(intent))throw {code:'STORAGE_REQUIRED'};submitted=true
      const value=(await api.startPlayback(requestId,residentEpoch,input)).playback;if(token!==identityGeneration.current||ownerSerial.current!==serial)return;if(!scopeMatches(value,serial))return rejectIdentity(value);if(isTerminal(value))return finishTerminal(value);remember({...intent,sessionId:value.sessionId});if(value.state==='failed')return retainOwner(value);await attach(value,startedAt,serial)
    }catch(reason){if(submitted){try{const value=await recover(intent);if(token!==identityGeneration.current||ownerSerial.current!==serial)return;if(!scopeMatches(value,serial))return rejectIdentity(value);if(isTerminal(value))return finishTerminal(value);remember({...intent,sessionId:value.sessionId});if(value.state==='failed')return retainOwner(value);await attach(value,startedAt,serial);return}catch(recoveryReason){return await recoveryFailure(recoveryReason,intent,token)}}if(token!==identityGeneration.current)return;setError(fault(reason));setState('error');ownerSerial.current=undefined;onSerialLock(undefined)}}
  const pausePlayback=async()=>{const value=current.current;if(!value)return;const token=identityGeneration.current,localStreamGeneration=streamGeneration.current,sessionId=value.sessionId;generation.current++;pending.current=undefined;paused.current=true;resumeAcknowledged.current=true;setState('pausing');setError(undefined);try{const next=(await api.pausePlayback(sessionId)).playback;if(token!==identityGeneration.current||localStreamGeneration!==streamGeneration.current||terminal.current||current.current?.sessionId!==sessionId)return;if(!scopeMatches(next))return rejectIdentity(next);if(isTerminal(next))return finishTerminal(next);current.current=next;setPlayback(next);setState('paused')}catch(reason){if(token===identityGeneration.current&&localStreamGeneration===streamGeneration.current&&!terminal.current){setError(fault(reason));setState('error')}}}
  const resumePlayback=async()=>{const value=current.current;if(!value)return;const token=identityGeneration.current,localStreamGeneration=streamGeneration.current,sessionId=value.sessionId;generation.current++;pending.current=undefined;paused.current=false;resumeAcknowledged.current=false;minimumEpoch.current=(display?.epoch||value.media?.mediaEpoch||0)+1;setState('resuming');setError(undefined);try{const next=(await api.resumePlayback(sessionId)).playback;if(token!==identityGeneration.current||localStreamGeneration!==streamGeneration.current||terminal.current||current.current?.sessionId!==sessionId)return;if(!scopeMatches(next))return rejectIdentity(next);if(isTerminal(next))return finishTerminal(next);current.current=next;setPlayback(next);resumeAcknowledged.current=true;if(Number(canvas.current?.dataset.mediaEpoch)>=minimumEpoch.current)setState('playing')}catch(reason){if(token===identityGeneration.current&&localStreamGeneration===streamGeneration.current&&!terminal.current){resumeAcknowledged.current=true;setError(fault(reason));setState('error')}}}
  const processSeek=async(first:WindowInput)=>{if(!playback)return;seekRunning.current=true;let target:WindowInput|undefined=first
    try{while(target&&ownerSerial.current===target.serial){queuedSeek.current=undefined;streamGeneration.current++;clearSurface();setState('seeking');setError(undefined);const from=current.current!,serial=ownerSerial.current,token=++identityGeneration.current,residentEpoch=from.residentEpoch!,requestId=`playback-seek-${crypto.randomUUID()}`,intent={requestId,residentEpoch,operation:'seek',fromSessionId:from.sessionId,input:{...target}};remember(intent)
        try{const value=(await api.seekPlayback(from.sessionId,requestId,residentEpoch,target)).playback;if(token!==identityGeneration.current||ownerSerial.current!==serial)return;if(!scopeMatches(value,serial))return rejectIdentity(value);if(isTerminal(value))return finishTerminal(value);remember({...intent,sessionId:value.sessionId});if(value.state==='failed')return retainOwner(value);await attach(value,performance.now(),serial)}catch{try{const value=await recover(intent);if(token!==identityGeneration.current||ownerSerial.current!==serial)return;if(!scopeMatches(value,serial))return rejectIdentity(value);if(isTerminal(value))return finishTerminal(value);remember({...intent,sessionId:value.sessionId});if(value.state==='failed')return retainOwner(value);await attach(value,performance.now(),serial)}catch(recoveryReason){await recoveryFailure(recoveryReason,intent,token)}}target=queuedSeek.current}}
    finally{seekRunning.current=false}}
  const seek=()=>{if(ownerSerial.current!==input.serial)return;const target={...input};if(seekRunning.current)queuedSeek.current=target;else void processSeek(target)}
  const close=async()=>{const value=current.current;if(!value)return;const token=++identityGeneration.current;streamGeneration.current++;clearSurface();setState('closing');setError(undefined);try{const next=(await api.closePlayback(value.sessionId)).playback;if(token!==identityGeneration.current)return;finishTerminal(next)}catch(reason){if(token===identityGeneration.current){setError(fault(reason));setState('error')}}}
  return <section className="historical-player" aria-labelledby="historical-player-title"><h4 id="historical-player-title">{c.preview}</h4><p>{c.previewHint}</p>
    <canvas ref={canvas} width="960" height="540" tabIndex={0} aria-label={c.preview}/>
    <div className="playback-controls">
      {!playback||isTerminal(playback)?<button type="button" disabled={!eligible} onClick={start}>{c.play}</button>:<>
        {state==='paused'?<button type="button" onClick={resumePlayback}>{c.resume}</button>:<button type="button" disabled={!['playing','loading'].includes(state)} onClick={pausePlayback}>{c.pause}</button>}
        <button type="button" disabled={!authenticated||ownerSerial.current!==input.serial||seekDuration<1000||seekDuration>60000||!['playing','paused'].includes(state)} onClick={seek}>{c.seek}</button><button type="button" onClick={close}>{c.close}</button></>}
      {recovered&&playback?.media&&playback.state!=='failed'&&!isTerminal(playback)&&input.serial===ownerSerial.current&&scopeMatches(playback)&&<button type="button" onClick={()=>attach(playback,performance.now(),ownerSerial.current)}>{c.openRecovered}</button>}
    </div>
    {!rangeMatches||duration<1000||duration>60000?<p role="status" className="state-warning">{c.playbackRange}</p>:!contained?<p role="status" className="state-warning">{c.playbackGap}</p>:null}
    {recovered&&<p role="status">{c.recovered}</p>}{['loading','seeking'].includes(state)&&<p role="status">{c.waitingFrame}</p>}{state==='resuming'&&<p role="status">{c.resumeWaiting}</p>}
    {display&&<p className="playback-observation"><strong>{c.sourcePosition}:</strong> {new Date(display.source).toISOString()} · {c.frameSequence} {display.sequence} · {c.firstFrame}: {Math.round(display.latency)} ms</p>}
    <p className="normalized">{c.sourceCaution}</p>{error&&<p role="status" className="error">{showError(error)}</p>}
  </section>
}

export function RecordingWorkbench({authenticated,language,catalog,inventoryRevision}:{authenticated:boolean;language:Language;catalog:Record<string,string>;inventoryRevision:number}) {
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
  const [playbackSerial,setPlaybackSerial]=useState<string>()
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
  const recoverPlaybackSerial=(serial:string)=>{setInput(current=>current.serial===serial?current:{...current,serial});setPlaybackSerial(serial)}
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

  useEffect(()=>{fetchDevices()},[authenticated,inventoryRevision])
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
      <label>{c.exact}<select value={input.serial} onChange={event=>update('serial',event.target.value)} disabled={!authenticated||deviceLoading||Boolean(playbackSerial)}>
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
        <HistoricalPlayer input={input} range={range} rangeMatches={rangeMatches} authenticated={authenticated} c={c} showError={showError} onSerialLock={setPlaybackSerial} onRecoverSerial={recoverPlaybackSerial}/>
        {changed&&rangeMatches&&<label className="acknowledge"><input type="checkbox" checked={acknowledged} onChange={event=>setAcknowledged(event.target.checked)}/>{c.acknowledge}</label>}
        {intent&&<p><strong>{c.intent}:</strong> <code>{intent.requestId}</code></p>}{exportError&&<p role="status" className="error">{showError(exportError)}</p>}{notice&&<p role="status">{notice}</p>}
      </section>
    </div>
    <section className="result-section" aria-label={c.jobs}><h3>{c.jobs}</h3>{jobIds.map(id=><React.Fragment key={id}>{jobErrors[id]&&<p role="status" className="error">{showError(jobErrors[id])}</p>}{jobs[id]&&<JobResultCard job={jobs[id]} i18n={i18n}/>}</React.Fragment>)}</section>
    <section className="result-section" aria-label={c.saved}><h3>{c.saved}</h3><p>{c.savedHint}</p>{legacy?.saved?.length?<SavedPlayers clips={legacy.saved} i18n={i18n} download={c.savedDownload}/>:null}</section>
  </section>
}
