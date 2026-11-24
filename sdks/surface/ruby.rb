# sdks/release.sh surface: Ruby. Prints the gem's public surface as JSON: each Withruntime class's public methods
# and their parameters (the old Withruntime::Generated:: names read as the module's own).
require "json"
$LOAD_PATH.unshift ARGV[0]
require "withruntime"
out = {}
ObjectSpace.each_object(Class).select { |c| c.name&.start_with?("Withruntime::") }.each do |c|
  n = c.name.sub("Withruntime::Generated::", "Withruntime::")
  c.public_instance_methods(false).each { |m| out["#{n}##{m}"] = { "params" => c.instance_method(m).parameters.map { |t, p| [p.to_s, t.to_s, %i[req keyreq].include?(t)] } } }
  c.singleton_methods(false).each { |m| out["#{n}.#{m}"] = { "params" => c.method(m).parameters.map { |t, p| [p.to_s, t.to_s, %i[req keyreq].include?(t)] } } }
end
puts JSON.generate(out)
