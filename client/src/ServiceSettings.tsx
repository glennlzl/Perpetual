import { useEffect, useState } from 'react';
import { ExternalLink, FileCode2, GitBranch, LoaderCircle, RotateCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { branchMismatchNote } from '@/lib/journey-config';
import type { ConfigField as ConfigFieldValue, ServiceConfiguration } from '../../contract/service-config.ts';

type Mismatch = { branches: string[]; branch: string };

// Scanned values are read-only text. Commands, paths and identifiers stay mono;
// a preview URL or vercel.app alias opens the deployment.
const fieldHref = (value: unknown) => typeof value !== 'string' ? null : /^https:\/\/\S+$/.test(value) ? value : /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.vercel\.app$/i.test(value) ? `https://${value}` : null;

// The Test settings mismatch mark: branch icon and name in the warning tint, both branches in its
// Tooltip. Only the scanner's literal deploy branches are compared; nothing is inferred from the alias.
function BranchMismatch({ branches, branch }: Mismatch) {
  return <Tooltip>
    <TooltipTrigger asChild><span tabIndex={0} className="inline-flex min-w-0 items-center gap-1 rounded-sm font-sans text-xs text-(--warning) [overflow-wrap:anywhere]">
      <GitBranch aria-hidden="true" className="size-3 shrink-0" />{branches.join(', ')}<span className="sr-only">, not {branch}</span>
    </span></TooltipTrigger>
    <TooltipContent>{branchMismatchNote(branches, branch)}</TooltipContent>
  </Tooltip>;
}

function ConfigField({ field, mismatch }: { field: ConfigFieldValue; mismatch: Mismatch | null }) {
  const value = field.type === 'boolean' ? field.value ? 'Enabled' : 'Disabled' : String(field.value ?? '');
  const href = fieldHref(field.value), mono = Boolean(href) || (field.type === 'text' && field.key !== 'framework');
  return <div className="grid gap-0.5">
    <dt className="text-sm text-muted-foreground">{field.label}</dt>
    <dd className={`min-w-0 [overflow-wrap:anywhere] ${mono ? 'font-mono text-[13px] leading-5' : 'text-sm'}`}>
      {field.type === 'list' ? <div className="flex flex-wrap gap-2 pt-1">
        {field.value?.length ? field.value.map((item, index) => <Badge key={`${index}-${item}`} variant="secondary">{item}</Badge>) : <span className="text-muted-foreground">Not configured</span>}
      </div>
        : href ? <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <Button variant="link" className="h-auto max-w-full items-start justify-start gap-1.5 whitespace-normal p-0 text-left text-[13px] leading-5 font-normal has-[>svg]:p-0" asChild>
            <a href={href} target="_blank" rel="noopener noreferrer"><span className="min-w-0 [overflow-wrap:anywhere]">{value}</span><ExternalLink className="mt-0.5 size-3.5" /></a>
          </Button>
          {mismatch && <BranchMismatch {...mismatch} />}
        </div>
        : value || <span className="font-sans text-muted-foreground">Not configured</span>}
    </dd>
  </div>;
}

// A service dialog always names its node.
export default function ServiceSettings({ nodeId, repoPath, deployBranches, branch }: { nodeId?: string; repoPath?: string; deployBranches?: unknown; branch?: string | null }) {
  const isWorkflow = nodeId!.startsWith('workflow:') || nodeId!.startsWith('job:');
  const branches = Array.isArray(deployBranches) ? [...new Set(deployBranches.filter((value): value is string => typeof value === 'string' && Boolean(value)))] : [];
  const mismatch = branch && branches.length && !branches.includes(branch) ? { branches, branch } : null;
  const [configuration, setConfiguration] = useState<ServiceConfiguration | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    setConfiguration(null);
    setError('');
    setLoading(true);
    const params = new URLSearchParams({ nodeId: nodeId!, repoPath: repoPath! });
    api<ServiceConfiguration>(`/api/service-config?${params}`).then(result => {
      if (active) setConfiguration(result);
    }).catch(failure => {
      if (active) setError(failure instanceof Error ? failure.message : 'Could not load configuration.');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [nodeId, repoPath, reload]);

  if (loading) return <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><LoaderCircle className="size-4 motion-safe:animate-spin" />Loading configuration…</div>;
  if (error) return <div className="space-y-3"><p role="alert" className="break-words text-sm text-destructive">{error}</p><Button type="button" variant="outline" onClick={() => setReload(value => value + 1)}><RotateCw />Retry</Button></div>;

  const sections = isWorkflow || configuration?.provider === 'Railway' ? [] : configuration?.sections || [];

  return <div className="space-y-6">
    {!!configuration?.files?.length && <section className="space-y-3">
      <h3 className="text-sm font-medium">{isWorkflow ? 'Workflow' : 'Configuration files'}</h3>
      {configuration.files.map(file => file.editUrl
        ? <Button key={file.path} type="button" variant="outline" className="h-auto min-h-9 w-full items-start justify-start py-2" asChild>
          <a href={file.editUrl} target="_blank" rel="noopener noreferrer" aria-label={`Edit ${file.path} on GitHub`}>
            <FileCode2 className="mt-0.5" /><span className="min-w-0 flex-1 whitespace-normal text-left leading-5 [overflow-wrap:anywhere]">{isWorkflow ? file.path.split('/').at(-1) : file.path}</span><span className="shrink-0 leading-5">{isWorkflow ? 'Edit on GitHub' : 'Edit'}</span><ExternalLink className="mt-0.5" />
          </a>
        </Button>
        // Without an editUrl the branch is not on GitHub, so the path stays plain text.
        : <div key={file.path} className="flex min-w-0 items-start gap-2">
          <FileCode2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" /><span className="min-w-0 flex-1 font-mono text-[13px] leading-5 [overflow-wrap:anywhere]">{file.path}</span>{file.local && <Badge variant="outline" className="shrink-0">Local</Badge>}
        </div>)}
    </section>}
    {sections.map((section, index) => <section key={section.id} className="space-y-4">
      {(index > 0 || !!configuration!.files?.length) && <Separator />}
      {!section.fields.some(field => field.label === section.title) && <h3 className="text-sm font-medium">{section.title}</h3>}
      <dl className="grid gap-3">{section.fields.map(field => <ConfigField key={field.key} field={field} mismatch={field.key === 'previewAlias' ? mismatch : null} />)}</dl>
    </section>)}
    {!configuration?.files?.length && !sections.length && <p className="text-sm text-muted-foreground">No configuration found</p>}
  </div>;
}
