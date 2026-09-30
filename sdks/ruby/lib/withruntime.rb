# frozen_string_literal: true

# The Ruby client for Runtime Cloud: Linux sandboxes for agents, and every
# other Runtime product as it launches. Standard library only.
#
#   require "withruntime"
#
#   runtime = WithRuntime::Client.new # RUNTIME_API_KEY, or this machine's saved connection
#   sbx = runtime.sandboxes.create(funding: "trial")
#   puts sbx.exec("python3 -c 'print(6 * 7)'", check: true).stdout
#   sbx.stop
#
# The guide is at https://withruntime.com/docs/ruby.
require "json"
require "openssl"

require_relative "withruntime/version"
require_relative "withruntime/errors"
require_relative "withruntime/api_defaults"
require_relative "withruntime/record"
require_relative "withruntime/fields"
require_relative "withruntime/transport"
require_relative "withruntime/credentials"
require_relative "withruntime/tar"
require_relative "withruntime/sandbox"
require_relative "withruntime/products"
require_relative "withruntime/images"
require_relative "withruntime/network_products"
require_relative "withruntime/parity_products"
require_relative "withruntime/file_watch"
require_relative "withruntime/websocket"
require_relative "withruntime/tunnel"
require_relative "withruntime/client"
