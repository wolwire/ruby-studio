# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for license information.
# Original Ruby Studio debugger transport; requires only Ruby's standard library.

require 'socket'
require 'json'

module RubyStudio
  # The private socket carries debugger messages. The program keeps its normal
  # stdout/stderr, so arbitrary output cannot corrupt debugger framing.
  class DebugBridge
    OBJECT_CLASS = Object.instance_method(:class)
    OBJECT_IS_A = Object.instance_method(:is_a?)
    OBJECT_IVARS = Object.instance_method(:instance_variables)
    OBJECT_IVAR_GET = Object.instance_method(:instance_variable_get)
    CLASS_NAME = Module.instance_method(:name)
    STRING_DUMP = String.instance_method(:dump)
    ARRAY_LENGTH = Array.instance_method(:length)
    ARRAY_GET = Array.instance_method(:[])
    HASH_LENGTH = Hash.instance_method(:length)
    HASH_EACH = Hash.instance_method(:each_pair)
    INTEGER_STRING = Integer.instance_method(:to_s)
    FLOAT_STRING = Float.instance_method(:to_s)

    def initialize(target)
      @target = File.realpath(target)
      @root = File.realpath(Dir.pwd)
      @socket = TCPSocket.new('127.0.0.1', Integer(ENV.fetch('RUBY_STUDIO_DEBUG_PORT')))
      @socket.sync = true
      @main_thread = Thread.current
      @process_id = Process.pid
      @breakpoints = {}
      @frames = [{ name: '<main>', path: @target, line: 1, binding: TOPLEVEL_BINDING }]
      @references = {}
      @next_reference = 0
      @step = nil
      @step_depth = 0
      @pause_requested = false
      @stop_on_entry = false
      @started = false
      @running = false
      @paused = true
      emit(type: 'ready', token: ENV.fetch('RUBY_STUDIO_DEBUG_TOKEN'))
    end

    def emit(message)
      @socket.write(JSON.generate(message) + "\n")
    rescue IOError, SystemCallError
      exit! 0
    end

    def reply(id, result = {}, error = nil)
      emit(type: 'response', id: id, result: result, error: error)
    end

    def reference(value, kind = 'value')
      @next_reference += 1
      @references[@next_reference] = [kind, value]
      @next_reference
    end

    # Do not call application-defined inspect/to_s while inspecting variables.
    # Captured core methods also protect against an application's overrides.
    def display(value)
      case value
      when nil then 'nil'
      when true then 'true'
      when false then 'false'
      when String then STRING_DUMP.bind_call(value)[0, 1000]
      when Integer then INTEGER_STRING.bind_call(value)
      when Float then FLOAT_STRING.bind_call(value)
      when Array then "Array (#{ARRAY_LENGTH.bind_call(value)})"
      when Hash then "Hash (#{HASH_LENGTH.bind_call(value)})"
      else
        klass = OBJECT_CLASS.bind_call(value)
        "#<#{CLASS_NAME.bind_call(klass) || 'anonymous'}>"
      end
    end

    def variable(name, value)
      expandable = OBJECT_IS_A.bind_call(value, Array) || OBJECT_IS_A.bind_call(value, Hash) || !OBJECT_IVARS.bind_call(value).empty?
      { name: name.to_s, value: display(value), type: CLASS_NAME.bind_call(OBJECT_CLASS.bind_call(value)), variablesReference: expandable ? reference(value) : 0 }
    end

    def variables(handle)
      kind, value = @references.fetch(handle)
      if kind == 'locals'
        value.local_variables.sort_by(&:to_s).map { |name| variable(name, value.local_variable_get(name)) }
      elsif OBJECT_IS_A.bind_call(value, Array)
        Array.new([ARRAY_LENGTH.bind_call(value), 500].min) { |index| variable(index, ARRAY_GET.bind_call(value, index)) }
      elsif OBJECT_IS_A.bind_call(value, Hash)
        result = []
        HASH_EACH.bind_call(value) { |key, child| result << variable(display(key), child) if result.length < 500 }
        result
      else
        OBJECT_IVARS.bind_call(value).first(500).map { |name| variable(name, OBJECT_IVAR_GET.bind_call(value, name)) }
      end
    end

    def executable_lines(filename)
      return [] unless defined?(RubyVM::InstructionSequence)
      result = []
      visit = lambda do |instruction|
        result.concat(instruction.trace_points.select { |_line, event| event == :line }.map(&:first))
        instruction.each_child { |child| visit.call(child) }
      end
      visit.call(RubyVM::InstructionSequence.compile_file(filename))
      result.uniq.sort
    rescue StandardError, SyntaxError
      []
    end

    def command(message)
      id = message['id']
      args = message['arguments'] || {}
      case message['command']
      when 'setBreakpoints'
        filename = File.expand_path(args.fetch('path'))
        lines = executable_lines(filename)
        selected = Array(args['lines']).map do |line|
          requested = Integer(line)
          resolved = lines.find { |candidate| candidate >= requested }
          { verified: !resolved.nil?, line: resolved || requested }
        end
        @breakpoints[filename] = selected.select { |item| item[:verified] }.map { |item| item[:line] }
        reply(id, breakpoints: selected)
      when 'start'
        @started = true
        @stop_on_entry = !!args['stopOnEntry']
        @paused = false
        @running = true
        reply(id)
      when 'continue', 'next', 'stepIn', 'stepOut'
        @step = message['command'] == 'continue' ? nil : message['command']
        @step_depth = @frames.length
        @paused = false
        @running = true
        reply(id)
      when 'pause'
        @pause_requested = true
        reply(id)
      when 'stackTrace'
        ensure_paused
        reply(id, stackFrames: @frames.each_with_index.to_a.reverse.map { |frame, index| { id: index + 1, name: frame[:name], source: { name: File.basename(frame[:path]), path: frame[:path] }, line: frame[:line], column: 1 } })
      when 'scopes'
        ensure_paused
        frame = @frames.fetch(Integer(args.fetch('frameId')) - 1)
        reply(id, scopes: [{ name: 'Locals', variablesReference: reference(frame[:binding], 'locals'), expensive: false }, { name: 'Self', variablesReference: reference(frame[:binding].receiver), expensive: false }])
      when 'variables'
        ensure_paused
        reply(id, variables: variables(Integer(args.fetch('variablesReference'))))
      when 'evaluate'
        ensure_paused
        expression = args.fetch('expression')
        raise ArgumentError, 'Expression is too large' if expression.bytesize > 65_536
        frame = @frames.fetch(Integer(args.fetch('frameId', @frames.length)) - 1)
        value = frame[:binding].eval(expression)
        item = variable('result', value)
        reply(id, result: item[:value], type: item[:type], variablesReference: item[:variablesReference])
      when 'disconnect'
        reply(id)
        exit! 0
      else
        reply(id, {}, 'Unsupported debugger command')
      end
    rescue StandardError, SyntaxError => error
      reply(id, {}, "#{error.class}: #{error.message}")
    end

    def ensure_paused
      raise 'The program is running' unless @paused && @started
    end

    def receive(blocking)
      return unless blocking || IO.select([@socket], nil, nil, 0)
      line = @socket.gets
      exit! 0 unless line
      raise 'Debugger message is too large' if line.bytesize > 1_048_576
      command(JSON.parse(line))
    end

    def user_path?(filename)
      filename == @target || (filename.start_with?(@root + File::SEPARATOR) && filename != __FILE__)
    end

    def stopped(reason)
      @paused = true
      @running = false
      @pause_requested = false
      @stop_on_entry = false
      @step = nil
      @references.clear
      emit(type: 'event', event: 'stopped', body: { reason: reason, threadId: 1, allThreadsStopped: false })
      receive(true) while @paused
    end

    def run
      receive(true) until @started
      trace = TracePoint.new(:line, :call, :return, :b_call, :b_return) do |event|
        next unless Process.pid == @process_id && Thread.current == @main_thread
        filename = File.expand_path(event.path)
        next unless user_path?(filename)
        case event.event
        when :call, :b_call
          @frames << { name: event.event == :b_call ? "block in #{event.method_id || '<main>'}" : event.method_id.to_s, path: filename, line: event.lineno, binding: event.binding }
        when :return, :b_return
          @frames.pop if @frames.length > 1
        when :line
          @frames.last.merge!(path: filename, line: event.lineno, binding: event.binding)
          receive(false)
          reason = if @stop_on_entry
            'entry'
          elsif @pause_requested
            'pause'
          elsif (@breakpoints[filename] || []).include?(event.lineno)
            'breakpoint'
          elsif @step == 'stepIn' || (@step == 'next' && @frames.length <= @step_depth) || (@step == 'stepOut' && @frames.length < @step_depth)
            'step'
          end
          stopped(reason) if reason
        end
      end
      $0 = @target
      $stdout.sync = true
      $stderr.sync = true
      trace.enable { load @target }
    ensure
      trace&.disable
      emit(type: 'event', event: 'terminated', body: {})
      @socket.close
    end
  end
end

target = ARGV.shift
abort 'A Ruby script is required' unless target
RubyStudio::DebugBridge.new(target).run
