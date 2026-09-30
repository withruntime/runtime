import type { DevboxSnapshotView } from "./snapshots.js";
import type { DevboxView } from "./index.js";
/** Runloop's cursor pages support both awaited pages and unawaited iteration. */
export class CursorPage<T extends { id: string }> implements AsyncIterable<T> {
  constructor(
    readonly data: T[],
    readonly has_more: boolean,
    readonly total_count: number,
    private readonly fetchNext: (after: string) => Promise<CursorPage<T>>,
  ) {}
  getPaginatedItems(): T[] {
    return this.data;
  }
  hasNextPage(): boolean {
    return this.has_more && this.data.length > 0;
  }
  nextPageInfo(): { params: { starting_after: string } } | null {
    const last = this.data.at(-1);
    return last ? { params: { starting_after: last.id } } : null;
  }
  nextPageParams(): { starting_after: string } | null {
    return this.nextPageInfo()?.params ?? null;
  }
  getNextPage(): Promise<CursorPage<T>> {
    const next = this.nextPageInfo();
    if (!next)
      return Promise.reject(
        new Error(
          "No next page expected; please check `.hasNextPage()` before calling `.getNextPage()`.",
        ),
      );
    return this.fetchNext(next.params.starting_after);
  }
  async *iterPages(): AsyncGenerator<CursorPage<T>> {
    yield this;
    if (!this.hasNextPage()) return;
    let page = await this.getNextPage();
    yield page;
    while (page.hasNextPage()) {
      page = await page.getNextPage();
      yield page;
    }
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for await (const page of this.iterPages()) yield* page.getPaginatedItems();
  }
}
export class DevboxSnapshotViewsDiskSnapshotsCursorIDPage<
  T extends { id: string } = DevboxSnapshotView,
> extends CursorPage<T> {
  get snapshots(): T[] {
    return this.data;
  }
  override getNextPage(): Promise<DevboxSnapshotViewsDiskSnapshotsCursorIDPage<T>> {
    return super.getNextPage() as Promise<DevboxSnapshotViewsDiskSnapshotsCursorIDPage<T>>;
  }
  override async *iterPages(): AsyncGenerator<DevboxSnapshotViewsDiskSnapshotsCursorIDPage<T>> {
    for await (const page of super.iterPages())
      yield page as DevboxSnapshotViewsDiskSnapshotsCursorIDPage<T>;
  }
}
export class DevboxViewsCursorIDPage<T extends { id: string } = DevboxView> extends CursorPage<T> {
  get devboxes(): T[] {
    return this.data;
  }
  override getNextPage(): Promise<DevboxViewsCursorIDPage<T>> {
    return super.getNextPage() as Promise<DevboxViewsCursorIDPage<T>>;
  }
  override async *iterPages(): AsyncGenerator<DevboxViewsCursorIDPage<T>> {
    for await (const page of super.iterPages()) yield page as DevboxViewsCursorIDPage<T>;
  }
}
export class PagePromise<T extends { id: string }, P extends CursorPage<T>>
  extends Promise<P>
  implements AsyncIterable<T>
{
  static get [Symbol.species]() {
    return Promise;
  }
  constructor(promise: Promise<P>) {
    super((resolve, reject) => promise.then(resolve, reject));
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    yield* await this;
  }
}
