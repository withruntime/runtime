# frozen_string_literal: true

module WithRuntime
  # +runtime.containers+: one OCI image's process on its own microVM, billed
  # at the sandbox rates, at /v1/containers. In a private beta: an account
  # outside it is refused with product_in_beta (403, PermissionDeniedError).
  #
  #   box = runtime.containers.create(image: "nginx:1.27", vcpu: 1, memory_mib: 512, name: "web")
  #   box = runtime.containers.wait(box.id, "running")
  #   puts box.port
  #
  # A container: id, name, labels, state (waiting, running, sleeping, stopped,
  # failed, deleting, deleted), image (pinned to its digest), entrypoint,
  # command, working_dir, user, port (or nil), exposed_ports, on_exit, sleep,
  # vcpu, memory_mib, env_names (the environment's names, never its values),
  # error ({code, message} or nil), created_at, updated_at and deleted_at.
  class Containers < ResourceProduct
    def initialize(transport)
      super(transport, "/v1/containers", %w[failed deleted])
    end

    # Runs one copy of +image:+ (an OCI reference; the answer pins its digest)
    # with +vcpu:+ (1 to 16) and +memory_mib:+ (128 to 65536), all required.
    # +entrypoint:+ replaces the image's Entrypoint and drops its Cmd;
    # +command:+ replaces its Cmd. +env:+ is set over the image's own and never
    # read back, only its names. +port:+ (1 to 65535) is required when the
    # image exposes several TCP ports. +on_exit:+ is "restart" or "stop": by
    # default it restarts when it serves a port, else stops. It never sleeps
    # unless +sleep: true+. Also +name:+, +labels:+, +working_dir:+ and +user:+.
    def create(idempotency_key: nil, **fields) = super

    # Only +name:+ and +labels:+ change; +name: :remove+ clears the name.
    def update(id, idempotency_key: nil, **changes) = super

    # Follows its state to +target+ ("running", say); reaching failed or
    # deleted first raises with its error.
    def wait(id, target, timeout: 300, poll: 0.25) = super
  end
end
