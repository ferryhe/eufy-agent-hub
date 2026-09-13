/**
 * Adapted from satnaing/shadcn-admin e16c87f213a5ba5e45964e9b67c792105ec74d26
 * `src/components/ui/sheet.tsx`, `ui/dialog.tsx`, and `confirm-dialog.tsx`.
 * MIT, Sat Naing 2024. Radix owns modal focus, Escape, portal and overlay behavior.
 */
import React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog'
export function NavGroup({items,active,onNavigate,label}:{items:Array<{id:string;label:string}>;active:string;onNavigate:(id:string)=>void;label:string}){return <nav aria-label={label}>{items.map(x=><button type="button" className={active===x.id?'active':''} aria-current={active===x.id?'page':undefined} onClick={()=>onNavigate(x.id)} key={x.id}>{x.label}</button>)}</nav>}
export function ThemeSwitch({dark,onToggle,label}:{dark:boolean;onToggle:()=>void;label:string}){return <button type="button" aria-pressed={dark} onClick={onToggle}>{label}</button>}
export function OtpForm({label,busy,onSubmit,help}:{label:string;busy:boolean;onSubmit:(x:string)=>void;help:string}){return <form onSubmit={e=>{e.preventDefault();onSubmit(String(new FormData(e.currentTarget).get('code')||''))}}><label>{label}<input name="code" autoComplete="one-time-code" aria-describedby="verification-help" required/></label><p id="verification-help" className="sr-only">{help}</p><button disabled={busy}>{label}</button></form>}
export function ConfirmDialog({open,title,close,children,closeLabel,returnFocusRef}:{open:boolean;title:string;close:()=>void;children:React.ReactNode;closeLabel:string;returnFocusRef?:React.RefObject<HTMLElement|null>}){return <DialogPrimitive.Root open={open} onOpenChange={next=>{if(!next)close()}}><DialogPrimitive.Portal><DialogPrimitive.Overlay className="drawer-overlay"/><DialogPrimitive.Content className="drawer" aria-label={title} onCloseAutoFocus={event=>{if(returnFocusRef?.current){event.preventDefault();returnFocusRef.current.focus()}}}><div><DialogPrimitive.Close asChild><button>{closeLabel}</button></DialogPrimitive.Close><DialogPrimitive.Title asChild><h2>{title}</h2></DialogPrimitive.Title>{children}</div></DialogPrimitive.Content></DialogPrimitive.Portal></DialogPrimitive.Root>}
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
