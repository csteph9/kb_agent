import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { State } from '../ingest/state.js';
import { validateSource } from '../ingest/config.js';
import { runSource, normalize } from '../ingest/runner.js';
import { loadConnector } from '../ingest/registry.js';
import { parseFeed } from '../connectors/rss/connector.js';
import { parseCalendar } from '../connectors/calendar/connector.js';
import { isPublicIp, validatePublicUrl } from '../ingest/http.js';
import { buildPrompt } from '../ingest/knowledge-writer.js';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-test-'));
  const state = new State(dir);
  t.after(() => { state.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return state;
}
const source = (extra = {}) => validateSource({ id: 'test', connector: 'rss', enabled: true, ...extra });
const item = (id = '1', revision = 'v1') => ({ externalId: id, revision, kind: 'article', content: { text: 'A durable fact' } });

test('durable pages deduplicate independently for each account', t => {
  const state = setup(t), s = source();
  state.enqueuePage(s, [item()], 'page2');
  state.enqueuePage(s, [item()], 'page2');
  assert.equal(state.pending('test', 10).length, 1);
  assert.equal(JSON.parse(state.source('test').cursor), 'page2');
  assert.equal(state.has('another-account', '1', 'v1'), false);
  state.done(state.pending('test', 1)[0].id);
  assert.equal(state.db.prepare('SELECT payload FROM jobs').get().payload, null);
  assert.equal(state.has('test', '1', 'v1'), true);
});

test('cursor is rolled back if queue persistence fails', t => {
  const state = setup(t), s = source();
  assert.throws(() => state.enqueuePage(s, [item(), {externalId:'broken'}], 'unsafe-cursor'));
  assert.equal(state.source(s.id).cursor, null);
  assert.equal(state.pending(s.id,10).length, 0);
});

test('changed content and later reversion both become new jobs', t => {
  const state = setup(t), s = source();
  for (const revision of ['a','b','a']) {
    assert.equal(state.has(s.id,'1',revision), false);
    state.enqueuePage(s,[item('1',revision)],null);
    state.done(state.pending(s.id,1)[0].id);
  }
  assert.equal(state.db.prepare('SELECT COUNT(*) n FROM jobs').get().n,3);
});

test('new revision supersedes stale failed work', t => {
  const state = setup(t), s = source();
  state.enqueuePage(s,[item()],null);
  const old=state.pending(s.id,1)[0];
  state.fail(old);
  state.enqueuePage(s,[item('1','v2')],null);
  assert.equal(state.pending(s.id,10).length,1);
  assert.throws(()=>state.retry(old.id));
});

test('legacy Gmail IDs survive migration and remain source scoped', t => {
  const state=setup(t);
  state.importLegacy('gmail-one',['x','x']);
  assert.equal(state.has('gmail-one','x','x'),true);
  assert.equal(state.has('gmail-two','x','x'),false);
});

test('retry backoff, terminal failure and manual retry', t => {
  const state=setup(t), s=source();
  state.enqueuePage(s,[item()],null);
  const id=state.pending(s.id,1)[0].id;
  for(let n=0;n<5;n++) state.fail(state.db.prepare('SELECT * FROM jobs WHERE id=?').get(id));
  assert.equal(state.status().failures[0].status,'failed');
  assert.equal(state.pending(s.id,10).length,0);
  assert.equal(state.retry(id),s.id);
  assert.equal(state.pending(s.id,1)[0].attempts,0);
});

test('expired raw input is removed and can be explicitly refetched', t => {
  const state=setup(t), s=source();
  state.enqueuePage(s,[item()],null);
  state.db.prepare('UPDATE jobs SET created=?').run(Date.now()-8*86400000);
  state.prune();
  assert.equal(state.db.prepare('SELECT payload FROM jobs').get().payload,null);
  state.refetch(s.id);
  assert.equal(state.has(s.id,'1','v1'),false);
});

test('runner continues past pages of already processed items', async t => {
  const state=setup(t), s=source({ingestion:{maxItemsPerRun:1,maxPagesPerRun:3}});
  let calls=0,writes=0;
  const ok=await runSource(s,state,{
    load:async()=>({fetchPage:async({cursor})=>{
      calls++; return cursor===null ? {items:[],cursor:'next'} : {items:[item()],cursor:null};
    }}),
    write:async()=>{writes++;return {syncPending:false};}
  });
  assert.equal(ok,true); assert.equal(calls,2); assert.equal(writes,1);
});

test('committed but unpushed items are acknowledged and never extracted twice',async t=>{
  const state=setup(t), s=source();
  let writes=0;
  const options={load:async()=>({fetchPage:async()=>({items:[item()],cursor:null})}),
    write:async()=>{writes++;return {syncPending:true};}};
  await runSource(s,state,options);
  await runSource(s,state,options);
  assert.equal(writes,1);
  assert.equal(state.status().syncPending,1);
});

test('failed extraction leaves durable retry work; processing pending work returns success',async t=>{
  const state=setup(t),s=source({ingestion:{maxItemsPerRun:1}});
  assert.equal(await runSource(s,state,{
    load:async()=>({fetchPage:async()=>({items:[item()],cursor:null})}),
    write:async()=>{throw new Error('mock failure');}
  }),false);
  const job=state.status().failures[0];
  state.retry(job.id);
  assert.equal(await runSource(s,state,{write:async()=>({syncPending:false})}),true);
  assert.equal(state.pending(s.id,1).length,0);
});

test('invalid configuration and oversized items fail before extraction',async()=>{
  assert.throws(()=>source({id:'../escape'}));
  assert.throws(()=>source({ingestion:{maxItemsPerRun:0}}));
  const s=source({ingestion:{maxItemChars:10}});
  assert.throws(()=>normalize(s,item()));
  await assert.rejects(()=>loadConnector(source({config:{}})),/configuration/);
});

test('RSS and Atom parsing preserves stable identity and changed revisions',()=>{
  const rss=title=>'<rss><channel><item><guid>abc</guid><title>'+title+'</title><description><![CDATA[<p>Useful content</p>]]></description></item></channel></rss>';
  const a=parseFeed(rss('One'))[0], b=parseFeed(rss('Two'))[0];
  assert.equal(a.externalId,'abc'); assert.notEqual(a.revision,b.revision);
  assert.equal(a.content.text,'Useful content');
  const atom=parseFeed('<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>x</id><title>T</title><link href="https://example.org/x"/><summary>S</summary></entry></feed>')[0];
  assert.equal(atom.sourceUrl,'https://example.org/x');
  assert.throws(()=>parseFeed('<!DOCTYPE rss><rss/>'));
});

test('calendar retains recurrence, timezone, cancellations and exception identity',()=>{
  const ics=['BEGIN:VCALENDAR','VERSION:2.0','BEGIN:VEVENT','UID:test','DTSTART;TZID=America/Los_Angeles:20260905T090000',
    'RRULE:FREQ=WEEKLY;COUNT=3','EXDATE;TZID=America/Los_Angeles:20260912T090000','SUMMARY:Practice','END:VEVENT',
    'BEGIN:VEVENT','UID:test','RECURRENCE-ID;TZID=America/Los_Angeles:20260919T090000','DTSTART;TZID=America/Los_Angeles:20260919T090000',
    'STATUS:CANCELLED','END:VEVENT','END:VCALENDAR'].join('\r\n');
  const events=parseCalendar(ics);
  assert.equal(events.length,2);
  assert.notEqual(events[0].externalId,events[1].externalId);
  const raw=JSON.stringify(events);
  assert.match(raw,/America\/Los_Angeles/); assert.match(raw,/rrule/); assert.match(raw,/exdate/); assert.match(raw,/CANCELLED/);
});

test('public HTTP validation rejects local, mapped, reserved and mixed DNS addresses',async()=>{
  for(const ip of ['127.0.0.1','10.1.2.3','169.254.169.254','::1','::ffff:127.0.0.1','fc00::1','100.64.0.1','192.0.2.1']) assert.equal(isPublicIp(ip),false,ip);
  assert.equal(isPublicIp('8.8.8.8'),true);
  await assert.rejects(()=>validatePublicUrl('https://example.org',async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]));
  const r=await validatePublicUrl('https://example.org',async()=>[{address:'8.8.8.8',family:4}]);
  assert.equal(r.address.address,'8.8.8.8');
  await assert.rejects(()=>validatePublicUrl('https://user:pass@example.org'));
});

test('shared prompts retain external trust boundary and source context',()=>{
  const prompt=buildPrompt(source({owner:'your_user_name',ingestion:{profile:'calendar'}}),item());
  assert.match(prompt,/untrusted evidence/);
  assert.match(prompt,/your_user_name/);
  assert.match(prompt,/recurrence/);
  assert.match(prompt,/AGENTS.md/);
});