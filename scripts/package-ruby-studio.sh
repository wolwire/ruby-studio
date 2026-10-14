#!/usr/bin/env bash
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root.
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/lib/ruby-studio-build.sh"
[[ $# == 0 ]] || { [[ $# == 1 && "$1" == --help ]] && { printf 'Usage: ./scripts/package-ruby-studio.sh\nArchive an existing RUBY_STUDIO_APP_DIR into dist/ruby-studio with metadata and SHA256SUMS.\n'; exit 0; }; ruby_studio_fail 'Use --help for packaging usage.'; }
ruby_studio_environment no-rust
cd "$RUBY_STUDIO_SOURCE"
ruby_studio_logs
ruby_studio_require tar 'Install GNU tar.'
ruby_studio_require sha256sum 'Install coreutils.'
ruby_studio_run verify-package node scripts/lib/ruby-studio-artifact.mjs verify "$RUBY_STUDIO_APP_DIR"
artifact_dir="${RUBY_STUDIO_ARTIFACT_DIR:-$RUBY_STUDIO_SOURCE/dist/ruby-studio}"
mkdir -p -- "$artifact_dir"
artifact_dir="$(cd -- "$artifact_dir" && pwd)"
version="$(node -p "JSON.parse(require('node:fs').readFileSync(process.argv[1])).version" "$RUBY_STUDIO_APP_DIR/resources/app/package.json")"
revision="$(node -e 'const fs = require("node:fs"); const file = process.argv[1]; console.log(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)).sourceCommit.slice(0, 12) : "unverified");' "$RUBY_STUDIO_APP_DIR/ruby-studio-build.json")"
name="ruby-studio-linux-x64-$version-$revision"
archive="$artifact_dir/$name.tar.gz"
metadata="$artifact_dir/$name.build-info.json"
ruby_studio_run package-metadata node scripts/lib/ruby-studio-artifact.mjs metadata "$RUBY_STUDIO_APP_DIR" "$metadata"
epoch="${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct)}"
[[ "$epoch" =~ ^[0-9]+$ ]] || ruby_studio_fail 'SOURCE_DATE_EPOCH must be a Unix timestamp.'
ruby_studio_run archive tar --sort=name --mtime="@$epoch" --owner=0 --group=0 --numeric-owner --transform='s,^\.,RubyStudio-linux-x64,' -czf "$archive" -C "$RUBY_STUDIO_APP_DIR" .
(cd "$artifact_dir" && sha256sum "$name.tar.gz" "$name.build-info.json" > SHA256SUMS && sha256sum --check SHA256SUMS)
printf '\nRuby Studio archive: %s\nChecksums: %s/SHA256SUMS\n' "$archive" "$artifact_dir"
