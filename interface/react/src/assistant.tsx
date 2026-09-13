import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AssistantRuntimeProvider, ComposerPrimitive, MessagePrimitive, ThreadPrimitive, useExternalStoreRuntime, type AppendMessage, type ThreadMessageLike } from '@assistant-ui/react'
import { api, type AgentState } from './client'
import { ConfirmDialog } from './shadcn-admin-adapted'
import { mountWorkspace } from '../../workspace/workspace.mjs'

type Language='en'|'zh-CN'
type Pending={id:string;text:string;locale:Language}
type ChatMessage={id:string;role:'user'|'assistant';text:string;status?:ThreadMessageLike['status']}
const key=(name:string)=>`eufy-agent-hub.${name}`
const read=(name:string,fallback='')=>{try{return localStorage.getItem(key(name))||fallback}catch{return fallback}}
const write=(name:string,value:string)=>{try{localStorage.setItem(key(name),value)}catch{}}
const savedPending=()=>{try{const value=JSON.parse(read('pendingTurn','null'));return value?.id&&value?.text&&['en','zh-CN'].includes(value.locale)?value as Pending:undefined}catch{return undefined}}
const storage=()=>{try{return localStorage}catch{return undefined}}
const text=(message:AppendMessage)=>message.content.filter(part=>part.type==='text').map(part=>part.text).join('')
const problem=(error:any)=>error?.body?.error||(error?.code?error:{code:'SERVICE_UNAVAILABLE',message:error?.message||'Request failed'})

export function AssistantWorkspace({open,title,close,closeLabel,returnFocusRef,language,catalog,onManual}:{open:boolean;title:string;close:()=>void;closeLabel:string;returnFocusRef:React.RefObject<HTMLElement|null>;language:Language;catalog:Record<string,string>;onManual:()=>void}) {
  const live=useRef({language,catalog});live.current={language,catalog}
  const translate=useCallback((name:string,params:Record<string,unknown>={},fallback=name)=>{
    const template=live.current.catalog[name]||fallback
    return template.replace(/\{(\w+)\}/g,(_:string,k:string)=>String(params[k]??''))
  },[])
  const i18n=useRef<any>(null)
  if(!i18n.current)i18n.current={get locale(){return live.current.language},t:translate}
  const workspace=useRef<any>(),stateRef=useRef<AgentState>(),inventoryRef=useRef<any>(),polling=useRef<Promise<AgentState|undefined>>(),runtimeRef=useRef<any>()
  const pending=useRef<Pending|undefined>(savedPending()),sending=useRef(false)
  const [state,setState]=useState<AgentState>(),[loading,setLoading]=useState(true),[submitError,setSubmitError]=useState<any>(),[responseLocale,setResponseLocale]=useState(()=>{const value=read('responseLocale','auto');return ['en','zh-CN'].includes(value)?value:'auto'}),[sendBusy,setSendBusy]=useState(false)

  const errorText=useCallback((value:any)=>translate(`ui.error.${value?.code}`,{},value?.message||value?.code||translate('ui.error.SERVICE_UNAVAILABLE',{},'The local service is unavailable.')),[translate])
  const acknowledge=useCallback((next:AgentState)=>{
    const accepted=pending.current&&next.turns.some(turn=>turn.id===pending.current!.id)
    if(!accepted)return
    const acceptedText=pending.current!.text;pending.current=undefined;write('pendingTurn','null');setSubmitError(undefined)
    const composer=runtimeRef.current?.thread.composer
    if(composer?.getState().text===acceptedText){composer.setText('');write('draft','')}
  },[])
  const poll=useCallback(()=>{
    if(polling.current)return polling.current
    const request=(async()=>{try{
      const next=await api.agentState(workspace.current?.jobIds()||[]);let inventory
      try{inventory=await api.devices()}catch(error){inventory={devices:[],error:problem(error)}}
      stateRef.current=next;inventoryRef.current=inventory;setState(next);setLoading(false);setSubmitError(current=>['SERVICE_UNAVAILABLE','INTERFACE_UNAVAILABLE'].includes(current?.code)?undefined:current);acknowledge(next)
      workspace.current?.update(next,inventory,inventory.error);return next
    }catch(error){setLoading(false);setSubmitError(current=>current||problem(error));workspace.current?.update(stateRef.current,inventoryRef.current,{code:'SERVICE_UNAVAILABLE'});return undefined}
    finally{polling.current=undefined}})()
    polling.current=request;return request
  },[acknowledge])

  useEffect(()=>{workspace.current=mountWorkspace({document,i18n:i18n.current,storage:storage(),fetch,onChange:poll});poll();const timer=setInterval(poll,1500);return()=>clearInterval(timer)},[poll])
  useEffect(()=>{workspace.current?.render()},[language,catalog])

  const messages=useMemo<ChatMessage[]>(()=>state?.turns.flatMap(turn=>{
    const failure=turn.error?errorText(turn.error):''
    const response=turn.state==='running'?translate('ui.agentRunning',{},'Assistant is working.'):failure||turn.response||translate('ui.agentReady',{},'Ready for another request.')
    const status:ThreadMessageLike['status']=turn.state==='running'?{type:'running'}:failure?{type:'incomplete',reason:'error',error:{code:turn.error?.code||'AGENT_FAILED'}}:{type:'complete',reason:'stop'}
    return [{id:`${turn.id}:user`,role:'user',text:turn.text},{id:`${turn.id}:assistant`,role:'assistant',text:response,status}]
  })||[],[state?.turns,errorText,translate,language,catalog])
  const onNew=useCallback(async(message:AppendMessage)=>{
    const value=text(message).trim();if(!value||sending.current)return
    let owned=pending.current
    if(!owned||owned.text!==value)owned={id:crypto.randomUUID(),text:value,locale:['en','zh-CN'].includes(responseLocale)?responseLocale as Language:language}
    pending.current=owned;write('pendingTurn',JSON.stringify(owned));write('draft',value);sending.current=true;setSendBusy(true);setSubmitError(undefined)
    try{await api.agentTurn(owned);await poll()}
    catch(error){const recovered=await poll();if(!recovered?.turns.some(turn=>turn.id===owned!.id)){setSubmitError(problem(error));throw error}}
    finally{sending.current=false;setSendBusy(false)}
  },[language,responseLocale,poll])
  const runtime=useExternalStoreRuntime<ChatMessage>({messages,isLoading:loading,isRunning:Boolean(state?.busy),isSendDisabled:Boolean(state?.busy||sendBusy),onNew,
    convertMessage:message=>({id:message.id,role:message.role,content:[{type:'text',text:message.text}],status:message.status})})
  runtimeRef.current=runtime
  const seeded=useRef(false);useEffect(()=>{if(!seeded.current){seeded.current=true;runtime.thread.composer.setText(read('draft'))}},[runtime])
  const notices=state?.busy?state.notices:state?.turns.at(-1)?.notices||[]
  const messageComponents=useMemo(()=>({
    UserMessage:()=> <MessagePrimitive.Root className="aui-message user"><strong>{translate('ui.you',{},'You')}</strong><MessagePrimitive.Parts/></MessagePrimitive.Root>,
    AssistantMessage:()=> <MessagePrimitive.Root className="aui-message assistant-response"><strong>{title}</strong><MessagePrimitive.Parts/></MessagePrimitive.Root>,
  }),[translate,title,language,catalog])

  return <>
    <section className="shared-workspace" aria-labelledby="shared-workspace-title"><h2 id="shared-workspace-title">{translate('ui.sharedResults',{},'Workspace')}</h2><p>{translate('ui.sharedHint',{},'Assistant and manual results share registered resident data.')}</p>{loading&&<p role="status">{translate('ui.agentLoading',{},'Loading the resident conversation…')}</p>}<p id="workspace-status" role="status"/><div id="workspace-views"/></section>
    <ConfirmDialog open={open} title={title} close={close} closeLabel={closeLabel} returnFocusRef={returnFocusRef}>
      <AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Root className="aui-thread"><ThreadPrimitive.Viewport className="aui-viewport">
        <ThreadPrimitive.Empty><p className="aui-empty">{loading?translate('ui.agentLoading',{},'Loading conversation…'):translate('ui.agentHint',{},'Name the camera, date, and start and end times.')}</p></ThreadPrimitive.Empty>
        <ThreadPrimitive.Messages components={messageComponents}/>
        <ThreadPrimitive.ViewportFooter className="aui-footer"><p>{translate('ui.agentPrivacy',{},'Use the normal sign-in form for passwords and verification codes; never put them in chat.')}</p>
          <label>{translate('ui.responseLanguage',{},'Response language')}<select value={responseLocale} onChange={event=>{setResponseLocale(event.target.value);write('responseLocale',event.target.value)}}><option value="auto">{translate('ui.responseAuto',{},'Follow interface')}</option><option value="en">EN</option><option value="zh-CN">中文</option></select></label>
          <ComposerPrimitive.Root className="aui-composer"><ComposerPrimitive.Input aria-label={translate('ui.message',{},'Recording request')} placeholder={translate('ui.agentHint',{},'Name the camera, date, and start and end times.')} onChange={event=>write('draft',event.target.value)} addAttachmentOnPaste={false}/><ComposerPrimitive.Send>{sendBusy?translate('ui.agentRunning',{},'Working…'):translate('ui.send',{},'Send')}</ComposerPrimitive.Send></ComposerPrimitive.Root>
        </ThreadPrimitive.ViewportFooter></ThreadPrimitive.Viewport></ThreadPrimitive.Root></AssistantRuntimeProvider>
      {submitError&&<div className="assistant-error" role="status"><p>{errorText(submitError)}</p><button type="button" onClick={poll}>{translate('ui.workspaceRetry',{},'Retry connection')}</button></div>}
      {notices.map((notice:any,index:number)=><p className="assistant-error" role="status" key={index}>{errorText(notice.error)}</p>)}
      <button type="button" className="link" onClick={onManual}>{translate('ui.modeFixed',{},'Browse recordings')}</button>
    </ConfirmDialog>
  </>
}
