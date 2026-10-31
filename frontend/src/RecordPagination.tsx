export default function RecordPagination({
  page,
  size,
  total,
  loading,
  onPage,
}: {
  page: number;
  size: number;
  total: number;
  loading: boolean;
  onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / size));
  return (
    <div
      className="stock-results-bar"
      aria-label="Record pages"
      aria-busy={loading}
    >
      <span>
        {loading
          ? "Loading…"
          : `${total ? page * size + 1 : 0}–${Math.min((page + 1) * size, total)} of ${total.toLocaleString()} records`}
      </span>
      <div className="stock-pagination">
        <button
          className="secondary"
          disabled={loading || page === 0}
          onClick={() => onPage(page - 1)}
        >
          Previous
        </button>
        <span>
          Page {page + 1} of {pages}
        </span>
        <button
          className="secondary"
          disabled={loading || page + 1 >= pages}
          onClick={() => onPage(page + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}
