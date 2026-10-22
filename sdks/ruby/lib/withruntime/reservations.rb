# frozen_string_literal: true

require "time"

module WithRuntime
  # +runtime.reservations+: book room for a burst. Holds room for +sandboxes+
  # sandboxes of one size for a window (up to 24 hours, starting within 14 days)
  # and answers at once, confirmed or declined. A decline is a normal answer
  # (+status+ is "declined"; +reason+, +message+, +largest_sandboxes+ and
  # +nearest_window+ say why and what would fit), not an error. In the window,
  # creates are never refused no_capacity or quota_exceeded up to what you
  # booked; running sandboxes are billed as usual and booked room none of your
  # sandboxes use costs a quarter of the memory rate. +estimate_micros+ (the most
  # it can cost: every sandbox running the whole window), +unused_rate_micros+
  # (unused room per GiB-hour of memory, as quoted when booked),
  # +unused_max_micros+ (the most it costs if none run) and
  # +unused_charged_micros+ (charged so far) are microdollars as a string.
  #
  #   booking = runtime.reservations.create(sandboxes: 500, starts_at: Time.now + 3600, ends_at: Time.now + 3 * 3600)
  #   booking.status # => "confirmed"
  #
  # Standing room (+keep+) is held from now until you cancel it, for a pool that
  # deletes a sandbox after each use and makes another: a replacement is never
  # refused up to it. With +snapshots+ it is held on the servers holding them,
  # at their size; +for_key+ keeps it for this key's sandboxes alone. Its
  # +ends_at+, +held_until+ and +unused_max_micros+ are nil;
  # +unused_per_hour_micros+ is the most its unused room costs an hour.
  #
  #   pool = runtime.reservations.keep(sandboxes: 40, snapshots: [snapshot_id], for_key: true)
  class Reservations < Product
    # +starts_at+ and +ends_at+ are a Time or an ISO 8601 string. +vcpu+,
    # +memory_mib+, +disk_mib+ and +region+ default to a create's defaults
    # (2 vCPU, 4096 MiB each, the default region).
    def create(sandboxes:, starts_at:, ends_at:, vcpu: nil, memory_mib: nil, disk_mib: nil, region: nil, idempotency_key: nil)
      body = Fields.body(sandboxes: sandboxes, starts_at: iso(starts_at), ends_at: iso(ends_at),
                         vcpu: vcpu, memory_mib: memory_mib, disk_mib: disk_mib, region: region)
      Record.new(@t.json("POST", "/v1/reservations", body: body, key: idempotency_key))
    end

    # Keeps standing room for +sandboxes+ sandboxes until it is cancelled. Keep
    # a few more than the pool runs, for deletes still finishing.
    def keep(sandboxes:, snapshots: nil, for_key: nil, vcpu: nil, memory_mib: nil, disk_mib: nil, region: nil,
             idempotency_key: nil)
      body = Fields.body(standing: true, sandboxes: sandboxes, snapshots: snapshots, for_key: for_key || nil,
                         vcpu: vcpu, memory_mib: memory_mib, disk_mib: disk_mib, region: region)
      Record.new(@t.json("POST", "/v1/reservations", body: body, key: idempotency_key))
    end

    # Changes standing room in place: how many it holds, its snapshots, or
    # both. It moves or grows only when all of it fits now; otherwise it raises
    # no_capacity and nothing changes.
    def update(id, sandboxes: nil, snapshots: nil, idempotency_key: nil)
      body = Fields.body(sandboxes: sandboxes, snapshots: snapshots)
      Record.new(@t.json("POST", "/v1/reservations/#{seg(id)}:update", body: body, key: idempotency_key))
    end

    # Bookings, newest first, as a Page (+data+, +next_cursor+, +more?+,
    # +next_page+); iterating it walks every page.
    def list(limit: nil, cursor: nil)
      query = { "limit" => limit, "cursor" => cursor }
      body = @t.json("GET", "/v1/reservations", query: query)
      Page.new(body["items"].map { |item| Record.new(item) }, body["nextCursor"]) do |next_cursor|
        list(limit: limit, cursor: next_cursor)
      end
    end

    def get(id) = Record.new(@t.json("GET", "/v1/reservations/#{seg(id)}"))

    # Gives the room back. The booking comes back with status "cancelled".
    def cancel(id) = Record.new(@t.json("DELETE", "/v1/reservations/#{seg(id)}"))

    private

    def iso(at) = at.respond_to?(:iso8601) ? at.iso8601(3) : at
  end
end
