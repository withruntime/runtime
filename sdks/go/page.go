package withruntime

import (
	"context"
	"iter"
	"net/http"
	"net/url"
	"strconv"
)

// Page is one page of a list. Next fetches the one after it.
type Page[T any] struct {
	Data       []T
	NextCursor *string
	next       func(ctx context.Context, cursor string) (*Page[T], error)
}

// HasMore reports whether another page follows.
func (p *Page[T]) HasMore() bool { return p.NextCursor != nil && *p.NextCursor != "" }

// Next fetches the following page, or returns nil when there is none.
func (p *Page[T]) Next(ctx context.Context) (*Page[T], error) {
	if !p.HasMore() {
		return nil, nil
	}
	return p.next(ctx, *p.NextCursor)
}

// All walks every item on this page and every page after it.
func (p *Page[T]) All(ctx context.Context) iter.Seq2[T, error] {
	return func(yield func(T, error) bool) {
		for page := p; page != nil; {
			for _, item := range page.Data {
				if !yield(item, nil) {
					return
				}
			}
			next, err := page.Next(ctx)
			if err != nil {
				var zero T
				yield(zero, err)
				return
			}
			page = next
		}
	}
}

// listPage reads one {data, nextCursor} page of path, and wires Next to read
// the one after it with the same query.
func listPage[T any](ctx context.Context, c *Client, path string, query url.Values, cursor string) (*Page[T], error) {
	q := url.Values{}
	for key, values := range query {
		q[key] = values
	}
	if cursor != "" {
		q.Set("cursor", cursor)
	}
	var body struct {
		Data       []T     `json:"data"`
		NextCursor *string `json:"nextCursor"`
	}
	if err := c.do(ctx, &call{method: http.MethodGet, path: path, query: q}, &body); err != nil {
		return nil, err
	}
	return &Page[T]{
		Data:       body.Data,
		NextCursor: body.NextCursor,
		next: func(ctx context.Context, next string) (*Page[T], error) {
			return listPage[T](ctx, c, path, query, next)
		},
	}, nil
}

// walk is All over a first page that may fail.
func walk[T any](ctx context.Context, first func() (*Page[T], error)) iter.Seq2[T, error] {
	return func(yield func(T, error) bool) {
		page, err := first()
		if err != nil {
			var zero T
			yield(zero, err)
			return
		}
		for item, err := range page.All(ctx) {
			if !yield(item, err) {
				return
			}
		}
	}
}

// setQuery puts the non-empty values in q.
func setQuery(q url.Values, pairs ...string) url.Values {
	for i := 0; i+1 < len(pairs); i += 2 {
		if pairs[i+1] != "" {
			q.Set(pairs[i], pairs[i+1])
		}
	}
	return q
}

func itoa(n int) string {
	if n == 0 {
		return ""
	}
	return strconv.Itoa(n)
}
