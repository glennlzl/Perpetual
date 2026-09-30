import { useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { CHECKS } from '@/lib/browser-test-ui';
import { COMPARE_OPS, STEP_CHECKS, checkRow, earlierCaptures, nextCaptureName, stepRow, type CheckRow, type StepRow } from '@/lib/journey-steps';

const OPS: Record<string, string> = { '<': '<', '>': '>', '=': '=', '!=': '≠' };
const TEXT = new Set(['text-visible', 'text-absent', 'url-contains']);

function StepChecks({ rows, index, added, onAdd, onChange }: { rows: StepRow[]; index: number; added: string; onAdd: (key: string) => void; onChange: (checks: CheckRow[]) => void }) {
  const row = rows[index];
  const update = (checkIndex: number, patch: Partial<CheckRow>) => onChange(row.checks.map((check, current) => current === checkIndex ? { ...check, ...patch } : check));
  return <Collapsible defaultOpen={row.checks.length > 0} className="pl-7">
    <CollapsibleTrigger asChild><Button type="button" variant="ghost" size="sm" className="h-7 px-1.5 text-xs text-muted-foreground [&[data-state=open]>svg]:rotate-180">Checks{row.checks.length > 0 && <span className="tabular-nums">({row.checks.length})</span>}<ChevronDown className="size-3.5 transition-transform" /></Button></CollapsibleTrigger>
    <CollapsibleContent className="grid gap-2 pt-1">
      {row.checks.map((check, checkIndex) => {
        const name = `Step ${index + 1} check ${checkIndex + 1}`, captures = earlierCaptures(rows, index, checkIndex);
        return <div key={check.key} className="flex flex-wrap items-center gap-2">
          <Select value={check.type} onValueChange={type => update(checkIndex, { type, ...(!TEXT.has(type) && !check.name.trim() ? { name: nextCaptureName(rows) } : {}) })}><SelectTrigger aria-label={`${name} type`} autoFocus={check.key === added} className="w-40"><SelectValue /></SelectTrigger><SelectContent>{STEP_CHECKS.map(type => <SelectItem key={type} value={type}>{CHECKS[type]}</SelectItem>)}</SelectContent></Select>
          {TEXT.has(check.type)
            ? <Input aria-label={`${name} value`} maxLength={4000} value={check.value} className="min-w-32 flex-1" onChange={event => update(checkIndex, { value: event.target.value })} />
            : <>
              <Input aria-label={`${name} label`} placeholder="Label" maxLength={120} value={check.label} className="min-w-24 flex-1" onChange={event => update(checkIndex, { label: event.target.value })} />
              {check.type === 'compare-number' && <>
                <Select value={check.op} onValueChange={op => update(checkIndex, { op })}><SelectTrigger aria-label={`${name} comparison`} className="w-16"><SelectValue /></SelectTrigger><SelectContent>{COMPARE_OPS.map(op => <SelectItem key={op} value={op}>{OPS[op]}</SelectItem>)}</SelectContent></Select>
                <Select value={captures.includes(check.than) ? check.than : ''} disabled={!captures.length} onValueChange={than => update(checkIndex, { than })}><SelectTrigger aria-label={`${name} earlier reading`} className="w-36"><SelectValue placeholder="Earlier reading" /></SelectTrigger><SelectContent>{captures.map(capture => <SelectItem key={capture} value={capture}>{capture}</SelectItem>)}</SelectContent></Select>
              </>}
              <Input aria-label={`${name} name`} placeholder="Name" maxLength={40} autoCapitalize="none" spellCheck={false} value={check.name} className="w-32" onChange={event => update(checkIndex, { name: event.target.value })} />
            </>}
          <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${name.toLowerCase()}`} onClick={() => onChange(row.checks.filter((_, current) => current !== checkIndex))}><Trash2 /></Button>
        </div>;
      })}
      <Button type="button" variant="outline" size="sm" className="w-fit" disabled={row.checks.length >= 6} onClick={() => { const check = checkRow(); onAdd(check.key); onChange([...row.checks, check]); }}><Plus />Add check</Button>
    </CollapsibleContent>
  </Collapsible>;
}

// Ordered milestones: one title per row, with optional independent checks the runner evaluates itself.
export default function JourneyStepEditor({ rows, onChange }: { rows: StepRow[]; onChange: (rows: StepRow[]) => void }) {
  const [added, setAdded] = useState('');
  const update = (index: number, patch: Partial<StepRow>) => onChange(rows.map((row, current) => current === index ? { ...row, ...patch } : row));
  function move(index: number, offset: number) {
    const next = [...rows], [row] = next.splice(index, 1);
    next.splice(index + offset, 0, row); onChange(next);
  }
  return <div role="group" aria-labelledby="journey-steps-label" className="grid min-w-0 gap-2">
    <div className="flex items-center justify-between gap-3"><Label id="journey-steps-label">Business steps</Label><span className="text-xs tabular-nums text-muted-foreground">{rows.length}/12</span></div>
    {!!rows.length && <ol className="grid gap-2">{rows.map((row, index) => <li key={row.key} className="journey-step-row grid gap-1 rounded-lg border p-2">
      <div className="flex min-w-0 flex-wrap items-start gap-1">
        <div className="flex min-w-0 flex-1 basis-56 items-start gap-1">
          <span aria-hidden="true" className="mt-3 w-6 shrink-0 text-center text-xs tabular-nums text-muted-foreground">{index + 1}</span>
          <Textarea aria-label={`Step ${index + 1} title`} autoFocus={row.key === added} rows={1} maxLength={240} value={row.title} className="min-h-10 min-w-0 flex-1 resize-y" onChange={event => update(index, { title: event.target.value })} />
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button type="button" variant="ghost" size="icon-sm" aria-label={`Move step ${index + 1} up`} disabled={!index} onClick={() => move(index, -1)}><ArrowUp /></Button>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={`Move step ${index + 1} down`} disabled={index === rows.length - 1} onClick={() => move(index, 1)}><ArrowDown /></Button>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove step ${index + 1}`} onClick={() => onChange(rows.filter((_, current) => current !== index))}><Trash2 /></Button>
        </div>
      </div>
      <StepChecks rows={rows} index={index} added={added} onAdd={setAdded} onChange={checks => update(index, { checks })} />
    </li>)}</ol>}
    <Button type="button" variant="outline" size="sm" className="w-fit" disabled={rows.length >= 12} onClick={() => { const row = stepRow(); setAdded(row.key); onChange([...rows, row]); }}><Plus />Add step</Button>
  </div>;
}
