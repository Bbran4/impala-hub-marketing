import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { claimPost, publishClaimed, facebookMediaId, publishingBudget } from '../api/marketing/facebook/_publishing.ts'
import { facebookPostMedia, validateImageFile, validateImageCount, MAX_POST_IMAGES } from '../src/facebookPostMedia.ts'

test('media identity is stable across syncs and expiring URL signatures', () => {
  assert.equal(facebookMediaId('post','https://cdn/image?token=old'),facebookMediaId('post','https://cdn/image?token=new'))
  assert.notEqual(facebookMediaId('post','https://cdn/image'),facebookMediaId('post','https://cdn/other'))
})

const key = crypto.randomBytes(32)
const iv = crypto.randomBytes(12)
const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
const encrypted = Buffer.concat([cipher.update('token'), cipher.final()])
const connection = { page_id: 'page', token_ciphertext: [iv, cipher.getAuthTag(), encrypted].map(x => x.toString('base64')).join('.') }
const secret = key.toString('base64')
const post = { id: 'one', status: 'draft', provider_ids: {}, caption: 'Hello', media: [] }

function database(initial = post, failReceipt = false) {
  const row = structuredClone(initial)
  return { row, from() {
    let values, filters = []
    const q = {
      update(v) { values = v; return q }, eq(k,v) { filters.push(() => row[k] === v); return q },
      in(k,v) { filters.push(() => v.includes(row[k])); return q },
      is(k,v) { filters.push(() => k === 'provider_ids->>facebook' ? (row.provider_ids.facebook ?? null) === v : row[k] === v); return q },
      lte(k,v) { filters.push(() => row[k] <= v); return q }, select() { return q },
      async maybeSingle() {
        if (failReceipt && values.status === 'published') return { error: new Error('database unavailable') }
        if (!filters.every(f => f())) return { data: null }
        Object.assign(row, values); return { data: structuredClone(row) }
      },
    }; return q
  } }
}

test('simultaneous manual/cron claims admit exactly one publisher; published posts cannot be reclaimed', async () => {
  const db = database()
  const claims = await Promise.all([claimPost(db,'one',['draft']),claimPost(db,'one',['draft'])])
  assert.equal(claims.filter(Boolean).length,1)
  db.row.status='published'; assert.equal(await claimPost(db,'one',['draft','failed']),null)
  db.row.status='failed'; db.row.provider_ids.facebook='already-live'
  assert.equal(await claimPost(db,'one',['failed']),null)
})

test('confirmed publish stores canonical photo post id and a bounded HTTP signal', async () => {
  const oldFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => { assert.match(url,/\/photos$/); assert.ok(options.signal instanceof AbortSignal); assert.equal(JSON.parse(options.body).url,'https://storage/image.jpg'); return { ok:true, json:async()=>({id:'photo',post_id:'page_post'}) } }
  try {
    const db=database({...post,status:'publishing',media:[{url:'https://storage/image.jpg'}]})
    assert.equal((await publishClaimed(db,db.row,connection,secret)).facebook_post_id,'page_post')
    assert.equal(db.row.status,'published')
  } finally { globalThis.fetch=oldFetch }
})

for (const failure of ['timeout','receipt','rejection']) test(`publication handles ${failure} without unsafe retries`, async () => {
  const oldFetch=globalThis.fetch
  globalThis.fetch=async()=> {
    if(failure==='timeout') throw new Error('timeout')
    return failure==='rejection' ? {ok:false,status:400,json:async()=>({error:{message:'rejected'}})} : {ok:true,json:async()=>({id:'page_post'})}
  }
  try {
    const db=database({...post,status:'publishing'},failure==='receipt')
    const result=await publishClaimed(db,db.row,connection,secret)
    assert.equal(result.status,failure==='rejection'?'failed':'publish_unknown')
    if(result.status==='publish_unknown') assert.equal(await claimPost(db,'one',['failed','draft']),null)
  } finally { globalThis.fetch=oldFetch }
})

const images = Array.from({length: 3}, (_,i) => ({url: `https://storage.example/${i}.jpg`, content_type:'image/jpeg',size:100}));

test('multi-photo publishing stages every image in order and publishes exactly one combined story', async () => {
  const original=globalThis.fetch, calls=[];
  globalThis.fetch=async(url,options)=>{
    const body=JSON.parse(options.body); calls.push({url,body});
    assert.ok(options.signal instanceof AbortSignal);
    return {ok:true,json:async()=>({id: calls.length<=3 ? `photo-${calls.length}` : 'page_combined'})};
  };
  try {
    const db=database({...post,status:'publishing',media:images,provider_ids:{instagram:'keep'}});
    assert.equal((await publishClaimed(db,db.row,connection,secret)).facebook_post_id,'page_combined');
    assert.equal(calls.length,4);
    for (let i=0;i<3;i++) {
      assert.match(calls[i].url,/\/page\/photos$/);
      assert.equal(calls[i].body.published,false);
      assert.equal(calls[i].body.temporary,true);
      assert.equal(calls[i].body.url,images[i].url);
      assert.equal(calls[i].body.message,undefined);
    }
    assert.match(calls[3].url,/\/page\/feed$/);
    assert.deepEqual(calls[3].body.attached_media,[1,2,3].map(i=>({media_fbid:`photo-${i}`})));
    assert.equal(calls[3].body.message,'Hello');
    assert.equal(db.row.provider_ids.instagram,'keep');
    assert.equal(db.row.status,'published');
  }finally{globalThis.fetch=original;}
});

for(const failure of ['timeout','rejection','invalid-json','missing-id']) test(`staging ${failure} never creates a public story and can safely be retried`,async()=>{
  const original=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,options)=>{
    calls.push({url,body:JSON.parse(options.body)});
    if(calls.length===1)return {ok:true,json:async()=>({id:'first-photo'})};
    if(failure==='timeout')throw new Error('sensitive provider token');
    return {ok:failure!=='rejection',status:400,json:async()=>{
      if(failure==='invalid-json')throw new Error('sensitive provider body');
      return failure==='missing-id'?{}:{error:{message:'sensitive'}};
    }};
  };
  try{
    const db=database({...post,status:'publishing',media:images});
    const outcome=await publishClaimed(db,db.row,connection,secret);
    assert.equal(outcome.status,'failed'); assert.match(outcome.detail,/image 2.*No post was published/);
    assert.doesNotMatch(outcome.detail,/sensitive/);
    assert.equal(calls.length,2); assert.ok(calls.every(c=>c.body.published===false));
    assert.ok(await claimPost(db,'one',['failed']));
  }finally{globalThis.fetch=original;}
});

for(const failure of ['timeout','receipt','malformed','rejection']) test(`multi-photo final ${failure} preserves ambiguous publication protection`,async()=>{
  const original=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,options)=>{
    calls.push({url,body:JSON.parse(options.body)});
    if(calls.length<=images.length)return {ok:true,json:async()=>({id:`photo-${calls.length}`})};
    if(failure==='timeout')throw new Error('timeout');
    return {ok:failure!=='rejection',status:failure==='rejection'?400:200,json:async()=>failure==='malformed'?{}:failure==='rejection'?{error:{message:'rejected'}}:{id:'page_combined'}};
  };
  try{
    const db=database({...post,status:'publishing',media:images},failure==='receipt');
    const outcome=await publishClaimed(db,db.row,connection,secret);
    assert.equal(outcome.status,failure==='rejection'?'failed':'publish_unknown');
    assert.equal(calls.length,4); // No automatic final retry or destructive photo cleanup.
    if(outcome.status==='publish_unknown')assert.equal(await claimPost(db,'one',['failed','draft']),null);
  }finally{globalThis.fetch=original;}
});

test('media validation rejects invalid batches before any provider request',async()=>{
  const original=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;throw new Error('must not run')};
  try{
    for(const media of [{},[...images,{url:'http://insecure/image'}],Array(11).fill(images[0]),[{url:'https://storage/image',content_type:'video/mp4'}],[{url:'https://storage/image',size:16*1024*1024}]]){
      const db=database({...post,status:'publishing',media});
      assert.equal((await publishClaimed(db,db.row,connection,secret)).status,'failed');
    }
    assert.equal(calls,0);
    assert.equal(facebookPostMedia(Array(MAX_POST_IMAGES).fill(images[0])).length,MAX_POST_IMAGES);
    assert.throws(()=>facebookPostMedia([{url:'https://token:secret@storage/image'}]),/HTTPS/);
    assert.throws(()=>validateImageFile({type:'application/pdf',size:100}),/JPG/);
    assert.throws(()=>validateImageFile({type:'image/jpeg',size:0}),/15 MB/);
    assert.throws(()=>validateImageCount(11),/10 images/);
    validateImageFile({type:'image/png',size:15*1024*1024});
  }finally{globalThis.fetch=original;}
});

test('multi-photo budget reserves time for each request and the receipt; budget exhaustion cannot dispatch a story',async()=>{
  assert.equal(publishingBudget([]),30_000);
  assert.equal(publishingBudget(images),90_000);
  assert.equal(publishingBudget(Array(10).fill(images[0])),230_000);
  const originalFetch=globalThis.fetch,originalNow=Date.now;let now=1_000,calls=0;
  Date.now=()=>now;
  globalThis.fetch=async()=>{calls++;now+=20_000;return {ok:true,json:async()=>({id:'staged'})}};
  try{
    const db=database({...post,status:'publishing',media:images});
    const outcome=await publishClaimed(db,db.row,connection,secret,60_000);
    assert.equal(outcome.status,'failed');assert.equal(calls,2);
    assert.match(outcome.detail,/No post was published/);
  }finally{globalThis.fetch=originalFetch;Date.now=originalNow;}
});
