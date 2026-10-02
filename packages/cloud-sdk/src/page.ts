/** A list you can await for one page or iterate for every item. */
export class Page<T> implements AsyncIterable<T> {
  constructor(
    readonly data: T[],
    readonly nextCursor: string | null,
    private readonly fetchPage: (cursor: string) => Promise<Page<T>>,
  ) {}
  get hasMore(): boolean {
    return this.nextCursor !== null;
  }
  async next(cursor: string | null = this.nextCursor): Promise<Page<T> | null> {
    return cursor === null ? null : this.fetchPage(cursor);
  }
  /** Every page, fetched as you go. */
  async *pages(): AsyncGenerator<Page<T>> {
    yield this;
    let page = await this.next();
    while (page) {
      yield page;
      page = await page.next();
    }
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for await (const page of this.pages()) yield* page.data;
  }
  async toArray(limit = 10_000): Promise<T[]> {
    const all: T[] = [];
    for await (const item of this) {
      all.push(item);
      if (all.length >= limit) break;
    }
    return all;
  }
}
