# Native archive decoding libraries

Ruby Studio’s native worker links the following libraries to decode portable Ruby SDK archives. Ruby version selection, download verification, installation, cancellation and SDK activation are implemented by Ruby Studio.

- sevenz-rust2 0.24.0 — Apache-2.0 — https://github.com/hasenbanck/sevenz-rust2
- lzma-rust2 0.22.0 — Apache-2.0 — https://github.com/hasenbanck/lzma-rust2
- crc32fast 1.5.2 — MIT — https://github.com/srijs/rust-crc32fast
- cfg-if 1.0.5 — MIT — https://github.com/rust-lang/cfg-if

The corresponding license texts are included here. Cargo.lock pins dependency versions and checksums. Only decoding and utility features are enabled; archive encoders, encryption and optional compression formats are disabled.
