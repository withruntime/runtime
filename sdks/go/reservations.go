package withruntime

import (
	"context"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

// RoomBooking is room booked for a burst: Sandboxes of one size held for a
// window. Status is "confirmed", "declined" or "cancelled". A decline is a
// normal answer, not an error: Reason ("room", "share", "usage" or "credit"),
// Message, LargestSandboxes and NearestWindow say why and what would fit.
// Times are ISO 8601 strings; EstimateMicros and the Unused fields are
// microdollars as a string. Standing room (Standing) is held until it is
// cancelled: its EndsAt and UnusedMaxMicros are "" and its HeldUntil nil.
type RoomBooking struct {
	ID      string  `json:"id"`
	Status  string  `json:"status"`
	Reason  *string `json:"reason"`
	Message string  `json:"message"`
	Region  string  `json:"region"`

	// Standing is room held from when it was booked until it is cancelled.
	Standing bool `json:"standing"`
	// Snapshots are standing room's snapshots: it is held on the servers holding them.
	Snapshots []string `json:"snapshots"`
	// ForKey is room held for the key that booked it alone.
	ForKey bool `json:"forKey"`

	Sandboxes int `json:"sandboxes"`
	VCPU      int `json:"vcpu"`
	MemoryMiB int `json:"memoryMiB"`
	DiskMiB   int `json:"diskMiB"`

	StartsAt  string  `json:"startsAt"`
	EndsAt    string  `json:"endsAt"`
	HeldUntil *string `json:"heldUntil"`
	// Phase is "upcoming", "active" or "ended" while confirmed, else nil.
	Phase *string `json:"phase"`

	// LargestSandboxes is the most of this size the window could hold.
	LargestSandboxes int `json:"largestSandboxes"`
	// NearestWindow is a declined booking's nearest window that takes them all, or nil.
	NearestWindow *RoomWindow `json:"nearestWindow"`
	// EstimateMicros is the most it can cost: every sandbox running the whole window (any mix of running and unused costs less).
	EstimateMicros string `json:"estimateMicros"`
	// UnusedRateMicros is what booked room no sandbox of the account uses costs per GiB-hour of the booked sandboxes' memory, as quoted when booked ("0" before it had a price).
	UnusedRateMicros string `json:"unusedRateMicros"`
	// UnusedMaxMicros is the most it costs if none of its sandboxes run (nothing if cancelled at least an hour before it starts).
	UnusedMaxMicros string `json:"unusedMaxMicros"`
	// UnusedPerHourMicros is the most its unused room costs an hour.
	UnusedPerHourMicros string `json:"unusedPerHourMicros"`
	// UnusedChargedMicros is what its unused room has been charged so far.
	UnusedChargedMicros string  `json:"unusedChargedMicros"`
	InUse               int     `json:"inUse"`
	PeakInUse           int     `json:"peakInUse"`
	ReleasedPercent     int     `json:"releasedPercent"`
	CreatedAt           string  `json:"createdAt"`
	CancelledAt         *string `json:"cancelledAt"`
}

// RoomWindow is a start and an end.
type RoomWindow struct {
	StartsAt string `json:"startsAt"`
	EndsAt   string `json:"endsAt"`
}

// ReservationCreate books room. Sandboxes (1 to 10000), StartsAt (now, or
// within 14 days) and EndsAt (at most 24 hours later) are required; the rest
// default to a create's defaults (2 vCPU, 4096 MiB memory, 4096 MiB disk, the
// default region).
type ReservationCreate struct {
	Sandboxes      int
	StartsAt       time.Time
	EndsAt         time.Time
	Vcpu           int
	MemoryMiB      int
	DiskMiB        int
	Region         string
	IdempotencyKey string
}

// ReservationKeep keeps standing room from now until it is cancelled, for a
// pool that deletes a sandbox after each use and makes another. Sandboxes (1
// to 10000) is required; keep a few more than the pool runs, for deletes still
// finishing. Snapshots (at most 20, one size) hold it on the servers holding
// them, at their size; otherwise Vcpu, MemoryMiB and DiskMiB default to a
// create's. ForKey holds it for this key's sandboxes alone.
type ReservationKeep struct {
	Sandboxes      int
	Snapshots      []string
	ForKey         bool
	Vcpu           int
	MemoryMiB      int
	DiskMiB        int
	Region         string
	IdempotencyKey string
}

// ReservationUpdate changes standing room in place: how many it holds
// (Sandboxes, 0 to keep it), its snapshots (nil to keep them), or both.
type ReservationUpdate struct {
	Sandboxes      int
	Snapshots      []string
	IdempotencyKey string
}

// ListReservations pages bookings, newest first. Pass a page's NextCursor as Cursor.
type ListReservations struct {
	Limit  int
	Cursor string
}

// ReservationPage is one page of bookings.
type ReservationPage struct {
	Items      []RoomBooking `json:"items"`
	NextCursor *string       `json:"nextCursor"`
}

// ReservationService is client.Reservations: room booked for a burst. In the
// window, creates are never refused no_capacity or quota_exceeded up to what
// was booked; running sandboxes bill as usual and booked room none of them use
// costs a quarter of the memory rate.
type ReservationService struct{ c *Client }

func reservationPath(id string) string { return "/v1/reservations/" + url.PathEscape(id) }

// Create books room and answers at once. Check Status: a decline is not an error.
func (s *ReservationService) Create(ctx context.Context, opts ReservationCreate) (*RoomBooking, error) {
	body := map[string]any{
		"sandboxes": opts.Sandboxes,
		"startsAt":  opts.StartsAt.UTC().Format(time.RFC3339Nano),
		"endsAt":    opts.EndsAt.UTC().Format(time.RFC3339Nano),
	}
	if opts.Vcpu != 0 {
		body["vcpu"] = opts.Vcpu
	}
	if opts.MemoryMiB != 0 {
		body["memoryMiB"] = opts.MemoryMiB
	}
	if opts.DiskMiB != 0 {
		body["diskMiB"] = opts.DiskMiB
	}
	if opts.Region != "" {
		body["region"] = opts.Region
	}
	var booking RoomBooking
	return &booking, s.c.do(ctx, &call{method: http.MethodPost, path: "/v1/reservations", body: body, key: opts.IdempotencyKey}, &booking)
}

// Keep holds standing room until it is cancelled. Check Status: a decline is not an error.
func (s *ReservationService) Keep(ctx context.Context, opts ReservationKeep) (*RoomBooking, error) {
	body := map[string]any{"standing": true, "sandboxes": opts.Sandboxes}
	if len(opts.Snapshots) > 0 {
		body["snapshots"] = opts.Snapshots
	}
	if opts.ForKey {
		body["forKey"] = true
	}
	if opts.Vcpu != 0 {
		body["vcpu"] = opts.Vcpu
	}
	if opts.MemoryMiB != 0 {
		body["memoryMiB"] = opts.MemoryMiB
	}
	if opts.DiskMiB != 0 {
		body["diskMiB"] = opts.DiskMiB
	}
	if opts.Region != "" {
		body["region"] = opts.Region
	}
	var booking RoomBooking
	return &booking, s.c.do(ctx, &call{method: http.MethodPost, path: "/v1/reservations", body: body, key: opts.IdempotencyKey}, &booking)
}

// Update changes standing room in place. It moves or grows only when all of
// it fits now; otherwise it answers a no_capacity error and nothing changes.
func (s *ReservationService) Update(ctx context.Context, id string, opts ReservationUpdate) (*RoomBooking, error) {
	body := map[string]any{}
	if opts.Sandboxes != 0 {
		body["sandboxes"] = opts.Sandboxes
	}
	if opts.Snapshots != nil {
		body["snapshots"] = opts.Snapshots
	}
	var booking RoomBooking
	return &booking, s.c.do(ctx, &call{method: http.MethodPost, path: reservationPath(id) + ":update", body: body, key: opts.IdempotencyKey}, &booking)
}

// List returns a page of bookings, newest first.
func (s *ReservationService) List(ctx context.Context, opts ListReservations) (*ReservationPage, error) {
	query := url.Values{}
	if opts.Limit > 0 {
		query.Set("limit", strconv.Itoa(opts.Limit))
	}
	if opts.Cursor != "" {
		query.Set("cursor", opts.Cursor)
	}
	var page ReservationPage
	return &page, s.c.do(ctx, &call{method: http.MethodGet, path: "/v1/reservations", query: query}, &page)
}

// Get reads a booking.
func (s *ReservationService) Get(ctx context.Context, id string) (*RoomBooking, error) {
	var booking RoomBooking
	return &booking, s.c.do(ctx, &call{method: http.MethodGet, path: reservationPath(id)}, &booking)
}

// Cancel gives the room back. The booking comes back with Status "cancelled".
func (s *ReservationService) Cancel(ctx context.Context, id string) (*RoomBooking, error) {
	var booking RoomBooking
	return &booking, s.c.do(ctx, &call{method: http.MethodDelete, path: reservationPath(id)}, &booking)
}
