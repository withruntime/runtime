require_relative "lib/withruntime/version"

Gem::Specification.new do |spec|
  spec.name = "withruntime"
  spec.version = Withruntime::VERSION
  spec.summary = "Runtime Cloud: Linux sandboxes for agents. The typed client for every verb of the API."
  spec.authors = ["Runtime"]
  spec.homepage = "https://withruntime.com"
  spec.license = "Apache-2.0"
  spec.required_ruby_version = ">= 3.2"
  spec.files = Dir["lib/**/*.rb"] + ["LICENSE", "README.md", "CHANGELOG.md"]
  spec.metadata = {
    "homepage_uri" => "https://withruntime.com",
    "documentation_uri" => "https://withruntime.com/docs",
    "source_code_uri" => "https://github.com/withruntime/runtime/tree/main/sdks/ruby",
    "changelog_uri" => "https://github.com/withruntime/runtime/blob/main/sdks/ruby/CHANGELOG.md"
  }
end
