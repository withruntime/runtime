# frozen_string_literal: true

require_relative "lib/withruntime/version"

Gem::Specification.new do |spec|
  spec.name = "withruntime"
  spec.version = WithRuntime::VERSION
  spec.summary = "Runtime Cloud: one client for every Runtime product. Sandboxes first."
  spec.description = "Linux sandboxes for agents, and every other Runtime Cloud product: " \
                     "streaming commands and terminals, files and watches, images, durable volumes " \
                     "and backups, domains, TCP ports, private networking and secrets. Standard library only."
  spec.authors = ["Runtime"]
  spec.homepage = "https://withruntime.com"
  spec.required_ruby_version = ">= 3.2"
  spec.files = Dir["lib/**/*.rb"] + ["GUIDE.md", "LICENSE"]
  spec.license = "Apache-2.0"
  spec.require_paths = ["lib"]
  spec.metadata = {
    "homepage_uri" => "https://withruntime.com",
    "documentation_uri" => "https://withruntime.com/docs/ruby",
    "source_code_uri" => "https://github.com/withruntime/runtime/tree/main/sdks/ruby",
    "bug_tracker_uri" => "https://github.com/withruntime/runtime/issues",
    "rubygems_mfa_required" => "true"
  }
end
