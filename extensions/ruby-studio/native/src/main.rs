// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See License.txt in the project root for license information.

mod sdk_archive;

use std::collections::VecDeque;
use std::io::{self, BufRead, BufWriter, Read, Write};

const MAX_INPUT: usize = 16 * 1024 * 1024;
const MAX_TOKENS: usize = 1_000_000;
const KEYWORDS: &[&str] = &[
    "BEGIN", "END", "alias", "and", "begin", "break", "case", "class", "def", "defined?", "do",
    "else", "elsif", "end", "ensure", "false", "for", "if", "in", "module", "next", "nil", "not",
    "or", "redo", "rescue", "retry", "return", "self", "super", "then", "true", "undef", "unless",
    "until", "when", "while", "yield",
];
const STARTS: &[&str] = &[
    "=", "(", "[", "{", ",", ";", "=>", "then", "else", "return", "=~", "!~", "when",
];
const OPERATORS: &[&str] = &[
    "**=", "||=", "&&=", "===", "<=>", "...", "::", "&.", "=>", "==", "!=", "<=", ">=", "=~", "!~",
    "<<", ">>", "**", "..", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "&&", "||", "->",
];

#[derive(Clone, Debug, PartialEq)]
struct Token {
    kind: &'static str,
    start: usize,
    end: usize,
    line: usize,
    column: usize,
}

fn at(text: &[u16], i: usize) -> u16 {
    text.get(i).copied().unwrap_or(0)
}
fn alpha(ch: u16) -> bool {
    (65..=90).contains(&ch) || (97..=122).contains(&ch)
}
fn digit(ch: u16) -> bool {
    (48..=57).contains(&ch)
}
fn word(ch: u16) -> bool {
    alpha(ch) || digit(ch) || ch == 95
}
fn name_start(ch: u16) -> bool {
    alpha(ch) || ch == 95
}
fn whitespace(ch: u16) -> bool {
    matches!(ch, 9..=13 | 32 | 160 | 5760 | 8192..=8202 | 8232 | 8233 | 8239 | 8287 | 12288 | 65279)
}
fn matches(text: &[u16], start: usize, value: &str) -> bool {
    start + value.len() <= text.len()
        && value
            .bytes()
            .enumerate()
            .all(|(offset, byte)| text[start + offset] == byte as u16)
}
fn token_is(text: &[u16], token: &Token, value: &str) -> bool {
    token.end - token.start == value.len() && matches(text, token.start, value)
}

fn quoted_end(text: &[u16], start: usize, quote: u16, recursion: usize) -> Result<usize, ()> {
    if recursion > 256 {
        return Err(());
    }
    let mut i = start + 1;
    while i < text.len() {
        if text[i] == 92 {
            i += 2;
            continue;
        }
        if quote != 39 && matches(text, i, "#{") {
            let mut depth = 1;
            i += 2;
            while i < text.len() && depth > 0 {
                if matches!(text[i], 34 | 39 | 96) {
                    i = quoted_end(text, i, text[i], recursion + 1)?;
                } else if text[i] == 92 {
                    i += 2;
                } else {
                    if text[i] == 123 {
                        depth += 1;
                    } else if text[i] == 125 {
                        depth -= 1;
                    }
                    i += 1;
                }
            }
            continue;
        }
        let ch = text[i];
        i += 1;
        if ch == quote {
            return Ok(i);
        }
    }
    Ok(text.len())
}

fn heredoc_at(text: &[u16], start: usize) -> Option<(usize, Vec<u16>, bool)> {
    if !matches(text, start, "<<") {
        return None;
    }
    let mut i = start + 2;
    let indented = matches!(at(text, i), 45 | 126);
    if indented {
        i += 1;
    }
    let quote = if matches!(at(text, i), 34 | 39 | 96) {
        let quote = text[i];
        i += 1;
        Some(quote)
    } else {
        None
    };
    let marker_start = i;
    if !name_start(at(text, i)) {
        return None;
    }
    i += 1;
    while word(at(text, i)) {
        i += 1;
    }
    let marker = text[marker_start..i].to_vec();
    if let Some(quote) = quote {
        if at(text, i) != quote {
            return None;
        }
        i += 1;
    }
    Some((i, marker, indented))
}

fn percent_end(text: &[u16], start: usize) -> Result<Option<usize>, ()> {
    if at(text, start) != 37 {
        return Ok(None);
    }
    let mut i = start + 1;
    if matches!(
        at(text, i),
        113 | 81 | 119 | 87 | 105 | 73 | 114 | 120 | 115
    ) {
        i += 1;
    }
    if i >= text.len() {
        return Ok(None);
    }
    let delimiter = text[i];
    if word(delimiter) || whitespace(delimiter) || delimiter == 61 {
        return Ok(None);
    }
    let close = match delimiter {
        40 => 41,
        91 => 93,
        123 => 125,
        60 => 62,
        _ => delimiter,
    };
    let mut depth = 1;
    i += 1;
    while i < text.len() && depth > 0 {
        if text[i] == 92 {
            i += 2;
            continue;
        }
        if delimiter != close && text[i] == delimiter {
            depth += 1;
        } else if text[i] == close {
            depth -= 1;
        }
        i += 1;
    }
    // The reference lexer can overrun by one UTF-16 unit on a trailing escape.
    // Request the reference path for that malformed shape rather than alter its offsets.
    if i > text.len() {
        return Err(());
    }
    Ok(Some(i))
}

fn global_end(text: &[u16], start: usize) -> Option<usize> {
    if at(text, start) != 36 || start + 1 >= text.len() {
        return None;
    }
    let ch = text[start + 1];
    let mut end = start + 2;
    if name_start(ch) {
        while word(at(text, end)) {
            end += 1;
        }
    } else if digit(ch) {
        while digit(at(text, end)) {
            end += 1;
        }
    } else if whitespace(ch) {
        return None;
    }
    Some(end)
}

fn number_end(text: &[u16], start: usize) -> Option<usize> {
    if !digit(at(text, start)) {
        return None;
    }
    let hex =
        |ch: u16| digit(ch) || (65..=70).contains(&ch) || (97..=102).contains(&ch) || ch == 95;
    if at(text, start) == 48
        && matches!(at(text, start + 1), 120 | 88 | 111 | 79 | 98 | 66)
        && hex(at(text, start + 2))
    {
        let mut end = start + 3;
        while hex(at(text, end)) {
            end += 1;
        }
        return Some(end);
    }
    let mut end = start + 1;
    while digit(at(text, end)) || at(text, end) == 95 {
        end += 1;
    }
    if at(text, end) == 46 && digit(at(text, end + 1)) {
        end += 2;
        while digit(at(text, end)) || at(text, end) == 95 {
            end += 1;
        }
    }
    if matches!(at(text, end), 101 | 69) {
        let mut exponent = end + 1;
        if matches!(at(text, exponent), 43 | 45) {
            exponent += 1;
        }
        if digit(at(text, exponent)) {
            end = exponent + 1;
            while digit(at(text, end)) {
                end += 1;
            }
        }
    }
    if matches!(at(text, end), 114 | 82 | 105 | 73) {
        end += 1;
    }
    Some(end)
}

fn push(
    tokens: &mut Vec<Token>,
    text: &[u16],
    i: &mut usize,
    line: &mut usize,
    column: &mut usize,
    kind: &'static str,
    end: usize,
) -> Result<(), ()> {
    if tokens.len() >= MAX_TOKENS || end > text.len() {
        return Err(());
    }
    tokens.push(Token {
        kind,
        start: *i,
        end,
        line: *line,
        column: *column,
    });
    while *i < end {
        if text[*i] == 10 {
            *line += 1;
            *column = 0;
        } else {
            *column += 1;
        }
        *i += 1;
    }
    Ok(())
}

fn tokenize(source: &str) -> Result<Vec<Token>, ()> {
    let text: Vec<u16> = source.encode_utf16().collect();
    let mut tokens: Vec<Token> = Vec::new();
    let mut heredocs: VecDeque<(Vec<u16>, bool)> = VecDeque::new();
    let (mut i, mut line, mut column) = (0, 0, 0);
    let mut previous: Option<usize> = None;
    while i < text.len() {
        let ch = text[i];
        if matches!(ch, 32 | 9 | 13) {
            i += 1;
            column += 1;
            continue;
        }
        if ch == 10 {
            let end = i + 1;
            push(
                &mut tokens,
                &text,
                &mut i,
                &mut line,
                &mut column,
                "newline",
                end,
            )?;
            while let Some((marker, indented)) = heredocs.pop_front() {
                let mut end = i;
                while end < text.len() {
                    let next = text[end..]
                        .iter()
                        .position(|ch| *ch == 10)
                        .map(|offset| end + offset)
                        .unwrap_or(text.len());
                    let mut value_end = next;
                    if value_end > end && text[value_end - 1] == 13 {
                        value_end -= 1;
                    }
                    let mut value_start = end;
                    if indented {
                        while value_start < value_end && whitespace(text[value_start]) {
                            value_start += 1;
                        }
                    }
                    let terminal = text[value_start..value_end] == marker;
                    end = if next < text.len() { next + 1 } else { next };
                    if terminal {
                        break;
                    }
                }
                push(
                    &mut tokens,
                    &text,
                    &mut i,
                    &mut line,
                    &mut column,
                    "literal",
                    end,
                )?;
                previous = Some(tokens.len() - 1);
            }
            continue;
        }
        let (kind, end) = if column == 0
            && matches(&text, i, "__END__")
            && (i + 7 == text.len()
                || at(&text, i + 7) == 10
                || (at(&text, i + 7) == 13 && at(&text, i + 8) == 10))
        {
            ("literal", text.len())
        } else if column == 0
            && matches(&text, i, "=begin")
            && (i + 6 == text.len() || whitespace(at(&text, i + 6)))
        {
            let mut end = text.len();
            for scan in i + 6..text.len() {
                if (scan == i + 6 || matches!(text[scan - 1], 10 | 13 | 8232 | 8233))
                    && matches(&text, scan, "=end")
                {
                    end = text[scan..]
                        .iter()
                        .position(|ch| *ch == 10)
                        .map(|offset| scan + offset + 1)
                        .unwrap_or(text.len());
                    break;
                }
            }
            ("comment", end)
        } else if ch == 35 {
            (
                "comment",
                text[i..]
                    .iter()
                    .position(|ch| *ch == 10)
                    .map(|offset| i + offset)
                    .unwrap_or(text.len()),
            )
        } else if matches!(ch, 34 | 39 | 96) {
            ("literal", quoted_end(&text, i, ch, 0)?)
        } else if let Some((end, marker, indented)) = heredoc_at(&text, i) {
            heredocs.push_back((marker, indented));
            ("literal", end)
        } else if let Some(end) = percent_end(&text, i)? {
            ("literal", end)
        } else if ch == 58
            && at(&text, i + 1) != 58
            && (name_start(at(&text, i + 1)) || at(&text, i + 1) == 64)
            && !tokens
                .last()
                .map(|token| token.end == i && token.kind == "identifier")
                .unwrap_or(false)
        {
            let mut end = i + 2;
            while word(at(&text, end)) {
                end += 1;
            }
            if matches!(at(&text, end), 33 | 63 | 61) {
                end += 1;
            }
            ("symbol", end)
        } else if let Some(end) = global_end(&text, i) {
            ("globalVariable", end)
        } else {
            let significant = previous.map(|index| &tokens[index]);
            let regex_candidate = ch == 47
                && at(&text, i + 1) != 61
                && (significant.is_none()
                    || significant
                        .map(|token| STARTS.iter().any(|value| token_is(&text, token, value)))
                        .unwrap_or(false)
                    || (i > 0 && whitespace(text[i - 1]) && !whitespace(at(&text, i + 1))));
            let mut regex_end = None;
            if regex_candidate {
                let mut end = i + 1;
                let mut character_class = false;
                while end < text.len() && text[end] != 10 {
                    if text[end] == 92 {
                        end += 2;
                        continue;
                    }
                    if text[end] == 91 {
                        character_class = true;
                    } else if text[end] == 93 {
                        character_class = false;
                    }
                    let current = text[end];
                    end += 1;
                    if current == 47 && !character_class {
                        while alpha(at(&text, end)) {
                            end += 1;
                        }
                        regex_end = Some(end);
                        break;
                    }
                }
            }
            if let Some(end) = regex_end {
                ("literal", end)
            } else {
                let mut end = i;
                let instance = ch == 64;
                if instance {
                    end += 1;
                    if at(&text, end) == 64 {
                        end += 1;
                    }
                }
                if name_start(at(&text, end)) {
                    end += 1;
                    while word(at(&text, end)) {
                        end += 1;
                    }
                    if !instance && matches!(at(&text, end), 33 | 63) {
                        end += 1;
                    }
                    let receiver = significant
                        .map(|token| token_is(&text, token, ".") || token_is(&text, token, "&."))
                        .unwrap_or(false);
                    let label = at(&text, end) == 58 && at(&text, end + 1) != 58;
                    let keyword = !receiver
                        && !label
                        && KEYWORDS
                            .iter()
                            .any(|value| value.len() == end - i && matches(&text, i, value));
                    (
                        if instance {
                            "instanceVariable"
                        } else if (65..=90).contains(&ch) {
                            "constant"
                        } else if keyword {
                            "keyword"
                        } else {
                            "identifier"
                        },
                        end,
                    )
                } else if let Some(end) = number_end(&text, i) {
                    ("number", end)
                } else {
                    (
                        "operator",
                        i + OPERATORS
                            .iter()
                            .find(|value| matches(&text, i, value))
                            .map(|value| value.len())
                            .unwrap_or(1),
                    )
                }
            }
        };
        push(
            &mut tokens,
            &text,
            &mut i,
            &mut line,
            &mut column,
            kind,
            end,
        )?;
        if kind != "comment" && kind != "newline" {
            previous = Some(tokens.len() - 1);
        }
    }
    Ok(tokens)
}

fn respond(writer: &mut impl Write, id: u64, tokens: Result<Vec<Token>, ()>) -> io::Result<()> {
    match tokens {
        Err(()) => writeln!(writer, "{{\"id\":{},\"fallback\":true,\"tokens\":[]}}", id),
        Ok(tokens) => {
            write!(writer, "{{\"id\":{},\"tokens\":[", id)?;
            for (index, token) in tokens.iter().enumerate() {
                if index > 0 {
                    write!(writer, ",")?;
                }
                write!(
                    writer,
                    "[\"{}\",{},{},{},{}]",
                    token.kind, token.start, token.end, token.line, token.column
                )?;
            }
            writeln!(writer, "]}}")
        }
    }?;
    writer.flush()
}

fn kind_id(kind: &str) -> u8 {
    match kind {
        "identifier" => 1,
        "constant" => 2,
        "keyword" => 3,
        "instanceVariable" => 4,
        "number" => 5,
        "literal" => 6,
        "symbol" => 7,
        "operator" => 8,
        "newline" => 9,
        "comment" => 10,
        "globalVariable" => 11,
        _ => unreachable!("unregistered native token kind"),
    }
}

fn respond_binary(
    writer: &mut impl Write,
    id: u64,
    tokens: Result<Vec<Token>, ()>,
) -> io::Result<()> {
    match tokens {
        Err(()) => writeln!(writer, "{} 0 1", id)?,
        Ok(tokens) => {
            // Input and token budgets keep every offset within u32 and this allocation bounded.
            let mut payload = Vec::with_capacity(64 + tokens.len() * 17);
            writeln!(&mut payload, "{} {} 0", id, tokens.len())?;
            for token in tokens {
                payload.push(kind_id(token.kind));
                payload.extend_from_slice(&(token.start as u32).to_le_bytes());
                payload.extend_from_slice(&(token.end as u32).to_le_bytes());
                payload.extend_from_slice(&(token.line as u32).to_le_bytes());
                payload.extend_from_slice(&(token.column as u32).to_le_bytes());
            }
            writer.write_all(&payload)?;
        }
    }
    writer.flush()
}

fn worker(binary: bool) -> io::Result<()> {
    let stdin = io::stdin();
    let mut reader = stdin.lock();
    let stdout = io::stdout();
    let mut writer = BufWriter::new(stdout.lock());
    loop {
        let mut header = Vec::new();
        let size = reader.by_ref().take(129).read_until(b'\n', &mut header)?;
        if size == 0 {
            return Ok(());
        }
        if header.last() != Some(&b'\n') || header.len() > 128 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid native lexer frame header",
            ));
        }
        if !header.is_ascii() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "non-ASCII frame header",
            ));
        }
        let header = std::str::from_utf8(&header)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "non-ASCII frame header"))?;
        let mut fields = header.strip_suffix('\n').unwrap().split(' ');
        let id = fields
            .next()
            .filter(|value| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
            .and_then(|value| value.parse::<u64>().ok());
        let length = fields
            .next()
            .filter(|value| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
            .and_then(|value| value.parse::<usize>().ok());
        if fields.next().is_some() || id.is_none() || length.is_none() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid frame id or byte length",
            ));
        }
        let (id, length) = (id.unwrap(), length.unwrap());
        if length > MAX_INPUT {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "native lexer input exceeds 16 MiB",
            ));
        }
        let mut bytes = vec![0; length];
        reader.read_exact(&mut bytes)?;
        let tokens = std::str::from_utf8(&bytes)
            .map_err(|_| ())
            .and_then(tokenize);
        if binary {
            respond_binary(&mut writer, id, tokens)?;
        } else {
            respond(&mut writer, id, tokens)?;
        }
    }
}

fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    if let [mode, archive, destination, root] = arguments.as_slice() {
        if mode == "--extract-ruby-sdk" {
            if let Err(error) = sdk_archive::extract(
                std::path::Path::new(archive),
                std::path::Path::new(destination),
                root,
            ) {
                eprintln!("Ruby Studio SDK extraction: {}", error);
                std::process::exit(1);
            }
            return;
        }
    }
    let binary = arguments.as_slice() == ["--binary"];
    if !arguments.is_empty() && !binary {
        eprintln!("Ruby Studio native lexer: expected no arguments or --binary");
        std::process::exit(2);
    }
    if let Err(error) = worker(binary) {
        eprintln!("Ruby Studio native lexer: {}", error);
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn utf16_columns_and_lines() {
        let tokens = tokenize("😀 x\n@v = 'é'\n").unwrap();
        assert_eq!(
            tokens
                .iter()
                .map(|token| (token.kind, token.start, token.end, token.line, token.column))
                .collect::<Vec<_>>(),
            vec![
                ("operator", 0, 1, 0, 0),
                ("operator", 1, 2, 0, 1),
                ("identifier", 3, 4, 0, 3),
                ("newline", 4, 5, 0, 4),
                ("instanceVariable", 5, 7, 1, 0),
                ("operator", 8, 9, 1, 3),
                ("literal", 10, 13, 1, 5),
                ("newline", 13, 14, 1, 8)
            ]
        );
    }
    #[test]
    fn heredoc_body_is_not_code() {
        let tokens = tokenize("x = <<~TEXT\n  class Fake\n  TEXT\nreal\n").unwrap();
        assert_eq!(
            tokens
                .iter()
                .filter(|token| token.kind == "identifier")
                .count(),
            2
        );
        assert_eq!(
            tokens
                .iter()
                .filter(|token| token.kind == "literal")
                .count(),
            2
        );
    }
    #[test]
    fn malformed_percent_escape_requests_fallback() {
        assert!(tokenize("%q{\\").is_err());
    }
}
