import { useEffect, useState } from "react";
import type { RecordPage } from "./recordPaging";

export function useDebouncedSearch(value: string, delay = 300) {
  const [search, setSearch] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return search;
}
export function useRecordPage<T, P extends RecordPage<T>>(
  load: (offset: number) => Promise<P>,
  size: number,
  enabled: boolean,
  onError: (message: string) => void,
) {
  const [position, setPosition] = useState({ load, page: 0 });
  const page = position.load === load ? position.page : 0;
  const [response, setResponse] = useState<{
    load: typeof load;
    page: number;
    data: P;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setLoading(true);
    void load(page * size)
      .then((data) => {
        if (!active) return;
        if (data.total > 0 && page * size >= data.total) {
          setPosition({ load, page: Math.floor((data.total - 1) / size) });
          return;
        }
        if (data.total === 0 && page > 0) {
          setPosition({ load, page: 0 });
          return;
        }
        setResponse({ load, page, data });
      })
      .catch((error) => {
        if (active) {
          setResponse(null);
          onError(
            error instanceof Error ? error.message : "Could not load records.",
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [load, page, size, enabled, revision, onError]);
  const data =
    enabled && response?.load === load && response.page === page
      ? response.data
      : null;
  return {
    data,
    items: data?.items || [],
    total: data?.total || 0,
    page,
    loading,
    setPage: (next: number) => setPosition({ load, page: Math.max(0, next) }),
    refresh: () => setRevision((current) => current + 1),
  };
}
