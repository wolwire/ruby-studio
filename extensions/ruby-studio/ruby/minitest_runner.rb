# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for license information.
# Original Ruby Studio adapter for the public Minitest reporter API.
require 'json'
require 'thread'
require_relative 'bundler_setup' if ENV['BUNDLE_GEMFILE'] || File.file?(File.join(Dir.pwd, 'Gemfile'))

config = JSON.parse(ARGV.shift || '{}')
files = config.fetch('files', []).map { |file| File.expand_path(file) }
raise ArgumentError, 'No test files were selected' if files.empty?

# Load only the framework selected by the project. This helper installs no gems.
require 'minitest/autorun'

class RubyStudioMinitestReporter < Minitest::AbstractReporter
  def initialize
    super
    @mutex = Mutex.new
    @locations = {}
  end

  def emit(event)
    @mutex.synchronize do
      STDOUT.write("\n@@RUBY_STUDIO@@#{JSON.generate(event)}\n")
      STDOUT.flush
    end
  end

  def prerecord(klass, name)
    source = klass.instance_method(name).source_location
    location = { 'file' => source && File.expand_path(source[0]), 'line' => source && source[1] }
    @locations[[klass.name, name]] = location
    emit(location.merge('event' => 'started', 'id' => "#{klass.name}##{name}", 'name' => name, 'suite' => klass.name))
  end

  def record(result)
    suite = result.respond_to?(:klass) ? result.klass : result.class.name
    name = result.name
    location = @locations[[suite, name]] || {}
    status = if result.skipped?
               'skipped'
             elsif result.respond_to?(:error?) && result.error?
               'errored'
             elsif result.passed?
               'passed'
             else
               'failed'
             end
    failures = result.respond_to?(:failures) ? result.failures : [result.failure].compact
    message = failures.map { |failure| "#{failure.class}: #{failure.message}\n#{Array(failure.backtrace).join("\n")}" }.join("\n\n")
    emit(location.merge('event' => 'finished', 'id' => "#{suite}##{name}", 'name' => name, 'suite' => suite,
                        'status' => status, 'duration' => result.time.to_f * 1000, 'message' => message))
  end
end

module RubyStudioMinitestPlugin
  def plugin_ruby_studio_init(_options)
    reporter << RubyStudioMinitestReporter.new
  end
end
Minitest.extend(RubyStudioMinitestPlugin)
Minitest.extensions << 'ruby_studio' unless Minitest.extensions.include?('ruby_studio')
files.each { |file| require file }
if config['lines']
  selected_lines = config['lines']
  selected = Minitest::Runnable.runnables.flat_map do |klass|
    klass.public_instance_methods.grep(/^test_/).filter_map do |name|
      source = klass.instance_method(name).source_location
      next unless source && files.include?(File.expand_path(source[0])) && selected_lines.include?(source[1])
      Regexp.escape("#{klass.name}##{name}")
    end
  end
  pattern = selected.empty? ? '(?!)' : "\\A(?:#{selected.join('|')})\\z"
  ARGV.concat(['--name', "/#{pattern}/"])
elsif config['filter'] && !config['filter'].empty?
  ARGV.concat(['--name', "/#{config['filter']}/"])
end
