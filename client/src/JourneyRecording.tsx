import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { controllerFetch } from '@/lib/api';

// A recording plays from memory: the controller serves it only with the browser secret, which a media element's own
// request cannot carry.
function Recording({ src, name }: { src: string; name: string }) {
  const [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0), [media, setMedia] = useState('');
  const recovering = useRef(false), retryButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (failed && recovering.current) retryButton.current?.focus({ preventScroll: true }); }, [failed]);
  useEffect(() => {
    const request = new AbortController();
    let url = '';
    void controllerFetch(src, { signal: request.signal }).then(async response => {
      if (!response.ok) throw new Error('Recording unavailable.');
      const blob = await response.blob();
      if (request.signal.aborted) return;
      url = URL.createObjectURL(blob);
      setMedia(url);
    }).catch(() => { if (!request.signal.aborted) setFailed(true); });
    return () => { request.abort(); if (url) URL.revokeObjectURL(url); };
  }, [src, attempt]);
  return <>
    <video key={attempt} src={media || undefined} controls preload="metadata" playsInline hidden={failed} tabIndex={0} className="h-full w-full object-contain" aria-label={`${name} recording`}
      onError={() => setFailed(true)} onLoadedData={event => {
        if (recovering.current) { recovering.current = false; event.currentTarget.focus({ preventScroll: true }); }
      }} />
    {failed && <div className="absolute inset-0 flex flex-col items-center justify-center-safe gap-3 overflow-y-auto p-4 pt-16">
      <p role="alert" className="text-sm text-muted-foreground">Recording unavailable.</p>
      <Button ref={retryButton} type="button" variant="outline" onClick={() => { recovering.current = true; setMedia(''); setFailed(false); setAttempt(value => value + 1); }}>Retry recording</Button>
    </div>}
  </>;
}

// A finished journey's recordings, one per browser tab it opened, played with the browser's own controls.
export default function JourneyRecording({ urls, name = 'Journey', variant = 'full', className = '' }: { urls: string[]; name?: string; variant?: 'full' | 'focus'; className?: string }) {
  const [selected, setSelected] = useState('0');
  const tab = urls[Number(selected)] ? selected : '0', src = urls[Number(tab)];
  return <div role="group" aria-label={`${name} browser`} className={`journey-browser relative flex min-w-0 items-center justify-center overflow-hidden bg-background ${variant === 'focus' ? 'h-full w-full' : 'aspect-video border-y'} ${className}`}>
    {urls.length > 1 ? <Tabs value={tab} onValueChange={setSelected} className="absolute inset-0 gap-0">
      <div className="absolute top-2 right-2 left-2 z-10 min-w-0 overflow-x-auto overscroll-x-contain">
        <TabsList aria-label={`${name} recordings`}>{urls.map((url, index) => <TabsTrigger key={url} value={String(index)} className="text-xs">Tab {index + 1}</TabsTrigger>)}</TabsList>
      </div>
      {/* Each tab's recording is the panel that tab controls; its video, not the panel, takes focus after the tabs. */}
      {urls.map((url, index) => <TabsContent key={url} value={String(index)} tabIndex={-1} className="relative flex min-h-0 items-center justify-center"><Recording key={url} src={url} name={name} /></TabsContent>)}
    </Tabs> : <Recording key={src} src={src} name={name} />}
  </div>;
}
