# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for license information.
# Original Ruby Studio formatter using the project's public RSpec notification API.
require 'json'
require 'thread'
require_relative 'bundler_setup' if ENV['BUNDLE_GEMFILE'] || File.file?(File.join(Dir.pwd, 'Gemfile'))
require 'rspec/core'

class RubyStudioFormatter
  RSpec::Core::Formatters.register self, :example_started, :example_passed, :example_failed, :example_pending

  def initialize(output)
    @output = output
    @mutex = Mutex.new
  end

  def emit(example, event, status = nil, exception = nil)
    result = example.execution_result
    payload = {
      'event' => event, 'id' => example.id, 'name' => example.full_description,
      'file' => File.expand_path(example.metadata[:absolute_file_path] || example.metadata[:file_path]),
      'line' => example.metadata[:line_number], 'suite' => example.example_group.description,
      'status' => status, 'duration' => result.run_time.to_f * 1000,
      'message' => exception ? "#{exception.class}: #{exception.message}\n#{Array(exception.backtrace).join("\n")}" : result.pending_message.to_s
    }
    @mutex.synchronize do
      @output.write("\n@@RUBY_STUDIO@@#{JSON.generate(payload)}\n")
      @output.flush
    end
  end

  def example_started(notification)
    emit(notification.example, 'started')
  end

  def example_passed(notification)
    emit(notification.example, 'finished', 'passed')
  end

  def example_failed(notification)
    emit(notification.example, 'finished', 'failed', notification.exception)
  end

  def example_pending(notification)
    emit(notification.example, 'finished', 'skipped')
  end
end

if $PROGRAM_NAME == __FILE__
  exit RSpec::Core::Runner.run(ARGV + ['--format', 'RubyStudioFormatter'])
end
