import {useEffect,useState} from 'react';
import type {ApplicationCallbackBinding,CallbackReview} from '../../contract/browser.ts';
import {Button} from '@/components/ui/button';
import {Label} from '@/components/ui/label';
import {Select,SelectContent,SelectItem,SelectTrigger,SelectValue} from '@/components/ui/select';

type ApplicationCallbacksProps={bindings:ApplicationCallbackBinding[];review?:CallbackReview;fixedOriginsCount:number;bindingEditsDisabled?:boolean;onChange:(bindings:ApplicationCallbackBinding[])=>void;onValidityChange:(valid:boolean)=>void};
type Row={key:string;applicationId:string;hostname:ApplicationCallbackBinding['hostname']|''};
const hosts=['localhost','127.0.0.1'] as const;
export default function ApplicationCallbacks({bindings,review,fixedOriginsCount,bindingEditsDisabled=false,onChange,onValidityChange}:ApplicationCallbacksProps){
 const [rows,setRows]=useState<Row[]>(()=>bindings.map(binding=>({...binding,key:crypto.randomUUID()})));
 const complete=(row:Row):row is Row&ApplicationCallbackBinding=>Boolean(row.hostname);
 const valid=rows.every(complete)&&new Set(rows.map(row=>JSON.stringify([row.applicationId,row.hostname]))).size===rows.length&&fixedOriginsCount+rows.length<=10;
 useEffect(()=>onValidityChange(valid),[valid,onValidityChange]);
 function change(next:Row[]){setRows(next);onChange(next.filter(complete).map(({applicationId,hostname})=>({applicationId,hostname})));}
 return <div className="space-y-3">
  <Label>Application callbacks</Label>
  {rows.map((row,index)=>{
   const application=review?.application?.applicationId===row.applicationId?review.application:null;
   const origin=application&&row.hostname?new URL(application.origin):null;if(origin)origin.hostname=row.hostname;
   return <div key={row.key} className="space-y-2">
    <div className="flex items-center justify-between gap-2"><span className="min-w-0 break-all text-sm">{row.applicationId}</span><Button type="button" variant="ghost" size="sm" aria-label={`Remove callback ${index+1}`} onClick={()=>change(rows.filter(item=>item.key!==row.key))}>Remove</Button></div>
    <Label htmlFor={`callback-host-${row.key}`}>Callback host {index+1}</Label>
    <Select value={row.hostname} disabled={bindingEditsDisabled||!application} onValueChange={value=>{if(hosts.some(host=>host===value))change(rows.map(item=>item.key===row.key?{...item,hostname:value as ApplicationCallbackBinding['hostname']}:item));}}>
     <SelectTrigger id={`callback-host-${row.key}`}><SelectValue placeholder="Choose host" /></SelectTrigger>
     <SelectContent>{hosts.map(host=><SelectItem key={host} value={host} disabled={rows.some(item=>item.key!==row.key&&item.applicationId===row.applicationId&&item.hostname===host)}>{host}</SelectItem>)}</SelectContent>
    </Select>
    {origin&&<div className="break-all font-mono text-xs text-muted-foreground">{origin.origin}</div>}
   </div>;
  })}
  {rows.length>0&&review?.error&&<p role="alert" className="text-sm text-destructive">{review.error}</p>}
  {fixedOriginsCount+rows.length>10&&<p role="alert" className="text-sm text-destructive">Review at most ten fixed sites and application callbacks.</p>}
  <Button type="button" variant="outline" size="sm" disabled={bindingEditsDisabled||!review?.application||fixedOriginsCount+rows.length>=10||rows.filter(row=>row.applicationId===review.application?.applicationId).length>=hosts.length} onClick={()=>{if(review?.application)change([...rows,{key:crypto.randomUUID(),applicationId:review.application.applicationId,hostname:''}]);}}>Add callback</Button>
 </div>;
}
