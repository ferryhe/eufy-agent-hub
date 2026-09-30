import React, { useEffect, useRef } from 'react'
import { createResults } from '../../components/results.mjs'
import type { Artifact, Job } from './client'

const terminal = (job:Job) => ['succeeded','failed','cancelled'].includes(job.state)

export function jobStatus(job:Job) {
  const result=job.result
  if(job.state==='running'&&job.cancellationRequestedAt)return 'stopping'
  if(job.state==='failed'&&job.error?.code==='JOB_INTERRUPTED')return 'interrupted'
  if(job.state==='succeeded'&&result?.outcome==='complete'&&result.coverageVerified===true&&result.validation?.passed===true)return 'complete'
  if(result?.outcome==='partial')return 'partial'
  return terminal(job)?(job.state==='cancelled'?'cancelled':'failed'):job.state
}

export function jobResultView(job:Job) {
  const status=jobStatus(job),result=job.result
  return {job,status,complete:status==='complete',videos:(job.artifacts||[]).filter(item=>item.playable&&item.validated),coverage:result?.coverage??null,
    validation:result?.validation??null,diagnostics:result?.diagnostics??[],error:job.error}
}

export function JobResultCard({job,i18n,onSaveArtifact}:{job:Job;i18n:any;onSaveArtifact?:(artifact:Artifact,job:Job)=>void}) {
  const root=useRef<HTMLDivElement>(null)
  useEffect(()=>{const results=createResults({document,i18n,onSave:onSaveArtifact}),card=root.current!.firstElementChild
    if(card)results.updateJob(card,jobResultView(job));else root.current!.append(results.job(jobResultView(job)))},[job,i18n,onSaveArtifact])
  return <div ref={root}/>
}
