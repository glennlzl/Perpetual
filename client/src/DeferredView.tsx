import { Component, Suspense, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';

/** A deferred view can fail without replacing its navigation or enclosing Sheet. */
export default class DeferredView extends Component<{ children: ReactNode; fallback: (failed: boolean) => ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override render() {
    return this.state.failed ? this.props.fallback(true) : <Suspense fallback={this.props.fallback(false)}>{this.props.children}</Suspense>;
  }
}

export function ViewLoadState({ failed }: { failed: boolean }) {
  return failed ? <div className="space-y-3">
    <p role="alert" className="text-sm text-destructive">Could not load this view.</p>
    <Button variant="outline" onClick={() => window.location.reload()}>Reload</Button>
  </div> : <p role="status" className="text-sm text-muted-foreground">Loading…</p>;
}
