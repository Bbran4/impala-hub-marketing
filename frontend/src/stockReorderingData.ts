import type {RecordPage} from './recordPaging'
import type {SupabaseClient} from '@supabase/supabase-js'
import type {StockSettings} from './stockConfigurationData.ts'

export type StockReorderingItem={
  id:string;import_batch_id:string;franchise:string;part_number:string;description:string
  alt_1:string;alt_2:string;alt_3:string;alt_4:string
  qoh_er:number;safety_er:number;qoh_pta:number;safety_pta:number;qoh_wh:number;safety_wh:number
  global_safety:number;qty_on_order:number;qty_to_order:number;lead_time:string;avg_sales:number
  sales_this_month:number;gauge:string;supplier:string;last_cost:number|null;supplier_type:string
  source_name:string;snapshot_activated_at:string;slow_max_avg_sales:number;ab_min_avg_sales:number
  supply_percentage:number;is_slow_mover:boolean;is_ab_mover:boolean
}
export type MoverFilter='all'|'slow'|'ab'
export type SupplyFilter=25|50|null
export type ReorderingSort={key:keyof StockReorderingItem;direction:'asc'|'desc'}

export type ReorderingFilters={search?:string;supplierType?:string;mover?:MoverFilter;supply?:SupplyFilter;sort?:keyof StockReorderingItem;direction?:'asc'|'desc'}
export type ReorderingPage=RecordPage<StockReorderingItem>&{settings:StockSettings;activeSnapshot:{id:string;source_name:string;activated_at:string}|null}
export async function loadStockReorderingWorkspace(client:SupabaseClient,filters:ReorderingFilters={},offset=0):Promise<ReorderingPage> {
  const result=await client.rpc('stock_reordering_page',{p_filters:filters,p_limit:200,p_offset:offset})
  if(result.error)throw new Error(result.error.message)
  return result.data as ReorderingPage
}

export function matchesStockReordering(item:StockReorderingItem,filters:{search:string;supplierType:string;mover:MoverFilter;supply:SupplyFilter}) {
  const needle=filters.search.trim().toLowerCase()
  const searchable=[item.part_number,item.description,item.supplier,item.alt_1,item.alt_2,item.alt_3,item.alt_4].join(' ').toLowerCase()
  return (!needle||searchable.includes(needle))
    &&(!filters.supplierType||item.supplier_type.toLowerCase()===filters.supplierType.toLowerCase())
    &&(filters.mover==='all'||(filters.mover==='slow'?item.is_slow_mover:item.is_ab_mover))
    &&(filters.supply===null||Number(item.supply_percentage)<=filters.supply)
}

export function sortStockReordering(items:StockReorderingItem[],sort:ReorderingSort) {
  return [...items].sort((left,right)=>{
    const a=left[sort.key];const b=right[sort.key]
    let result:number
    if(typeof a==='number'&&typeof b==='number')result=a-b
    else result=String(a??'').localeCompare(String(b??''),undefined,{numeric:true,sensitivity:'base'})
    if(result===0)result=left.part_number.localeCompare(right.part_number,undefined,{numeric:true,sensitivity:'base'})
    return sort.direction==='asc'?result:-result
  })
}

export function filterAndSortStockReordering(items:StockReorderingItem[],filters:{search:string;supplierType:string;mover:MoverFilter;supply:SupplyFilter},sort:ReorderingSort) {
  return sortStockReordering(items.filter(item=>matchesStockReordering(item,filters)),sort)
}

