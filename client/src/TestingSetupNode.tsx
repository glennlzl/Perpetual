import { useState } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { LoaderCircle, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardFooter, CardHeader } from '@/components/ui/card';

export const TESTING_SETUP_ID = 'testing-setup';
export type TestingSetupFlowNode = Node<{ compact: boolean; busy: boolean; onSetup: () => Promise<void> }, 'testing-setup'>;
const HANDLE_STYLE = { top: 30 };

// An invitation, not a configured stage: no status, gate or runtime until the
// person explicitly creates the stage. Deletion receipts quiet repeat onboarding.
export default function TestingSetupNode({ data }: NodeProps<TestingSetupFlowNode>) {
  const [pending, setPending] = useState(false);
  const setup = async () => {
    if (pending || data.busy) return;
    setPending(true);
    try { await data.onSetup(); } finally { setPending(false); }
  };
  const action = <Button className="nodrag nopan" variant={data.compact ? 'outline' : 'default'} disabled={data.busy || pending} onClick={setup}>
    {pending ? <LoaderCircle className="motion-safe:animate-spin" /> : <Plus />}
    {pending ? 'Setting up…' : data.compact ? 'Add testing stage' : 'Set up testing'}
  </Button>;
  return <div className={`testing-setup${data.compact ? ' testing-setup-compact' : ''}`}>
    <Handle type="target" position={Position.Left} style={HANDLE_STYLE} isConnectable={false} />
    {data.compact ? action : <Card className="testing-setup-card">
      <CardHeader className="gap-2 px-5">
        <h3 className="text-lg font-semibold leading-[26px] tracking-[-.015em]">Integration tests</h3>
        <CardDescription className="text-sm leading-[22px]">Generate end-to-end tests for your app with AI.</CardDescription>
      </CardHeader>
      <CardFooter className="px-5">{action}</CardFooter>
    </Card>}
    <Handle type="source" position={Position.Right} style={HANDLE_STYLE} isConnectable={false} />
  </div>;
}
