import { TrackEvent } from '@/components/analytics/TrackEvent';
import { productListPayload } from '@/lib/analytics/items';

/**
 * `view_item_list` for the products a list page shows, and `search` when the
 * page is the results of a `?q=` — both known on the server by the page
 * rendering at all. The cards themselves carry `select_item` (`listId` on
 * `ProductCard`).
 */
export function ProductListTracking({
  listId,
  products,
  q,
  page,
}: {
  listId: string;
  products: readonly { slug: string; title: string; price: number }[];
  q?: string;
  page: number;
}) {
  return (
    <>
      {q ? <TrackEvent id="search" params={{ search_term: q }} dedupeKey={`${listId}:${q}`} /> : null}
      {products.length > 0 ? (
        <TrackEvent
          id="view_item_list"
          params={productListPayload(listId, products)}
          dedupeKey={`${listId}:${q ?? ''}:${page}:${products.map((p) => p.slug).join(',')}`}
        />
      ) : null}
    </>
  );
}
