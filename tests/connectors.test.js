
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dns from 'node:dns/promises';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fetchResource } from '../ingest/http.js';
import { createConnector } from '../connectors/gmail/connector.js';
import { validateSource } from '../ingest/config.js';
import { State } from '../ingest/state.js';

test('redirect is validated before any private destination is contacted', async t => {
  let requests=0;
  t.mock.method(dns,'lookup',async host=>[{address:host==='public.example'?'8.8.8.8':'127.0.0.1',family:4}]);
  t.mock.method(https,'get',(_url,options,callback)=>{
    requests++;
    const request=new EventEmitter();
    request.destroy=error=>request.emit('error',error);
    queueMicrotask(()=>{
      const response=new PassThrough();
      response.statusCode=302;
      response.headers={location:'https://private.example/secret'};
      callback(response);
      request.emit('close');
    });
    options.lookup('public.example',{},(_error,address)=>assert.equal(address,'8.8.8.8'));
    return request;
  });
  await assert.rejects(()=>fetchResource('https://public.example/start'),/Non-public/);
  assert.equal(requests,1);
});

test('HTTP body deadline remains active until body completes', async t => {
  t.mock.method(dns,'lookup',async()=>[{address:'8.8.8.8',family:4}]);
  t.mock.method(https,'get',(_url,_options,callback)=>{
    const request=new EventEmitter();
    request.destroy=error=>{request.emit('error',error);request.emit('close');};
    queueMicrotask(()=>{
      const response=new PassThrough();
      response.statusCode=200; response.headers={};
      callback(response); // Never finish the body.
    });
    return request;
  });
  await assert.rejects(()=>fetchResource('https://public.example',{timeoutMs:20}),/timed out/);
});

test('Gmail paginates known IDs without downloading their bodies',async()=>{
  let downloads=0;
  const pages=[];
  const connector=await createConnector(validateSource({id:'mail',connector:'gmail',enabled:true}),{
    gmailClient:{users:{messages:{
      list:async args=>{pages.push(args);return {data:{messages:[{id:'seen'}],nextPageToken:'next'}};},
      get:async()=>{downloads++;throw new Error('Should not download');}
    }}}
  });
  const page=await connector.fetchPage({cursor:'previous',limit:3,has:()=>true});
  assert.equal(downloads,0);assert.equal(page.cursor,'next');
  assert.equal(pages[0].pageToken,'previous');assert.equal(pages[0].maxResults,3);
});

test('Gmail attachment failures remain retryable and financial senders are filtered',async()=>{
  let fail=true;
  const message={id:'a',payload:{headers:[{name:'From',value:'Person <person@example.org>'},{name:'Subject',value:'Appointment'}],
    parts:[{mimeType:'text/plain',body:{data:Buffer.from('See attached').toString('base64url')}},
      {filename:'details.txt',mimeType:'text/plain',body:{attachmentId:'att',size:10}}]}};
  const api={users:{messages:{
    list:async()=>({data:{messages:[{id:'a'}]}}),
    get:async()=>({data:message}),
    attachments:{get:async()=>{if(fail)throw new Error('Temporary API failure');return {data:{data:Buffer.from('Meeting tomorrow').toString('base64url')}};}}
  }}};
  const connector=await createConnector(validateSource({id:'mail',connector:'gmail',enabled:true}),{gmailClient:api});
  const request={cursor:null,limit:1,has:()=>false};
  await assert.rejects(()=>connector.fetchPage(request),/Temporary/);
  fail=false;
  const result=await connector.fetchPage(request);
  assert.equal(result.items[0].attachments[0].text,'Meeting tomorrow');
  message.payload.headers[0].value='Chase Bank <mail@example.org>';
  const filtered=await connector.fetchPage(request);
  assert.equal(filtered.items[0].skipReason,'financial-sender');
  assert.equal(filtered.items[0].content.text,'');
});

test('migration preserves OAuth files and imports existing processed IDs exactly once',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ingest-migration-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const gmail=path.join(dir,'gmail');
  fs.mkdirSync(gmail);
  fs.writeFileSync(path.join(gmail,'state.json'),JSON.stringify({processedIds:['one','two']}));
  fs.writeFileSync(path.join(gmail,'token.json'),'existing-oauth-token-fixture');
  const env={...process.env,KNOWLEDGE_INGEST_LOCKED:'1',KNOWLEDGE_ENV_FILE:path.join(dir,'absent.env'),
    INGEST_STATE_DIR:path.join(dir,'state'),INGEST_SOURCE_DIR:path.join(dir,'sources'),
    GMAIL_STATE_DIR:gmail,GMAIL_ENABLED:'true',GMAIL_QUERY:'newer_than:30d'};
  const args=['ingest/cli.js','migrate-gmail'];
  const first=spawnSync(process.execPath,args,{env,encoding:'utf8'});
  assert.equal(first.status,0,first.stderr);
  const source=JSON.parse(fs.readFileSync(path.join(dir,'sources/personal-gmail.json')));
  assert.equal(source.enabled,true);assert.equal(source.config.query,'newer_than:30d');
  const state=new State(path.join(dir,'state'));
  try {assert.equal(state.has('personal-gmail','one','one'),true);} finally {state.close();}
  const second=spawnSync(process.execPath,args,{env,encoding:'utf8'});
  assert.equal(second.status,1);
  assert.equal(fs.readFileSync(path.join(gmail,'token.json'),'utf8'),'existing-oauth-token-fixture');
});