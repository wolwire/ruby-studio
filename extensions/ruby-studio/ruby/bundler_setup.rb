# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for license information.
# Activate the project's Bundler before setup can attempt a process restart.
require 'rubygems'

gemfile = ENV['BUNDLE_GEMFILE'] || File.join(Dir.pwd, 'Gemfile')
lockfile = File.basename(gemfile) == 'gems.rb' ? File.join(File.dirname(gemfile), 'gems.locked') : "#{gemfile}.lock"
version = ENV['BUNDLER_VERSION']
if !version && File.file?(lockfile)
  tail = File.open(lockfile, 'rb') do |file|
    file.seek([file.size - 16_384, 0].max)
    file.read(16_384)
  end
  version = tail[/^BUNDLED WITH\r?\n[ \t]+([0-9][0-9A-Za-z.+-]*)/, 1]
end
version ? gem('bundler', "= #{version}") : gem('bundler')
# An SDK's RUBYLIB can place its default Bundler before the activated gem.
# Put only the selected Bundler libraries first; leave other library order intact.
Gem.loaded_specs.fetch('bundler').full_require_paths.reverse_each do |directory|
  $LOAD_PATH.delete(directory)
  $LOAD_PATH.unshift(directory)
end
require 'bundler/setup'
