// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See License.txt in the project root for license information.

use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{self, Read};
use std::path::{Path, PathBuf};

// Decode portable SDKs in the bundled native process. No Windows setup program
// runs: RubyInstaller setup otherwise uninstalls a registered previous version.
fn entry_path(name: &str, root: &str) -> io::Result<PathBuf> {
    let normalized = name.replace('\\', "/");
    let parts: Vec<&str> = normalized.trim_end_matches('/').split('/').collect();
    if parts.first().copied() != Some(root)
        || parts.iter().any(|part| {
            part.is_empty()
                || *part == "."
                || *part == ".."
                || part.ends_with(['.', ' '])
                || part
                    .chars()
                    .any(|ch| ch.is_control() || ":*?\"<>|".contains(ch))
                || matches!(
                    part.split('.')
                        .next()
                        .unwrap_or("")
                        .to_ascii_uppercase()
                        .as_str(),
                    "CON"
                        | "PRN"
                        | "AUX"
                        | "NUL"
                        | "COM1"
                        | "COM2"
                        | "COM3"
                        | "COM4"
                        | "COM5"
                        | "COM6"
                        | "COM7"
                        | "COM8"
                        | "COM9"
                        | "LPT1"
                        | "LPT2"
                        | "LPT3"
                        | "LPT4"
                        | "LPT5"
                        | "LPT6"
                        | "LPT7"
                        | "LPT8"
                        | "LPT9"
                )
        })
    {
        return Err(io::Error::other("Unexpected Ruby SDK archive path"));
    }
    Ok(parts.iter().collect())
}

pub fn extract(
    archive: &Path,
    destination: &Path,
    root: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    if root.is_empty() || root.contains(['/', '\\']) || entry_path(root, root).is_err() {
        return Err(io::Error::other("Invalid Ruby SDK archive root").into());
    }
    if !fs::metadata(destination)?.is_dir() || fs::read_dir(destination)?.next().is_some() {
        return Err(io::Error::other("Ruby SDK extraction requires an empty directory").into());
    }
    let mut count = 0usize;
    let mut total = 0u64;
    let mut paths = HashSet::new();
    sevenz_rust2::decompress_file_with_extract_fn(archive, destination, |entry, reader, _| {
        let relative = entry_path(&entry.name, root).map_err(sevenz_rust2::Error::from)?;
        count += 1;
        total = total
            .checked_add(entry.size)
            .ok_or_else(|| sevenz_rust2::Error::from(io::Error::other("Ruby SDK size overflow")))?;
        // Reject deletion entries and reparse points. Files are created with
        // create_new, so archive metadata cannot introduce links or overwrite files.
        if count > 200_000
            || total > 1024 * 1024 * 1024
            || entry.is_anti_item
            || entry.has_windows_attributes && entry.windows_attributes & 0x400 != 0
            || !paths.insert(relative.to_string_lossy().to_ascii_lowercase())
        {
            return Err(sevenz_rust2::Error::from(io::Error::other(
                "Unexpected Ruby SDK archive entry",
            )));
        }
        let target = destination.join(relative);
        if entry.is_directory {
            fs::create_dir_all(target).map_err(sevenz_rust2::Error::from)?;
        } else {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(sevenz_rust2::Error::from)?;
            }
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(target)
                .map_err(sevenz_rust2::Error::from)?;
            let copied = io::copy(&mut reader.take(entry.size + 1), &mut file)
                .map_err(sevenz_rust2::Error::from)?;
            if copied != entry.size {
                return Err(sevenz_rust2::Error::from(io::Error::other(
                    "Ruby SDK archive size mismatch",
                )));
            }
        }
        Ok(true)
    })?;
    if count == 0 {
        return Err(io::Error::other("Empty Ruby SDK archive").into());
    }
    println!("Extracted {} verified Ruby SDK entries", count);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn archive_paths_stay_inside_the_expected_root_on_windows_and_unix() {
        assert_eq!(
            entry_path("ruby-sdk/bin/ruby.exe", "ruby-sdk").unwrap(),
            PathBuf::from("ruby-sdk/bin/ruby.exe")
        );
        assert_eq!(
            entry_path("ruby-sdk\\bin\\ruby.exe", "ruby-sdk").unwrap(),
            PathBuf::from("ruby-sdk/bin/ruby.exe")
        );
        for name in [
            "",
            "/ruby-sdk/file",
            "other/file",
            "ruby-sdk/../escape",
            "ruby-sdk/./file",
            "ruby-sdk//file",
            "ruby-sdk/C:/file",
            "ruby-sdk/file:stream",
            "ruby-sdk/CON.txt",
            "ruby-sdk/file.",
            "ruby-sdk/file ",
            "ruby-sdk/file\0",
        ] {
            assert!(entry_path(name, "ruby-sdk").is_err(), "accepted {name}");
        }
    }
}
