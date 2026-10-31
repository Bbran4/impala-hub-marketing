import {test} from 'node:test';
import assert from 'node:assert/strict';
import {collectExportPages} from '../src/recordPaging.ts';
import {loadStockReorderingWorkspace} from '../src/stockReorderingData.ts';

test('explicit exports collect every filtered page, including the final partial page',async()=>{
  const rows=Array.from({length:1205},(_,id)=>({id:String(id)})),offsets=[];
  const result=await collectExportPages(async offset=>{offsets.push(offset);return {items:rows.slice(offset,offset+200),total:rows.length,limit:200,offset}});
  assert.equal(result.length,1205);assert.deepEqual(offsets,[0,200,400,600,800,1000,1200]);
});
test('exports reject incomplete or changing datasets instead of silently downloading a partial report',async()=>{
  await assert.rejects(collectExportPages(async offset=>({items:offset?[]:[{id:'one'}],total:2,limit:1,offset})),/all matching/);
  await assert.rejects(collectExportPages(async offset=>({items:[{id:'one'}],total:2,limit:1,offset})),/changed/);
  await assert.rejects(collectExportPages(async offset=>({items:[{id:String(offset)}],total:offset?3:2,limit:1,offset})),/changed/);
});
test('Reordering makes exactly one filtered page request including snapshot metadata',async()=>{
  const calls=[];
  const client={async rpc(name,args){calls.push([name,args]);return {data:{items:[{id:'one'}],total:3005,limit:200,offset:400,settings:{slow_max_avg_sales:2},activeSnapshot:{source_name:'stock.csv'}},error:null}}};
  const filters={search:'part',supplierType:'local',mover:'slow',supply:25,sort:'qty_to_order',direction:'desc'};
  const page=await loadStockReorderingWorkspace(client,filters,400);
  assert.equal(calls.length,1);assert.deepEqual(calls[0],['stock_reordering_page',{p_filters:filters,p_limit:200,p_offset:400}]);
  assert.equal(page.items.length,1);assert.equal(page.total,3005);assert.equal(page.activeSnapshot.source_name,'stock.csv');
});
