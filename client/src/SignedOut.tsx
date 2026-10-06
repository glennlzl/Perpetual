import { useState, type FormEvent } from 'react';
import { KeyRound, LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { connectLaunchLink } from '@/lib/api';

export default function SignedOut() {
  const [link, setLink] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const connect = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try { await connectLaunchLink(link); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  };
  return <main className="delivery-app items-center justify-center bg-background">
    <form onSubmit={connect} className="flex w-full max-w-sm flex-col gap-6 p-6">
      <div className="flex flex-col items-center gap-3"><KeyRound size={28} className="text-muted-foreground" /><h1 className="text-xl font-semibold">Connect to Perpetual</h1></div>
      <p className="text-sm text-muted-foreground">Start Perpetual to open your browser, or paste the launch link from its terminal.</p>
      <div className="flex flex-col gap-2"><Label htmlFor="launch-link">Launch link</Label><Input id="launch-link" type="password" autoComplete="off" spellCheck={false} value={link} disabled={busy} aria-invalid={Boolean(error)} onChange={event => { setLink(event.target.value); setError(''); }} /></div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button type="submit" disabled={busy || !link.trim()}>{busy && <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" />}Connect</Button>
    </form>
  </main>;
}
