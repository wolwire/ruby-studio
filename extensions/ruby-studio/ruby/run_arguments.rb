# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root.
# Windows Ruby parses single quotes and expands globs before the program starts.
# Restore explicit arguments as data after interpreter option parsing.
require 'json'
arguments = ENV.delete('RUBY_STUDIO_RUN_ARGUMENTS')
ARGV.concat(JSON.parse(arguments)) if arguments
