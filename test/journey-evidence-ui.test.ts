import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { chromium, expect } from '@playwright/test';
import { createUiServer } from './fixtures/ui-server.ts';
import type { BrowserCase, JourneyResult } from '../contract/browser.ts';

test('the existing Evidence disclosure shows rejected transports in Chromium', { timeout: 30000 }, async t => {
  const item: BrowserCase = { id:'rename',name:'Rename workspace',goal:'Keep the renamed workspace',steps:[],preconditions:[],expectedOutcomes:[],assertions:[],selected:true,needsReview:false,isolation:'shared',evidence:[] };
  const result: JourneyResult = { caseId:item.id,status:'failed',controlRead:false,controlReadReason:'blocked-after-read',assertions:[],controlBlocks:[{kind:'http',method:'POST',url:'https://app.test/read',afterRead:true},{kind:'socket',transport:'websocket',afterRead:true}] };
  const entry=`import React from 'react';import {createRoot} from 'react-dom/client';import JourneyEvidence from '/src/JourneyEvidence.tsx';import {Collapsible,CollapsibleTrigger,CollapsibleContent} from '/src/components/ui/collapsible.tsx';import {Button} from '/src/components/ui/button.tsx';import '/src/index.css';createRoot(document.getElementById('root')).render(React.createElement(Collapsible,{},React.createElement(CollapsibleTrigger,{asChild:true},React.createElement(Button,{},'Evidence')),React.createElement(CollapsibleContent,{},React.createElement(JourneyEvidence,{item:${JSON.stringify(item)},result:${JSON.stringify(result)},progress:null}))));`;
  const server=await createUiServer(t,{configFile:fileURLToPath(new URL('../vite.config.ts',import.meta.url)),logLevel:'error',server:{host:'127.0.0.1',port:0},plugins:[{
    name:'control-evidence-ui',resolveId(id){if(id.endsWith('/__evidence.tsx'))return '\0evidence.tsx';},load(id){if(id==='\0evidence.tsx')return entry;},
    configureServer(server){server.middlewares.use(async(req,res,next)=>{if(req.url!=='/build/__evidence')return next();res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml('/__evidence','<div id="root"></div><script type="module" src="/build/__evidence.tsx"></script>'));});}
  }]});
  await server.listen();const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:320,height:800}});
  await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}/build/__evidence`);
  await expect(page.getByRole('heading',{name:'Blocked communication'})).toHaveCount(0);
  await page.getByRole('button',{name:'Evidence',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Blocked communication'})).toBeVisible({timeout:1500});
  await expect(page.getByText('https://app.test/read',{exact:true})).toBeVisible();
  await expect(page.getByText('POST',{exact:true})).toBeVisible();await expect(page.getByText('WebSocket',{exact:true})).toBeVisible();
  await expect(page.getByText('After read',{exact:true})).toHaveCount(2);
});
