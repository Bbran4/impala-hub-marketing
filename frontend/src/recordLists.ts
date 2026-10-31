import type { SupabaseClient } from '@supabase/supabase-js'
import { loadAllRows } from './pagedRows.ts'

export function loadMarketingCampaigns(client: SupabaseClient) {
  return loadAllRows((from, to) => client.from('campaigns').select('*', { count: 'exact' })
    .order('updated_at', { ascending: false }).order('id').range(from, to))
}
