import {test} from 'node:test';
import assert from 'node:assert/strict';
import {syncPool,syncFacebookPage,SYNC_CONCURRENCY,SYNC_WORK_MS} from '../api/marketing/facebook/_sync.ts';
import {createAdminClient} from '../api/_lib/supabase.ts';
import {facebookMediaId} from '../api/marketing/facebook/_publishing.ts';

const pause=()=>new Promise(resolve=>setTimeout(resolve,2));
const connection={id:'connection',page_id:'page'};
const posts=count=>Array.from({length:count},(_,i)=>({id:'page_'+i,message:'Message '+i,created_time:'2026-10-31T08:00:00Z',attachments:{data:[]}}));
const response=(body,status=200)=>({ok:status<400,status,json:async()=>body});
function database(existing=[],{saveError,cached=[]}={}) {
  const writes=[],updates=[],lookups=[];
  const db={writes,updates,lookups,from(table){
    let values;
    const q={
      select(){return q},in(key,ids){lookups.push({key,ids});return q},eq(){return q},
      update(value){values=value;return q},
      async maybeSingle(){updates.push(values);return {data:{id:'connection'},error:null}},
      then(resolve,reject){if(values)updates.push(values);return Promise.resolve({data:existing,error:null}).then(resolve,reject)},
    };assert.ok(['posts','provider_connections'].includes(table));return q;
  },storage:{from(){return {
    getPublicUrl:path=>({data:{publicUrl:'https://storage.example/marketing-media/'+path}}),
    list:async()=>({data:cached,error:null}),upload:async()=>({error:null}),
  }}},async rpc(name,args){
    assert.equal(name,'sync_facebook_post');writes.push(args);
    if(saveError)return {error:{code:saveError,message:'private token detail'}};
    return {data:args.p_values.provider_ids.facebook,error:null};
  }};
  return db;
}

test('three workers overlap but never exceed the cap, including a partial final group',async()=>{
  let active=0,peak=0;const ids=[];
  const result=await syncPool([0,1,2,3,4,5,6],async id=>{active++;peak=Math.max(peak,active);ids.push(id);await pause();active--;return id},new AbortController().signal);
  assert.equal(peak,SYNC_CONCURRENCY);assert.equal(active,0);assert.deepEqual(result.results,[0,1,2,3,4,5,6]);assert.deepEqual(ids,[0,1,2,3,4,5,6]);assert.equal(result.errors.length,0);
});
test('a failure stops queued work and waits for every in-flight worker before returning',async()=>{
  const releases=[],starts=[];let settled=false;
  const pending=syncPool([0,1,2,3,4],id=>{starts.push(id);return new Promise((resolve,reject)=>{releases[id]={resolve,reject}})},new AbortController().signal).then(value=>{settled=true;return value});
  assert.deepEqual(starts,[0,1,2]);releases[0].reject(new Error('save failed'));await pause();assert.equal(settled,false);
  releases[1].resolve(1);releases[2].resolve(2);const result=await pending;
  assert.deepEqual(starts,[0,1,2]);assert.deepEqual(result.results,[1,2]);assert.equal(result.errors.length,1);
});
test('100-post sync uses one existing-row lookup, three concurrent Graph requests and no redundant attachment requests',async()=>{
  const old=globalThis.fetch;let active=0,peak=0;const calls=[];
  globalThis.fetch=async(url,options)=>{
    assert.ok(options.signal instanceof AbortSignal);calls.push(url);active++;peak=Math.max(peak,active);await pause();active--;
    if(url.includes('/published_posts?'))return response({data:posts(100)});
    if(url.includes('/me?'))return response({followers_count:42});
    assert.ok(url.includes('/insights?'));return response({data:[{values:[{value:7}]}]});
  };
  try{
    const db=database(),result=await syncFacebookPage(db,'user',connection,'private-token',new AbortController().signal);
    assert.equal(result.status,'synced');assert.equal(result.processed,100);assert.equal(result.items,100);assert.equal(result.remaining,0);
    assert.equal(peak,3);assert.equal(active,0);assert.equal(calls.length,302);assert.equal(db.lookups.length,1);assert.equal(db.lookups[0].ids.length,100);
    assert.equal(db.writes.length,100);assert.ok(db.writes.every(write=>write.p_actor==='user'&&write.p_values.views===7));
    assert.ok(result.syncedAt);assert.equal(db.updates.filter(update=>update.last_synced_at).length,1);
  }finally{globalThis.fetch=old}
});
test('insight fallback preserves zero values and unavailable counters keep the previous good values',async()=>{
  const old=globalThis.fetch, metrics=[];
  globalThis.fetch=async url=>{
    if(url.includes('/published_posts?'))return response({data:posts(1)});
    if(url.includes('/me?'))return response({});
    const metric=new URL(url).searchParams.get('metric');metrics.push(metric);
    if(metric==='post_impressions')return response({data:[{values:[{value:0}]}]});
    return response({error:{message:'private-token should never appear'}},400);
  };
  try{
    const db=database([{id:'local',provider_ids:{facebook:'page_0'},media:[],views:90,impressions:80,reach:12,clicks:3}]);
    const result=await syncFacebookPage(db,'user',connection,'private-token',new AbortController().signal);
    assert.equal(result.status,'synced');assert.equal(result.items,0);assert.equal(result.metricsUnavailable,4);
    assert.deepEqual(metrics,['post_media_view','post_impressions','post_total_media_view_unique','post_impressions_unique','post_clicks']);
    assert.equal(db.writes[0].p_values.views,0);assert.equal(db.writes[0].p_values.impressions,0);
    assert.equal(db.writes[0].p_values.reach,12);assert.equal(db.writes[0].p_values.clicks,3);
    assert.equal(result.metricsErrors.length,3);assert.doesNotMatch(JSON.stringify(result),/private-token/);
  }finally{globalThis.fetch=old}
});
test('deadline abort returns an honest partial result without stamping a successful refresh',async()=>{
  const old=globalThis.fetch,controller=new AbortController();let insights=0;
  globalThis.fetch=async url=>{
    if(url.includes('/published_posts?'))return response({data:posts(10)});
    if(url.includes('/me?'))return response({});
    insights++;controller.abort(new DOMException('Budget expired','TimeoutError'));throw controller.signal.reason;
  };
  try{
    const db=database(),result=await syncFacebookPage(db,'user',connection,'token',controller.signal);
    assert.equal(result.status,'partial');assert.equal(result.processed,0);assert.equal(result.remaining,10);
    assert.equal(result.syncedAt,undefined);assert.equal(db.writes.length,0);assert.equal(db.updates.length,0);assert.ok(insights<=3);
    assert.equal(SYNC_WORK_MS,240_000);
  }finally{globalThis.fetch=old}
});
for(const kind of ['http','graph']) test(kind+' rate limits halt new work and do not advance the last-success timestamp',async()=>{
  const old=globalThis.fetch;let insights=0;
  globalThis.fetch=async url=>{
    if(url.includes('/published_posts?'))return response({data:posts(20)});
    if(url.includes('/me?'))return response({});
    insights++;return kind==='http'?{status:429,ok:false,json:async()=>{throw new Error('HTML throttling response')}}:response({error:{code:4,message:'private-token'}},400);
  };
  try{
    const db=database(),result=await syncFacebookPage(db,'user',connection,'private-token',new AbortController().signal);
    assert.equal(result.status,'partial');assert.equal(result.remaining,20);assert.ok(insights<=3);assert.equal(db.writes.length,0);
    assert.match(result.detail,/Wait/);assert.equal(result.syncedAt,undefined);assert.doesNotMatch(JSON.stringify(result),/private-token/);
  }finally{globalThis.fetch=old}
});
test('previously unattempted and older posts are processed before recently refreshed posts',async()=>{
  const old=globalThis.fetch,order=[];
  globalThis.fetch=async url=>{
    if(url.includes('/published_posts?'))return response({data:posts(4)});
    if(url.includes('/me?'))return response({});
    const u=new URL(url);if(u.searchParams.get('metric')==='post_media_view')order.push(u.pathname.split('/').at(-2));
    await pause();return response({data:[{values:[{value:1}]}]});
  };
  try{
    const db=database([0,1,2].map(i=>({id:'local'+i,provider_ids:{facebook:'page_'+i},media:[],metrics_refreshed_at:i===2?null:i===1?'2020-01-01':'2026-10-31'})));
    await syncFacebookPage(db,'user',connection,'token',new AbortController().signal);
    assert.deepEqual(order,['page_2','page_3','page_1','page_0']);
  }finally{globalThis.fetch=old}
});
test('complete single-image attachments reuse durable media without the attachment fallback request',async()=>{
  const old=globalThis.fetch,url='https://scontent.fbcdn.net/photo?signature=temporary',calls=[];
  globalThis.fetch=async endpoint=>{
    calls.push(endpoint);
    if(endpoint.includes('/published_posts?'))return response({data:[{...posts(1)[0],full_picture:url,attachments:{data:[{media:{image:{src:url}}}]}}]});
    if(endpoint.includes('/me?'))return response({});
    assert.ok(endpoint.includes('/insights?'));return response({data:[{values:[{value:1}]}]});
  };
  try{
    const db=database([],{cached:[{name:facebookMediaId('page_0',url)+'.jpg'}]});
    await syncFacebookPage(db,'user',connection,'token',new AbortController().signal);
    assert.equal(calls.length,5);assert.equal(db.writes[0].p_values.media.length,1);
    assert.match(db.writes[0].p_values.media[0].url,/storage.example/);
  }finally{globalThis.fetch=old}
});
test('failed database saves retain their actionable error and never stamp sync completion',async()=>{
  const old=globalThis.fetch;
  globalThis.fetch=async url=>response(url.includes('/published_posts?')?{data:posts(6)}:url.includes('/me?')?{}:{data:[{values:[{value:1}]}]});
  try{
    const db=database([],{saveError:'PGRST202'});
    await assert.rejects(syncFacebookPage(db,'user',connection,'token',new AbortController().signal),error=>error.status===503 && /GitHub migration/.test(error.message));
    assert.ok(db.writes.length<=3);assert.equal(db.updates.length,0);
  }finally{globalThis.fetch=old}
});
test('bounded admin clients propagate run cancellation to database and storage fetches',async()=>{
  const old=globalThis.fetch,run=new AbortController(),request=new AbortController();let received;
  globalThis.fetch=async(_input,init)=>{received=init.signal;return response({})};
  try{
    const options=createAdminClient({url:'https://supabase.example',serviceRoleKey:'test'},(_url,_key,options)=>options,run.signal);
    await options.global.fetch('https://supabase.example/storage/v1/object',{signal:request.signal});
    assert.equal(received.aborted,false);run.abort();assert.equal(received.aborted,true);
  }finally{globalThis.fetch=old}
});

test('incomplete attachment data uses the fallback to retain all album images',async()=>{
  const old=globalThis.fetch,urls=['https://scontent.fbcdn.net/one','https://scontent.fbcdn.net/two'];let fallback=0;
  globalThis.fetch=async endpoint=>{
    if(endpoint.includes('/published_posts?'))return response({data:[{...posts(1)[0],full_picture:urls[0],attachments:{data:[{}]}}]});
    if(endpoint.includes('/me?'))return response({});
    if(endpoint.includes('/attachments?')){fallback++;return response({data:[{subattachments:{data:urls.map(src=>({media:{image:{src}}}))}}]})}
    assert.ok(endpoint.includes('/insights?'));return response({data:[{values:[{value:1}]}]});
  };
  try{
    const db=database([],{cached:urls.map(url=>({name:facebookMediaId('page_0',url)+'.jpg'}))});
    await syncFacebookPage(db,'user',connection,'token',new AbortController().signal);
    assert.equal(fallback,1);assert.equal(db.writes[0].p_values.media.length,2);
  }finally{globalThis.fetch=old}
});
