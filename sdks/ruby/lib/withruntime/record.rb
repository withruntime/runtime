# frozen_string_literal: true

module WithRuntime
  # An answer from the API: the whole JSON object, read by snake_case name
  # (+info.expires_at+, +info.memory_mib+) or by the API's own key
  # (+info["expiresAt"]+). A field newer than this SDK is always there.
  class Record
    attr_reader :to_h

    def initialize(hash)
      @to_h = (hash || {}).freeze
      @index = @to_h.keys.to_h { |key| [key.to_s.delete("_").downcase, key] }
    end

    def [](key) = @to_h[key.to_s]

    def key?(name) = @index.key?(name.to_s.delete("_").downcase)

    # A field by snake_case name; nil when the answer does not carry it, as a
    # missing key reads in the other SDKs.
    def method_missing(name, *args)
      return super unless args.empty? && name.match?(/\A[a-z][a-z0-9_]*\??\z/) && !name.start_with?("to_")

      key = @index[name.to_s.delete_suffix("?").delete("_").downcase]
      value = key && wrap(@to_h[key])
      name.end_with?("?") ? !!value : value
    end

    def respond_to_missing?(name, include_private = false)
      @index.key?(name.to_s.delete_suffix("?").delete("_").downcase) || super
    end

    def ==(other) = other.is_a?(Record) && other.to_h == to_h

    def to_s = JSON.generate(to_h)

    def inspect = "#<#{self.class.name} #{to_s}>"

    private

    def wrap(value)
      case value
      when Hash then Record.new(value)
      when Array then value.map { |item| wrap(item) }
      else value
      end
    end
  end

  # A finished command. A timeout is a result (+timed_out+), not an exception.
  class CommandResult < Record
    def exit_code = self["exitCode"]
    def stdout = self["stdout"] || ""
    def stderr = self["stderr"] || ""
    def timed_out = self["timedOut"] == true
    def ok? = !timed_out && exit_code == 0
  end

  # One page of a list. +next_page+ reads the one after it; +each+ walks every
  # item on this page and on every page after it.
  class Page
    include Enumerable
    attr_reader :data, :next_cursor

    def initialize(data, next_cursor, &fetch)
      @data = data
      @next_cursor = next_cursor
      @fetch = fetch
    end

    def more? = !(next_cursor.nil? || next_cursor.empty?)

    def next_page = more? ? @fetch.call(next_cursor) : nil

    def each(&block)
      return enum_for(:each) unless block

      page = self
      while page
        page.data.each(&block)
        page = page.next_page
      end
    end
  end
end
