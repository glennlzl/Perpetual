import type { ReactNode } from 'react';
import { LoaderCircle } from 'lucide-react';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { restoreFocus } from '@/lib/journey-focus';
import './connector-dialog.css';

export default function DisconnectConnectorDialog({ open, provider, account, mark, busy, error, onOpenChange, onConfirm, focusTargets }: {
  open: boolean;
  provider: string;
  account?: string;
  mark: ReactNode;
  busy: boolean;
  error: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  focusTargets: () => (HTMLElement | null)[];
}) {
  return <AlertDialog open={open} onOpenChange={next => { if (!busy) onOpenChange(next); }}>
    <AlertDialogContent className="connector-account-dialog disconnect-connector-dialog" aria-busy={busy} onCloseAutoFocus={event => { event.preventDefault(); restoreFocus(focusTargets()); }}>
      <div className="flex items-center gap-4">
        <div className="shrink-0" aria-hidden="true">{mark}</div>
        <AlertDialogHeader className="min-w-0 flex-1">
          <AlertDialogTitle>Disconnect {provider}?</AlertDialogTitle>
          <AlertDialogDescription className="max-w-full [overflow-wrap:anywhere]">{account || 'Remove this connection from Perpetual.'}</AlertDialogDescription>
        </AlertDialogHeader>
      </div>
      {error && <p role="alert" className="text-sm text-destructive [overflow-wrap:anywhere]">{error}</p>}
      <AlertDialogFooter>
        <AlertDialogCancel variant="ghost" disabled={busy}>Cancel</AlertDialogCancel>
        <AlertDialogAction variant="destructive" disabled={busy} onClick={event => { event.preventDefault(); onConfirm(); }}>
          {busy && <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" />}{busy ? 'Disconnecting…' : 'Disconnect'}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
