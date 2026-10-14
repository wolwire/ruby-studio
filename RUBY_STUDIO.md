# Ruby Studio fork

The bundled original Ruby implementation is in `extensions/ruby-studio`. Native workbench contributions are in `src/vs/workbench/contrib/rubyStudio`.

This fork targets a Linux x64 desktop build and preserves the VS Code MIT license and dependency notices. It uses no third-party Ruby IDE engine. The Rust scanner is std-only; the Ruby debugger uses TracePoint/Socket/JSON; project test reporters integrate the installed Minitest or RSpec framework.

Build with `scripts/build-ruby-studio.sh`. Node24.15.0 and the private Rust toolchain are discovered beside this checkout. Existing node_modules dependencies must be installed first using the upstream native build prerequisites. The product package is written beside the checkout to `VSCode-linux-x64`; its binary is `ruby-studio`.

After building, set `RUBY_STUDIO_RUBY` to the selected Ruby executable and run `scripts/test-ruby-studio.sh`. The script checks compilation before tests, runs worker/model/runtime tests and then launches a disposable real extension-host integration workspace. It preserves the production user profile.

Workspace-level run configurations use `.ruby-studio/run-configurations.json`. Users can select a Ruby SDK in the status bar. Project execution is gated on workspace trust. Built-in support is available without installing an extension pack.

Current boundaries include general dynamic Ruby analysis/refactoring, full formatting, advanced Rails DSL intelligence, remote/container SDKs, non-SQLite databases and multi-thread/process or conditional-breakpoint debugging. The language status command reports analysis boundaries; native tests and research evidence are retained in the companion workspace.
