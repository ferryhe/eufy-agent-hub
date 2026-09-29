import React, { useEffect, useRef, useState } from 'react'
import { api, type Device, type LiveSession } from './client'

type Language = 'en'|'zh-CN'
const words = {
  en: {
    title:'Live preview',intro:'Start a video-only preview on demand. The resident allows one media consumer across all cameras and HomeBases.',
    camera:'Camera',choose:'Choose a camera',attemptable:'Can attempt preview',other:'Other devices (preview unavailable)',duration:'Maximum duration (seconds)',start:'Start live preview',stop:'Stop preview',
    loading:'Loading camera capabilities…',noDevices:'No cameras are available from the resident.',signedOut:'Sign in to load camera capabilities.',
    capability:'Live capability',verified:'Verified for this exact recorded device scope',hint:'Protocol hint: a bounded attempt is allowed; hardware support is not verified.',
    unknown:'Unknown capability: preview launch is disabled.',unsupported:'Unsupported capability or model path: preview launch is disabled.',
    offline:'The resident has an offline or unavailable observation for this camera.',wrongPath:'Live preview requires a T8600 camera, T8030 HomeBase and known channel.',
    starting:'Starting… waiting for the resident to confirm the command and decode video.',streaming:'Streaming',stopping:'Stopping… waiting for resident cleanup confirmation.',
    stopped:'Stopped and cleaned up.',expired:'Session expired; resident cleanup is confirmed.',failed:'Preview failed.',
    firstFrame:'Browser decoded a preview frame.',waitingFrame:'Waiting for the browser to decode a frame…',
    limits:'Video only · maximum 5 fps · width up to 960 px · one to 60 seconds. No audio, talkback or RTSP controls.',
    remaining:'Seconds remaining',durationError:'Choose a whole number from 1 to 60 seconds.',
    stopUnconfirmed:'Cleanup is not confirmed. The resident still owns this session; retry Stop before leaving this page.',
    loadFailed:'Could not load camera capabilities from the resident.',
    capabilityReason:'Capability reason',resources:'Cleanup',confirmed:'confirmed',pending:'pending',
  },
  'zh-CN': {
    title:'实时预览',intro:'按需启动纯视频预览。常驻服务在所有摄像头和 HomeBase 之间只允许一个媒体使用者。',
    camera:'摄像头',choose:'选择摄像头',attemptable:'可尝试预览',other:'其他设备（无法启动预览）',duration:'最长时长（秒）',start:'启动实时预览',stop:'停止预览',
    loading:'正在读取摄像头能力…',noDevices:'常驻服务未返回摄像头。',signedOut:'请先登录，再读取摄像头能力。',
    capability:'实时能力',verified:'该精确设备范围已有验证记录',hint:'协议提示：允许进行有限尝试；硬件支持尚未验证。',
    unknown:'能力未知：已禁用预览启动。',unsupported:'能力或型号路径不支持：已禁用预览启动。',
    offline:'常驻服务记录此摄像头离线或不可用。',wrongPath:'实时预览需要 T8600 摄像头、T8030 HomeBase 和已知通道。',
    starting:'正在启动…等待常驻服务确认命令并解码视频。',streaming:'正在播放',stopping:'正在停止…等待常驻服务确认清理完成。',
    stopped:'已停止并完成清理。',expired:'会话已过期，常驻服务已确认清理完成。',failed:'预览失败。',
    firstFrame:'浏览器已解码预览帧。',waitingFrame:'正在等待浏览器解码画面…',
    limits:'纯视频 · 最高 5 fps · 最大宽度 960 像素 · 1 至 60 秒。没有音频、双向语音或 RTSP 控件。',
    remaining:'剩余秒数',durationError:'时长须为 1 至 60 的整数。',
    stopUnconfirmed:'尚未确认清理完成。常驻服务仍拥有此会话；请重试停止后再离开页面。',
    loadFailed:'无法从常驻服务读取摄像头能力。',
    capabilityReason:'能力原因',resources:'清理状态',confirmed:'已确认',pending:'等待确认',
  },
} as const

function supportedPath(device?:Device){
  const scope=device?.verificationScope
  return scope?.model==='T8600'&&scope.homeBase?.model==='T8030'&&Number.isInteger(scope.channel)&&scope.channel!==null&&scope.channel>=0
}
function problem(error:any){return error?.body?.error||{code:error?.code||error?.message||'SERVICE_UNAVAILABLE',message:error?.message||'Request failed'}}

export function LivePreview({authenticated,language,catalog,inventoryRevision,onRegisterStop}:{authenticated:boolean;language:Language;catalog:Record<string,string>;inventoryRevision:number;onRegisterStop:(stop:(()=>Promise<void>)|undefined)=>void}){
  const c=words[language]
  const [devices,setDevices]=useState<Device[]>([]),[loading,setLoading]=useState(false),[loadError,setLoadError]=useState<any>()
  const [serial,setSerial]=useState(''),[duration,setDuration]=useState(15),[live,setLive]=useState<LiveSession>(),[operation,setOperation]=useState<'idle'|'starting'|'stopping'>('idle')
  const [startError,setStartError]=useState<any>(),[statusError,setStatusError]=useState<any>(),[stopError,setStopError]=useState<any>()
  const [browserDecoded,setBrowserDecoded]=useState(false),[now,setNow]=useState(Date.now())
  const liveRef=useRef<LiveSession>(),requestIdRef=useRef<string>(),startPromiseRef=useRef<Promise<void>>(),stopPromiseRef=useRef<Promise<LiveSession>>(),stopRequestedRef=useRef(false)
  const selected=devices.find(device=>device.serial===serial)
  const capability=selected?.capabilities?.liveVideo
  const canAttempt=(device?:Device)=>Boolean(supportedPath(device)&&device?.availability!=='offline'&&device?.availability!=='unavailable'&&['verified','protocol_hint'].includes(device?.capabilities?.liveVideo?.status||''))
  const attemptableDevices=devices.filter(canAttempt),otherDevices=devices.filter(device=>!canAttempt(device))
  const eligible=authenticated&&canAttempt(selected)

  const setCurrent=(value:LiveSession|undefined)=>{if(value?.cleanupComplete)requestIdRef.current=undefined;liveRef.current=value;setLive(value)}
  const errorMessage=(value:any)=>{const error=problem(value);return catalog[`ui.error.${error.code}`]||error.message||error.code}

  useEffect(()=>{
    let active=true
    if(!authenticated){setDevices([]);setSerial('');setLoadError(undefined);return()=>{active=false}}
    setLoading(true);setLoadError(undefined)
    api.devices().then(value=>{if(!active)return;setDevices(value.devices);setSerial(current=>value.devices.some(device=>device.serial===current)?current:'')})
      .catch(value=>{if(active){setDevices([]);setLoadError(problem(value))}}).finally(()=>{if(active)setLoading(false)})
    return()=>{active=false}
  },[authenticated,inventoryRevision])

  const stopSession=(sessionId:string,keepalive=false):Promise<LiveSession>=>{
    if(stopPromiseRef.current)return stopPromiseRef.current
    setOperation('stopping');setStopError(undefined);stopRequestedRef.current=true
    const task=api.stopLive(sessionId,keepalive).then(({live:next})=>{
      setCurrent(next)
      if(!next.cleanupComplete)throw Object.assign(new Error('LIVE_CLEANUP_PENDING'),{code:'LIVE_CLEANUP_PENDING'})
      return next
    }).catch(value=>{setStopError(problem(value));throw value}).finally(()=>{if(stopPromiseRef.current===task)stopPromiseRef.current=undefined;setOperation('idle')})
    stopPromiseRef.current=task
    return task
  }

  const start=()=>{
    if(startPromiseRef.current||!eligible||!selected||operation!=='idle'||!Number.isInteger(duration)||duration<1||duration>60)return
    const requestId=requestIdRef.current||(requestIdRef.current=`live-${crypto.randomUUID()}`)
    setStartError(undefined);setStatusError(undefined);setStopError(undefined);setBrowserDecoded(false);stopRequestedRef.current=false
    setCurrent(undefined);setOperation('starting')
    const task=(async()=>{try{const value=await api.startLive(requestId,selected.serial,duration*1000);setCurrent(value.live)}
      catch(value){const failure=problem(value),recovery=(value as any)?.body?.live as LiveSession|undefined;setStartError(failure)
        if(recovery&&!recovery.cleanupComplete)setCurrent(recovery)
        else if((value as any)?.status)requestIdRef.current=undefined}
      finally{setOperation('idle')}})()
    startPromiseRef.current=task
    void task.finally(()=>{if(startPromiseRef.current===task)startPromiseRef.current=undefined})
  }

  const routeStopRef=useRef<()=>Promise<void>>(async()=>{})
  routeStopRef.current=async()=>{
    if(startPromiseRef.current)await startPromiseRef.current
    const current=liveRef.current
    if(current&&!current.cleanupComplete)await stopSession(current.sessionId)
  }
  useEffect(()=>{
    const stop=()=>routeStopRef.current()
    onRegisterStop(stop)
    const pagehide=()=>{const current=liveRef.current;if(current&&!current.cleanupComplete)void api.stopLive(current.sessionId,true).catch(()=>{})}
    addEventListener('pagehide',pagehide)
    return()=>{onRegisterStop(undefined);removeEventListener('pagehide',pagehide);pagehide()}
  },[onRegisterStop])

  useEffect(()=>{
    if(!authenticated&&liveRef.current&&!liveRef.current.cleanupComplete)void stopSession(liveRef.current.sessionId,true).catch(()=>{})
  },[authenticated])

  useEffect(()=>{
    const current=live
    if(!current||current.cleanupComplete||!['opening','streaming','stopping','failed'].includes(current.state))return
    let active=true,inFlight=false
    const poll=async()=>{if(inFlight)return;inFlight=true;try{const value=await api.liveStatus(current.sessionId);if(active){setCurrent(value.live);setStatusError(undefined)}}catch(value){if(active)setStatusError(problem(value))}finally{inFlight=false}}
    const timer=setInterval(()=>void poll(),1000)
    return()=>{active=false;clearInterval(timer)}
  },[live?.sessionId,live?.state,live?.cleanupComplete])

  useEffect(()=>{
    if(!live||live.cleanupComplete||live.state!=='streaming')return
    const timer=setInterval(()=>setNow(Date.now()),250)
    return()=>clearInterval(timer)
  },[live?.sessionId,live?.state,live?.cleanupComplete])

  const stateText=(value:LiveSession)=>{
    if(operation==='starting')return c.starting
    if(operation==='stopping')return c.stopping
    if(value.state==='streaming'&&now>=value.expiresAtMs)return c.stopping
    if(value.state==='streaming')return c.streaming
    if(value.state==='stopped')return stopRequestedRef.current?c.stopped:c.expired
    if(value.state==='failed')return c.failed
    return value.state
  }
  const activeOwner=Boolean(live&&!live.cleanupComplete)
  const canStart=eligible&&operation==='idle'&&!activeOwner&&Number.isInteger(duration)&&duration>=1&&duration<=60

  return <section className="live-page" aria-labelledby="live-page-title">
    <h2 id="live-page-title">{c.title}</h2><p>{c.intro}</p>
    {!authenticated&&<p className="notice" role="status">{c.signedOut}</p>}
    {authenticated&&<div className="card live-controls">
      <label>{c.camera}<select value={serial} disabled={loading||activeOwner||operation!=='idle'} onChange={event=>setSerial(event.target.value)}>
        <option value="">{c.choose}</option>
        {attemptableDevices.length>0&&<optgroup label={c.attemptable}>{attemptableDevices.map(device=><option key={device.serial} value={device.serial}>{device.name} · {device.model||'?'} · {device.serial}</option>)}</optgroup>}
        {otherDevices.length>0&&<optgroup label={c.other}>{otherDevices.map(device=><option key={device.serial} value={device.serial}>{device.name} · {device.model||'?'} · {device.serial}</option>)}</optgroup>}
      </select></label>
      <label>{c.duration}<input aria-label={c.duration} type="number" min="1" max="60" step="1" value={duration} disabled={activeOwner||operation!=='idle'} onChange={event=>setDuration(Number(event.target.value))}/></label>
      {loading&&<p role="status">{c.loading}</p>}{loadError&&<p role="status" className="error">{errorMessage(loadError)}</p>}
      {!loading&&!loadError&&!devices.length&&<p role="status">{c.noDevices}</p>}
      {selected&&<div className="live-eligibility" role="status"><strong>{c.capability}:</strong> {capability?.status||'unknown'}
        <p>{capability?.status==='verified'?c.verified:capability?.status==='protocol_hint'?c.hint:capability?.status==='unsupported'?c.unsupported:c.unknown}</p>
        {!supportedPath(selected)&&<p>{c.wrongPath}</p>}{['offline','unavailable'].includes(selected.availability)&&<p>{c.offline}</p>}
        {capability?.reason&&<small>{c.capabilityReason}: {capability.reason}</small>}
      </div>}
      {(!Number.isInteger(duration)||duration<1||duration>60)&&<p role="alert" className="error">{c.durationError}</p>}
      <button type="button" disabled={!canStart} onClick={start}>{operation==='starting'?c.starting:c.start}</button>
      <p className="normalized">{c.limits}</p>
    </div>}
    {activeOwner&&live&&<section className="live-session" aria-label={c.title}>
      <p role="status" className="live-state">{stateText(live)}</p>
      {live.state==='streaming'&&<>
        <img className="live-video" src={live.media.url} alt={language==='en'?'Live video preview':'实时视频预览'} onLoad={()=>setBrowserDecoded(true)} onError={()=>setStatusError({code:'LIVE_MEDIA_UNAVAILABLE'})}/>
        <p role="status">{browserDecoded?c.firstFrame:c.waitingFrame}</p>
        <p>{c.remaining}: {Math.max(0,Math.ceil((live.expiresAtMs-now)/1000))}</p>
      </>}
      <p>{c.resources}: {live.cleanupComplete?c.confirmed:c.pending}</p>
      {(statusError||startError||stopError)&&<p role="status" className="error">{errorMessage(statusError||startError||stopError)}</p>}
      <button type="button" disabled={operation!=='idle'} onClick={()=>void stopSession(live.sessionId).catch(()=>{})}>{operation==='stopping'?c.stopping:c.stop}</button>
      {live.error&&<p role="status" className="error">{errorMessage(live.error)}</p>}
    </section>}
    {live&&live.cleanupComplete&&<section className="live-session" aria-label={c.title}>
      <p role="status" className={live.state==='failed'?'error':'live-state'}>{stateText(live)}</p>
      <p>{c.resources}: {c.confirmed}</p>
      {live.error&&<p role="status" className="error">{errorMessage(live.error)}</p>}
    </section>}
    {startError&&<p role="status" className="error">{errorMessage(startError)}</p>}
    {stopError&&activeOwner&&<p role="status" className="error">{c.stopUnconfirmed}</p>}
  </section>
}
