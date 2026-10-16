# Ruby Studio fork

The bundled original Ruby implementation is in `extensions/ruby-studio`. Native workbench contributions are in `src/vs/workbench/contrib/rubyStudio`.

This fork builds native Windows x64, Linux x64, macOS Intel and Apple Silicon desktop apps and preserves the VS Code MIT license and dependency notices. It uses no third-party Ruby IDE engine. The Rust scanner is std-only; the Ruby debugger uses TracePoint/Socket/JSON; project test reporters integrate the installed Minitest or RSpec framework.

Build with `node scripts/ruby-studio.mjs build`; add `--setup --check --package` for dependency installation, validation and a downloadable archive. See [BUILDING_RUBY_STUDIO.md](BUILDING_RUBY_STUDIO.md) for clean-machine prerequisites and the GitHub Actions workflow. Use the Node version in `.nvmrc` and stable Rust. The Linux wrappers can also discover the private toolchain beside this checkout. Existing node_modules dependencies must be installed first using the upstream native build prerequisites. The product package is written beside the checkout to `VSCode-PLATFORM-ARCH`. GitHub Actions builds and tests all four targets and uploads archives, metadata and checksums.

After building, set `RUBY_STUDIO_RUBY` to the selected Ruby executable and run `node scripts/ruby-studio.mjs test`. The script checks compilation before tests, runs worker/model/runtime tests and then launches a disposable real extension-host integration workspace. It preserves the production user profile.

Workspace-level run configurations use `.ruby-studio/run-configurations.json`. Users can select a Ruby SDK in the status bar. Project execution is gated on workspace trust. Built-in support is available without installing an extension pack.

Current boundaries include general dynamic Ruby analysis/refactoring, full formatting, advanced Rails DSL intelligence, remote/container SDKs, non-SQLite databases and multi-thread/process or conditional-breakpoint debugging. The language status command reports analysis boundaries; native tests and research evidence are retained in the companion workspace.

## Configuration windows

The SDK toolbar/status button opens **Ruby SDK and Gems** in a separate native window. Choose or browse an interpreter, validate its actual Ruby version, and inspect its installed gems. Selection remains a draft until Apply or OK; failed validation leaves the window open and the saved SDK unchanged.

**Settings** (Ctrl+Alt+S or the toolbar gear) opens the same searchable category window. User, workspace and project scopes are explicit. Ruby indentation is saved under `[ruby]`, so it affects Ruby editors consistently. Apply saves without closing; OK saves and closes; Cancel discards changes made since the last Apply. Escape clears search first. **All Editor Settings** opens the full inherited editor settings in a separate native window.

**Edit Run/Debug Configurations** opens a separate form with add/duplicate/remove, name/type/script/cwd, JSON argument arrays/environment and Bundler controls. Apply validates before saving `.ruby-studio/run-configurations.json` and updates the selected configuration. Invalid JSON and externally changed configuration documents remain unsaved.

These windows use the fork's native auxiliary editor-window mechanism. They reproduce selected configuration behaviors from static RubyMine evidence; they are modeless native windows, rather than RubyMine's IDE-modal JVM dialogs. Complete settings and RubyMine feature parity are not claimed.
