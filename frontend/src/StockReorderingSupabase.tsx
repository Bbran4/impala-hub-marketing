import RecordPagination from './RecordPagination'
import {useRecordPage,useDebouncedSearch} from './useRecordPage'
import {useCallback,useState} from 'react'
import {PackageSearch,RefreshCw,Search} from 'lucide-react'
import {supabase} from './supabase'
import {
  loadStockReorderingWorkspace,type ReorderingPage,type MoverFilter,
  type ReorderingSort,type StockReorderingItem,type SupplyFilter,
} from './stockReorderingData'

type Props={token:string;setNotice:(message:string)=>void;setError:(message:string)=>void}
const PAGE_SIZE=200
const money=(value:number|null)=>value==null?'—':`R${Number(value).toFixed(2)}`
const number=(value:number)=>Number(value).toLocaleString(undefined,{maximumFractionDigits:4})

export default function StockReorderingSupabase({setError}:Props){
  const [search,setSearch]=useState('');const [supplierType,setSupplierType]=useState('')
  const [moverFilter,setMoverFilter]=useState<MoverFilter>('all');const [supplyFilter,setSupplyFilter]=useState<SupplyFilter>(null)
  const [sort,setSort]=useState<ReorderingSort>({key:'part_number',direction:'asc'})
  const debouncedSearch=useDebouncedSearch(search)
  const load=useCallback((offset:number)=>{
    if(!supabase)return Promise.reject(new Error('Supabase is not configured.'))
    return loadStockReorderingWorkspace(supabase,{search:debouncedSearch,supplierType,mover:moverFilter,supply:supplyFilter,sort:sort.key,direction:sort.direction},offset)
  },[debouncedSearch,supplierType,moverFilter,supplyFilter,sort.key,sort.direction])
  const records=useRecordPage<StockReorderingItem,ReorderingPage>(load,PAGE_SIZE,true,setError)
  const visible=records.items;const busy=records.loading
  const slowMax=Number(records.data?.settings?.slow_max_avg_sales??2),abMin=Number(records.data?.settings?.ab_min_avg_sales??10)
  const snapshot=records.data?.activeSnapshot
  const header=(label:string,key:keyof StockReorderingItem)=><th data-sort={key} onClick={()=>setSort(current=>current.key===key?{key,direction:current.direction==='asc'?'desc':'asc'}:{key,direction:'asc'})}>{label}{sort.key===key?(sort.direction==='asc'?' ↑':' ↓'):''}</th>
  return <section className="rfq-workspace">
    <div className="sd-session-bar"><PackageSearch size={18}/><span>Smart Stock Control workspace</span><div className="sd-view-tabs"><button className="active">Stock Reordering</button></div>{snapshot&&<small>{snapshot.source_name} · activated {new Date(snapshot.activated_at).toLocaleString()}</small>}</div>
    {records.data&&!snapshot&&<div className="stock-import-validation invalid"><b>No active stock snapshot is available. Import and activate Booking and Reordering data first.</b></div>}
    <div className="rfq-toolbar buyouts-toolbar"><label className="rfq-search"><Search size={15}/>Search<input placeholder="Search part number, description, supplier, or alt number" value={search} onChange={event=>setSearch(event.target.value)}/></label><label>Supplier type<select value={supplierType} onChange={event=>setSupplierType(event.target.value)}><option value="">All suppliers</option><option value="local">Local suppliers</option><option value="international">International suppliers</option></select></label><div className="stock-mover-actions"><span>Shared avg sales thresholds</span><button className={moverFilter==='ab'?'secondary active':'secondary'} onClick={()=>setMoverFilter(moverFilter==='ab'?'all':'ab')}>A&amp;B Movers ≥ {number(abMin)}</button><button className={moverFilter==='slow'?'secondary active':'secondary'} onClick={()=>setMoverFilter(moverFilter==='slow'?'all':'slow')}>Slow Movers ≤ {number(slowMax)}</button></div><div className="stock-mover-actions"><span>Supply %</span><button className={supplyFilter===25?'secondary active':'secondary'} onClick={()=>setSupplyFilter(supplyFilter===25?null:25)}>25% or less</button><button className={supplyFilter===50?'secondary active':'secondary'} onClick={()=>setSupplyFilter(supplyFilter===50?null:50)}>50% or less</button></div><button className="secondary" disabled={busy} onClick={()=>records.refresh()}><RefreshCw size={15}/>{busy?'Loading…':'Refresh'}</button></div>
    <RecordPagination page={records.page} size={PAGE_SIZE} total={records.total} loading={records.loading} onPage={records.setPage} />
    <div className="rfq-table-wrap"><table className="rfq-table stock-reordering-table"><thead><tr>{header('Franchise','franchise')}{header('Part Number','part_number')}{header('Description','description')}<th>Alt 1</th><th>Alt 2</th><th>Alt 3</th><th>Alt 4</th>{header('QOH ER','qoh_er')}{header('Safety ER','safety_er')}{header('QOH PTA','qoh_pta')}{header('Safety PTA','safety_pta')}{header('QOH WH','qoh_wh')}{header('Safety WH','safety_wh')}{header('Global Safety','global_safety')}{header('Supply %','supply_percentage')}{header('Qty on Order','qty_on_order')}{header('Qty to Order','qty_to_order')}{header('Lead Time','lead_time')}{header('Avg Sales','avg_sales')}{header('Sales this month','sales_this_month')}{header('Gauge','gauge')}{header('Supplier','supplier')}{header('Last cost','last_cost')}</tr></thead><tbody>{visible.map(item=><tr className="rfq-data-row" key={item.id}><td>{item.franchise||'—'}</td><td>{item.part_number}</td><td>{item.description}</td><td>{item.alt_1||'—'}</td><td>{item.alt_2||'—'}</td><td>{item.alt_3||'—'}</td><td>{item.alt_4||'—'}</td><td>{number(item.qoh_er)}</td><td>{number(item.safety_er)}</td><td>{number(item.qoh_pta)}</td><td>{number(item.safety_pta)}</td><td>{number(item.qoh_wh)}</td><td>{number(item.safety_wh)}</td><td>{number(item.global_safety)}</td><td>{Number(item.supply_percentage).toFixed(1)}%</td><td>{number(item.qty_on_order)}</td><td>{number(item.qty_to_order)}</td><td>{item.lead_time||'—'}</td><td>{number(item.avg_sales)}</td><td>{number(item.sales_this_month)}</td><td>{item.gauge||'—'}</td><td>{item.supplier||'—'}</td><td>{money(item.last_cost)}</td></tr>)}{!visible.length&&<tr><td colSpan={23}><div className="rfq-empty"><PackageSearch size={28}/><h3>No reordering records</h3><p>{snapshot?'Adjust the filters or import refreshed stock data.':'Import and activate stock data to populate this workspace.'}</p></div></td></tr>}</tbody></table></div>
  </section>
}
