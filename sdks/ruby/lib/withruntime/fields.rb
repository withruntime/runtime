# frozen_string_literal: true

module WithRuntime
  # Ruby's snake_case keywords as the API's camelCase fields: +timeout_seconds:+
  # is timeoutSeconds, +memory_mib:+ is memoryMiB. User data (labels, env,
  # build_args, headers and the like) is sent as it is.
  module Fields
    OPAQUE = %w[labels env buildArgs headers data context detail].freeze

    module_function

    def camel(key)
      parts = key.to_s.split("_")
      parts.drop(1).each_with_index { |part, index| parts[index + 1] = part == "mib" ? "MiB" : part.capitalize }
      parts.join
    end

    # A request body from keyword arguments; nil values are left out.
    def body(fields)
      fields.each_with_object({}) do |(key, value), out|
        next if value.nil?

        name = key.is_a?(Symbol) ? camel(key) : key.to_s
        out[name] = OPAQUE.include?(name) ? stringify(value) : convert(value)
      end
    end

    def convert(value)
      case value
      when Hash then body(value)
      when Array then value.map { |item| convert(item) }
      else value
      end
    end

    def stringify(value)
      value.is_a?(Hash) ? value.to_h { |key, item| [key.to_s, item] } : value
    end
  end
end
