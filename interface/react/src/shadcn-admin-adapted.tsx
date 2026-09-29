/**
 * Adapted from satnaing/shadcn-admin e16c87f213a5ba5e45964e9b67c792105ec74d26
 * `src/components/ui/sheet.tsx`, `ui/dialog.tsx`, and `confirm-dialog.tsx`.
 * MIT, Sat Naing 2024. Radix owns modal focus, Escape, portal and overlay behavior.
 */
import React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog'
export function RobotIcon({className}:{className?:string}){return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M12 4V2.5"/><circle cx="12" cy="2" r=".5" fill="currentColor" stroke="none"/><rect x="4.5" y="6.5" width="15" height="14" rx="4"/><path d="M2.5 11v4M21.5 11v4M9 12h.01M15 12h.01M9.5 16h5"/></svg>}
function NavIcon({id}:{id:string}){if(id==='recordings')return <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="m10 9 5 3-5 3z"/></svg>;if(id==='live')return <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2.5"/><path d="M12 3.5v2M20.5 12h-2"/></svg>;if(id==='jobs')return <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V2.5h6V4M9 10h6M9 14h6M9 18h3"/></svg>;return <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="3"/><path d="m19.4 15 .1.1 1.2 1-.9 1.6-1.5-.5-.2.1a7.5 7.5 0 0 1-1.5.9l-.2.1-.3 1.6h-1.9l-.3-1.6-.2-.1a7.5 7.5 0 0 1-1.5-.9l-.2-.1-1.5.5-.9-1.6 1.2-1 .1-.2a7 7 0 0 1 0-1.8l-.1-.2-1.2-1 .9-1.6 1.5.5.2-.1a7.5 7.5 0 0 1 1.5-.9l.2-.1.3-1.6h1.9l.3 1.6.2.1a7.5 7.5 0 0 1 1.5.9l.2.1 1.5-.5.9 1.6-1.2 1-.1.2a7 7 0 0 1 0 1.8Z"/></svg>}
export function NavGroup({items,active,onNavigate,label}:{items:Array<{id:string;label:string}>;active:string;onNavigate:(id:string)=>void;label:string}){return <nav aria-label={label}>{items.map(x=><button type="button" className={`nav-item ${active===x.id?'active':''}`} aria-label={x.label} title={x.label} aria-current={active===x.id?'page':undefined} onClick={()=>onNavigate(x.id)} key={x.id}><NavIcon id={x.id}/><span className="nav-label">{x.label}</span></button>)}</nav>}
export function ThemeSwitch({dark,onToggle,label}:{dark:boolean;onToggle:()=>void;label:string}){return <button type="button" aria-pressed={dark} onClick={onToggle}>{label}</button>}
export function OtpForm({label,busy,onSubmit,help}:{label:string;busy:boolean;onSubmit:(x:string)=>void;help:string}){return <form onSubmit={e=>{e.preventDefault();onSubmit(String(new FormData(e.currentTarget).get('code')||''))}}><label>{label}<input name="code" autoComplete="one-time-code" aria-describedby="verification-help" required/></label><p id="verification-help" className="sr-only">{help}</p><button disabled={busy}>{label}</button></form>}
export function ConfirmDialog({open,title,close,children,closeLabel,returnFocusRef}:{open:boolean;title:string;close:()=>void;children:React.ReactNode;closeLabel:string;returnFocusRef?:React.RefObject<HTMLElement|null>}){return <DialogPrimitive.Root open={open} onOpenChange={next=>{if(!next)close()}}><DialogPrimitive.Portal><DialogPrimitive.Overlay className="drawer-overlay"/><DialogPrimitive.Content className="drawer assistant-drawer" aria-label={title} onCloseAutoFocus={event=>{if(returnFocusRef?.current){event.preventDefault();returnFocusRef.current.focus()}}}><div className="assistant-panel"><div className="assistant-header"><DialogPrimitive.Title asChild><h2><span className="assistant-avatar"><RobotIcon/></span>{title}</h2></DialogPrimitive.Title><DialogPrimitive.Close asChild><button type="button" className="dialog-close" aria-label={closeLabel} title={closeLabel}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></DialogPrimitive.Close></div><div className="assistant-panel-body">{children}</div></div></DialogPrimitive.Content></DialogPrimitive.Portal></DialogPrimitive.Root>}
export const Sheet=DialogPrimitive.Root
export const SheetContent=DialogPrimitive.Content
export const SheetPortal=DialogPrimitive.Portal
export const SheetOverlay=DialogPrimitive.Overlay
export const SheetClose=DialogPrimitive.Close
export const AlertDialog=AlertDialogPrimitive.Root
export const AlertDialogTrigger=AlertDialogPrimitive.Trigger
export const AlertDialogPortal=AlertDialogPrimitive.Portal
export const AlertDialogOverlay=AlertDialogPrimitive.Overlay
export const AlertDialogContent=AlertDialogPrimitive.Content
export const AlertDialogTitle=AlertDialogPrimitive.Title
export const AlertDialogCancel=AlertDialogPrimitive.Cancel
export const AlertDialogAction=AlertDialogPrimitive.Action
