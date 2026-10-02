import type { Page } from "../page.js";
import { guard } from "./errors.js";

/* Blaxel's paginated list over a Runtime page: the first page's `data` and
   `meta`, `nextPage()`, `autoPagingEach`, `autoPagingToArray`, and `for await`
   over every item. */

export type PaginatedListMeta = {
  hasMore?: boolean;
  nextCursor?: string;
  total?: number;
  totalIsPartial?: boolean;
};
export type CursorPaginationQuery = { cursor?: string };
export type AutoPagingEachCallback<T> = (item: T) => boolean | void | Promise<boolean | void>;
export type AutoPagingToArrayOptions = { limit: number };
export type ListResponse<T> =
  T[] | { data?: T[] | null; meta?: PaginatedListMeta | null } | null | undefined;

export type PaginatedList<
  T,
  TQuery extends CursorPaginationQuery = CursorPaginationQuery,
> = AsyncIterable<T> & {
  data: T[];
  meta: PaginatedListMeta;
  hasMore: boolean;
  nextCursor?: string;
  nextPage(): Promise<PaginatedList<T, TQuery> | null>;
  autoPagingEach(onItem: AutoPagingEachCallback<T>): Promise<void>;
  autoPagingToArray(options: AutoPagingToArrayOptions): Promise<T[]>;
};

/** Blaxel's own helper: the items of a list answer in any of its shapes. */
export function unwrapListData<T>(response: ListResponse<T>): T[] {
  if (!response) return [];
  if (Array.isArray(response)) return response;
  return response.data ?? [];
}

/** Blaxel's own helper, for a list fetched by `fetchPage`. */
export async function createPaginatedList<TRaw, TItem, TQuery extends CursorPaginationQuery>({
  response,
  fetchPage,
  mapItem,
  query,
  seenCursors,
}: {
  response: ListResponse<TRaw>;
  fetchPage: (query?: TQuery) => Promise<ListResponse<TRaw>>;
  mapItem: (item: TRaw) => TItem | Promise<TItem>;
  query?: TQuery;
  seenCursors?: Set<string>;
}): Promise<PaginatedList<TItem, TQuery>> {
  const meta =
    !response || Array.isArray(response)
      ? { hasMore: false }
      : (response.meta ?? { hasMore: false });
  const data = await Promise.all(unwrapListData(response).map(mapItem));
  const cursors = new Set(seenCursors);
  if (query?.cursor) cursors.add(query.cursor);
  return build(
    data,
    meta.nextCursor || undefined,
    async (cursor) => {
      if (cursors.has(cursor)) throw new Error("Pagination returned a repeated cursor");
      const nextQuery = { ...(query ?? ({} as TQuery)), cursor };
      const nextSeenCursors = new Set(cursors);
      nextSeenCursors.add(cursor);
      return createPaginatedList({
        response: await fetchPage(nextQuery),
        fetchPage,
        mapItem,
        query: nextQuery,
        seenCursors: nextSeenCursors,
      });
    },
    meta,
  );
}

/** A Runtime page, each item mapped, as Blaxel's paginated list. */
export function paginate<TRaw, TItem>(
  page: Page<TRaw>,
  map: (item: TRaw) => TItem,
  seenCursors = new Set<string>(),
): PaginatedList<TItem> {
  return build(page.data.map(map), page.nextCursor ?? undefined, async (cursor) => {
    if (cursor && seenCursors.has(cursor)) throw new Error("Pagination returned a repeated cursor");
    const nextSeenCursors = new Set(seenCursors);
    if (cursor) nextSeenCursors.add(cursor);
    const next = await guard(() => page.next(cursor));
    return next ? paginate(next, map, nextSeenCursors) : null;
  });
}

function build<T>(
  data: T[],
  nextCursor: string | undefined,
  more: (cursor: string) => Promise<PaginatedList<T> | null>,
  meta: PaginatedListMeta = {
    hasMore: nextCursor !== undefined,
    ...(nextCursor ? { nextCursor } : {}),
  },
): PaginatedList<T> {
  const list: PaginatedList<T> = {
    data,
    meta,
    get hasMore() {
      return Boolean(list.nextCursor);
    },
    get nextCursor() {
      return meta.nextCursor || undefined;
    },
    nextPage: async () => {
      const cursor = list.nextCursor;
      return cursor ? more(cursor) : null;
    },
    async autoPagingEach(onItem) {
      for await (const item of list) if ((await onItem(item)) === false) return;
    },
    async autoPagingToArray(options) {
      if (!options || !Number.isFinite(options.limit) || options.limit <= 0)
        throw new Error("autoPagingToArray requires a positive limit");
      const items: T[] = [];
      for await (const item of list) {
        items.push(item);
        if (items.length >= options.limit) break;
      }
      return items;
    },
    async *[Symbol.asyncIterator]() {
      let current: PaginatedList<T> | null = list;
      while (current) {
        yield* current.data;
        current = await current.nextPage();
      }
    },
  };
  return list;
}
