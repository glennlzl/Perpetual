import { useEffect, useRef, useState } from 'react';
import { Check, Copy, ExternalLink, LoaderCircle } from 'lucide-react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import { restoreFocus, type FocusTarget } from '@/lib/journey-focus';
import type { GitHubConnection } from './SourceSettings';

/** A GitHub device sign-in as /api/github/auth/start and /status report it. */
type AuthSession = { id?: string; status?: string; userCode?: string; error?: string; account?: { login: string } | null };

const DEVICE_URL = 'https://github.com/login/device';
const pending = (session: AuthSession | null) => ['starting', 'pending'].includes(session?.status ?? '');

export default function GitHubConnectDialog({ connection, checking = false, onConnect, onClose, focusTarget }: { connection: GitHubConnection | null; checking?: boolean; onConnect: () => Promise<unknown>; onClose: () => void; focusTarget: () => FocusTarget | null }) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [starting, setStarting] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const active = useRef(true);
  const sessionId = useRef<string | null | undefined>(null);
  const submitting = useRef(false);
  const openGitHub = useRef<HTMLAnchorElement>(null);
  const callbacks = useRef({ onConnect, onClose });
  callbacks.current = { onConnect, onClose };

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      if (sessionId.current) void api('/api/github/auth/cancel', { id: sessionId.current }).catch(() => {});
    };
  }, []);

  async function attach() {
    if (submitting.current) return;
    submitting.current = true;
    setAttaching(true);
    setError('');
    try {
      await callbacks.current.onConnect();
      if (active.current) callbacks.current.onClose();
    } catch (failure) {
      if (active.current) setError((failure as Error).message);
    } finally {
      submitting.current = false;
      if (active.current) setAttaching(false);
    }
  }

  useEffect(() => {
    if (!session?.id) return;
    const id = session.id;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const result = await api<AuthSession>('/api/github/auth/status', { id });
        if (cancelled || !active.current) return;
        setSession(result);
        if (result.status === 'complete') {
          sessionId.current = null;
          await attach();
        } else if (pending(result)) {
          timer = setTimeout(poll, 1500);
        } else {
          sessionId.current = null;
          setError(result.error || 'GitHub sign-in was cancelled. Try again.');
        }
      } catch (failure) {
        if (!cancelled && active.current) {
          setError((failure as Error).message);
          setSession(previous => ({ ...previous, status: 'error' }));
          void api('/api/github/auth/cancel', { id }).catch(() => {});
        }
      }
    }
    timer = setTimeout(poll, 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [session?.id]);

  async function startSignIn() {
    if (starting || submitting.current || pending(session)) return;
    setStarting(true);
    setError('');
    setCopied(false);
    try {
      const result = await api<AuthSession>('/api/github/auth/start', {});
      if (!active.current) {
        if (result.id) void api('/api/github/auth/cancel', { id: result.id }).catch(() => {});
        return;
      }
      sessionId.current = result.id;
      setSession(result);
      if (result.error) setError(result.error);
    } catch (failure) {
      if (active.current) setError((failure as Error).message);
    } finally {
      if (active.current) setStarting(false);
    }
  }

  // The code arrives by polling, so GitHub opens from an explicit link once the code is visible.
  useEffect(() => { if (session?.userCode) openGitHub.current?.focus(); }, [session?.userCode]);

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(session!.userCode!);
      if (active.current) setCopied(true);
    } catch {
      if (active.current) setError('Select the code and copy it manually.');
    }
  }

  const waiting = starting || pending(session);
  const existingAccount = session?.status === 'complete' ? session.account?.login : connection?.authenticated ? connection.account?.login : null;
  return <Dialog open onOpenChange={open => { if (!open && !submitting.current) onClose(); }}>
    <DialogContent aria-describedby={undefined} showCloseButton={!attaching} className="max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain sm:max-w-md" onInteractOutside={event => event.preventDefault()} onCloseAutoFocus={event => {
      event.preventDefault();
      restoreFocus([focusTarget()]);
    }}>
      <DialogHeader><DialogTitle className="flex items-center gap-3"><img src="/assets/providers/github.svg" className="provider-logo" data-monochrome="true" width={24} height={24} alt="" />Connect GitHub</DialogTitle></DialogHeader>
      {checking ? <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><LoaderCircle className="size-4 motion-safe:animate-spin" />Checking GitHub…</p> : waiting ? <div className="grid gap-4">
        {session?.userCode && <div className="grid gap-2">
          <Label htmlFor="github-device-code">Enter this code on GitHub</Label>
          <div className="flex gap-2">
            <Input id="github-device-code" readOnly value={session.userCode} onFocus={event => event.target.select()} className="text-center font-mono text-lg tracking-widest" />
            <Button type="button" variant="outline" size="icon" aria-label={copied ? 'Code copied' : 'Copy code'} onClick={copyCode}>{copied ? <Check /> : <Copy />}</Button>
          </div>
        </div>}
        {session?.userCode && <Button asChild><a ref={openGitHub} href={DEVICE_URL} target="_blank" rel="noopener noreferrer" onClick={() => void copyCode()}>Copy code and open GitHub<ExternalLink /></a></Button>}
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><LoaderCircle className="size-4 motion-safe:animate-spin" />{session?.userCode ? 'Waiting for GitHub…' : 'Preparing sign-in…'}</p>
      </div> : <div className="grid gap-3">
        {existingAccount && <Button type="button" disabled={attaching} onClick={attach}>{attaching && <LoaderCircle className="motion-safe:animate-spin" />}Continue as {existingAccount}</Button>}
        {session?.status === 'complete' && !existingAccount && <Button type="button" disabled={attaching} onClick={attach}>{attaching && <LoaderCircle className="motion-safe:animate-spin" />}Finish connection</Button>}
        <Button type="button" variant={existingAccount ? 'outline' : 'default'} disabled={attaching} onClick={startSignIn}>Sign in with GitHub</Button>
      </div>}
      {error && <p className="text-sm text-destructive [overflow-wrap:anywhere]" role="alert">{error}</p>}
      <DialogFooter><Button type="button" variant="ghost" disabled={attaching} onClick={onClose}>Cancel</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
