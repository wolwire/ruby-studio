# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root.
require 'json'
require 'rubygems'
require 'rbconfig'

# Resolves dependency metadata only. Never boot Rails or load application initializers.
result = { bundle: 'none', dependencies: [], issues: [], configurationFiles: [] }
specs = []
# Discover the selected manifest before activating Bundler. RubyGems' version finder
# uses BUNDLER_VERSION first, then BUNDLED WITH; Bundler prefers gems.rb to Gemfile.
gemfile = ENV['BUNDLE_GEMFILE']
if !gemfile || gemfile.empty?
  directory = Dir.pwd
  loop do
    gemfile = ['gems.rb', 'Gemfile'].map { |name| File.join(directory, name) }.find { |file| File.file?(file) }
    break if gemfile || File.dirname(directory) == directory
    directory = File.dirname(directory)
  end
end
gemfile = File.expand_path(gemfile) if gemfile
lockfile = gemfile && (File.basename(gemfile) == 'gems.rb' ? gemfile.sub(/\.rb$/, '.locked') : "#{gemfile}.lock")
# Keep recovery paths even if the requested Bundler is unavailable. Once loaded,
# replace these hints with paths reported by that Bundler's own settings object.
project_root = gemfile ? File.dirname(gemfile) : Dir.pwd
local_config = File.join(File.expand_path(ENV.fetch('BUNDLE_APP_CONFIG', '.bundle'), project_root), 'config')
global_config = [ENV['BUNDLE_CONFIG'], ENV['BUNDLE_USER_CONFIG']].find { |value| value && !value.empty? }
global_config ||= File.join(ENV['BUNDLE_USER_HOME'] || File.join(Gem.user_home, '.bundle'), 'config')
result[:configurationFiles] = [gemfile, lockfile, local_config, global_config].compact.map { |file| File.expand_path(file) }
if ARGV.first == 'bundle' || gemfile
  begin
    locked = lockfile && File.file?(lockfile) && File.read(lockfile, 1024 * 1024)[/BUNDLED WITH\s*\n\s*(\S+)/, 1]
    required = ENV['BUNDLER_VERSION'] || locked
    gem 'bundler', required if required
    require 'bundler'
    settings = Bundler.settings
    result[:configurationFiles] = [Bundler.default_gemfile, Bundler.default_lockfile,
      *[:local_config_file, :global_config_file].filter_map { |method| settings.send(method) if settings.respond_to?(method, true) }
    ].compact.map { |file| File.expand_path(file.to_s) }
    specs = Bundler.definition.specs.to_a
    result[:bundle] = 'ready'
  rescue Gem::LoadError, LoadError
    result[:bundle] = 'missing-bundler'
    result[:issues] << 'Bundler required by this project is unavailable for the selected Ruby.'
  rescue StandardError => error
    result[:bundle] = error.class.name.include?('GemNotFound') ? 'missing-gems' : 'error'
    # Exception text can contain private gem URLs/credentials. Publish a bounded category.
    result[:issues] << "Dependency resolution failed (#{error.class.name}). Run Bundle Install or check Bundler configuration, then refresh."
  end
else
  specs = Gem::Specification.to_a.select(&:default_gem?)
end
# Watch both a configured symlink and its current target, without exposing values.
result[:configurationFiles] = result[:configurationFiles].flat_map { |file| File.exist?(file) ? [file, File.realpath(file)] : [file] }.uniq
specs.each do |spec|
  origin = if spec.respond_to?(:source) && spec.source.class.name.include?('Git') then 'git'
           elsif spec.respond_to?(:source) && spec.source.class.name.include?('Path') then 'path'
           elsif spec.default_gem? then 'default'
           else 'rubygems' end
  root = spec.full_gem_path
  paths = spec.full_require_paths.select { |item| File.directory?(item) }.map { |item| File.realpath(item) }.uniq
  result[:dependencies] << { id: [spec.name, spec.version.to_s, spec.platform.to_s, root].join(':'), name: spec.name, version: spec.version.to_s, platform: spec.platform.to_s, source: origin, sourcePath: root, requireRoots: paths, dependencies: spec.dependencies.select { |item| item.type == :runtime }.map(&:name), state: paths.empty? ? 'missing' : 'resolved' }
end
stdlib = RbConfig::CONFIG['rubylibdir']
if stdlib && File.directory?(stdlib)
  result[:dependencies] << { id: "stdlib:#{RUBY_VERSION}:#{stdlib}", name: 'Ruby Standard Library', version: RUBY_VERSION, source: 'stdlib', sourcePath: stdlib, requireRoots: [File.realpath(stdlib)], dependencies: [], state: 'resolved' }
end
puts 'RUBY_STUDIO_ENVIRONMENT=' + JSON.generate(result)
