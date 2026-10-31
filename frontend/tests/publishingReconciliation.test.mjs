import {test} from 'node:test';
import assert from 'node:assert/strict';
import {facebookPostReference, verifiedFacebookPost, verifyFacebookPublication, findFacebookPublications} from '../api/marketing/facebook/_reconciliation.ts';
import {canReviewPublication, canReturnPublicationToDraft} from '../src/publishingState.ts';
const start=Date.now()-1_200_000;
const context={pageId:'123',token:'test-token',caption:'Review this post',startedAt:new Date(start).toISOString()};
const candidate={id:'123_456',from:{id:'123'},message:context.caption,created_time:new Date(start+1000).toISOString()};
test('Facebook references accept connected Page IDs and numeric post links, never another host or Page',()=>{
  assert.equal(facebookPostReference('123_456','123'),'123_456');
  assert.equal(facebookPostReference('https://www.facebook.com/123/posts/456','123'),'123_456');
  assert.equal(facebookPostReference('https://www.facebook.com/permalink.php?story_fbid=456&id=123','123'),'123_456');
  for(const value of ['999_456','https://evil.example/123/posts/456','https://facebook.com.evil.example/123/posts/456','https://www.facebook.com/pfbidOpaque']) assert.throws(()=>facebookPostReference(value,'123'));
});
test('provider receipts must match Page, content and attempt time',()=>{
  assert.equal(verifiedFacebookPost(candidate,context).id,'123_456');
  for(const altered of [{from:{id:'999'}},{id:'999_456'},{message:'Different content'},{created_time:new Date(start-600_000).toISOString()},{created_time:'invalid'}]) assert.throws(()=>verifiedFacebookPost({...candidate,...altered},context));
});
test('provider verification is bounded and sanitizes errors; candidate finding cannot silently link a mismatch',async()=>{
  const fetcher=async(url,options)=>{assert.ok(options.signal instanceof AbortSignal);assert.match(url,/access_token=test-token/);return{ok:true,json:async()=>candidate};};
  assert.equal((await verifyFacebookPublication('123_456',context,fetcher)).permalink,'https://www.facebook.com/123_456');
  await assert.rejects(verifyFacebookPublication('123_456',context,async()=>{throw new Error('private test-token');}),error=>error.status===502&&!error.message.includes('test-token'));
  const result=await findFacebookPublications(context,async()=>({ok:true,json:async()=>({data:[candidate,{...candidate,id:'123_789',message:'unrelated'}],paging:{next:'more'}})}));
  assert.deepEqual(result.matches.map(item=>item.id),['123_456']);assert.equal(result.more,true);
});
test('live publishing cannot be interrupted and returning to draft always waits ten minutes',()=>{
  const post={status:'publishing',publish_started_at:new Date(start).toISOString(),provider_ids:{}};
  assert.equal(canReviewPublication(post,start+60_000),false);
  assert.equal(canReviewPublication({...post,status:'publish_unknown'},start+60_000),true);
  assert.equal(canReturnPublicationToDraft({...post,status:'publish_unknown'},start+60_000),false);
  assert.equal(canReturnPublicationToDraft(post,start+600_000),true);
  assert.equal(canReturnPublicationToDraft({...post,provider_ids:{facebook:'123_456'}},start+600_000),false);
});
