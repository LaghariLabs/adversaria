//! Parse file-shaped deliverables from local-model workspace answers.

use std::collections::HashSet;
use std::sync::OnceLock;

use regex::Regex;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutputFile {
    pub name: String,
    pub content: String,
}

#[derive(Debug)]
struct Candidate {
    start: usize,
    end: usize,
    name: String,
    content: String,
}

#[derive(Clone, Copy)]
struct LineSpan {
    start: usize,
    content_end: usize,
    end: usize,
}

fn strict_marker() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?im)^[ \t]*={2,}[ \t]*file:[ \t]*(?P<name>[^=\r\n]+?)[ \t]*={2,}[ \t]*\r?$")
            .expect("strict local-output marker regex must compile")
    })
}

fn line_spans(value: &str, start: usize, end: usize) -> Vec<LineSpan> {
    let mut lines = Vec::new();
    let mut cursor = start;
    while cursor < end {
        let (line_end, full_end) = match value[cursor..end].find('\n') {
            Some(offset) => (cursor + offset, cursor + offset + 1),
            None => (end, end),
        };
        let content_end = if line_end > cursor && value.as_bytes()[line_end - 1] == b'\r' {
            line_end - 1
        } else {
            line_end
        };
        lines.push(LineSpan {
            start: cursor,
            content_end,
            end: full_end,
        });
        cursor = full_end;
    }
    lines
}

fn line_text<'a>(value: &'a str, line: &LineSpan) -> &'a str {
    &value[line.start..line.content_end]
}

fn trim_single_newline(mut value: &str) -> &str {
    if let Some(rest) = value.strip_prefix("\r\n") {
        value = rest;
    } else if let Some(rest) = value.strip_prefix(['\r', '\n']) {
        value = rest;
    }

    if let Some(rest) = value.strip_suffix("\r\n") {
        rest
    } else if let Some(rest) = value.strip_suffix(['\r', '\n']) {
        rest
    } else {
        value
    }
}

fn is_fence_open(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed.starts_with("```") && !trimmed.starts_with("````") && !trimmed[3..].contains('`')
}

fn unwrap_single_fence(value: &str) -> Option<&str> {
    let lines = line_spans(value, 0, value.len());
    if lines.len() < 2 || !is_fence_open(line_text(value, &lines[0])) {
        return None;
    }
    let close = lines
        .iter()
        .enumerate()
        .skip(1)
        .find(|(_, line)| line_text(value, line).trim() == "```")?
        .0;
    if close + 1 != lines.len() {
        return None;
    }
    Some(&value[lines[0].end..lines[close].start])
}

fn file_content(raw: &str, unwrap_fence: bool) -> String {
    let trimmed = trim_single_newline(raw);
    if unwrap_fence {
        if let Some(content) = unwrap_single_fence(trimmed) {
            return trim_single_newline(content).to_string();
        }
    }
    trimmed.to_string()
}

fn sanitize_name(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() || raw.contains("..") {
        return None;
    }
    let name = raw.rsplit(['/', '\\']).next()?.trim();
    if name.is_empty() || name.starts_with('.') {
        return None;
    }
    Some(name.to_string())
}

fn known_extension(name: &str) -> bool {
    let extension = name.rsplit_once('.').map(|(_, extension)| extension);
    extension.is_some_and(|extension| {
        matches!(
            extension.to_ascii_lowercase().as_str(),
            "drawio"
                | "md"
                | "markdown"
                | "txt"
                | "json"
                | "csv"
                | "yaml"
                | "yml"
                | "svg"
                | "html"
                | "mmd"
        )
    })
}

fn strip_prefix_case_insensitive<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    value
        .get(..prefix.len())
        .filter(|head| head.eq_ignore_ascii_case(prefix))
        .map(|_| &value[prefix.len()..])
}

fn lenient_name(line: &str) -> Option<String> {
    let mut value = line.trim();
    if let Some(rest) = strip_prefix_case_insensitive(value, "filename:") {
        value = rest.trim();
    } else if let Some(rest) = strip_prefix_case_insensitive(value, "file:") {
        value = rest.trim();
    }

    if let Some(rest) = value.strip_prefix("##") {
        value = rest.trim();
    } else if let Some(rest) = value.strip_prefix('#') {
        value = rest.trim();
    }

    value = value.strip_suffix(':').unwrap_or(value).trim();
    if value.starts_with("**") {
        value = value.strip_prefix("**").unwrap_or(value).trim();
        value = value.strip_suffix("**").unwrap_or(value).trim();
    }
    if value.starts_with('`') {
        value = value.strip_prefix('`').unwrap_or(value).trim();
        value = value.strip_suffix('`').unwrap_or(value).trim();
    }
    value = value.strip_suffix(':').unwrap_or(value).trim();

    let name = sanitize_name(value)?;
    known_extension(&name).then_some(name)
}

fn scan_lenient(value: &str, start: usize, end: usize, candidates: &mut Vec<Candidate>) {
    let lines = line_spans(value, start, end);
    let mut index = 0;
    while index < lines.len() {
        let Some(name) = lenient_name(line_text(value, &lines[index])) else {
            index += 1;
            continue;
        };

        let mut opening = index + 1;
        while opening < lines.len() && line_text(value, &lines[opening]).trim().is_empty() {
            opening += 1;
        }
        if opening == lines.len() || !is_fence_open(line_text(value, &lines[opening])) {
            index += 1;
            continue;
        }

        let Some(closing) = ((opening + 1)..lines.len())
            .find(|line| line_text(value, &lines[*line]).trim() == "```")
        else {
            index += 1;
            continue;
        };

        candidates.push(Candidate {
            start: lines[index].start,
            end: lines[closing].end,
            name,
            content: file_content(&value[lines[opening].end..lines[closing].start], false),
        });
        index = closing + 1;
    }
}

fn unique_name(name: String, seen: &mut HashSet<String>) -> String {
    if seen.insert(name.to_ascii_lowercase()) {
        return name;
    }

    let (stem, extension) = match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => (stem, Some(extension)),
        _ => (name.as_str(), None),
    };
    for suffix in 2.. {
        let candidate = match extension {
            Some(extension) => format!("{stem}-{suffix}.{extension}"),
            None => format!("{stem}-{suffix}"),
        };
        if seen.insert(candidate.to_ascii_lowercase()) {
            return candidate;
        }
    }
    unreachable!()
}

fn collapse_blank_lines(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut consecutive_blank = 0usize;
    for line in value.split_inclusive('\n') {
        let body = line.strip_suffix('\n').unwrap_or(line);
        let body = body.strip_suffix('\r').unwrap_or(body);
        if body.trim().is_empty() {
            consecutive_blank += 1;
            if consecutive_blank > 2 {
                continue;
            }
        } else {
            consecutive_blank = 0;
        }
        result.push_str(line);
    }
    result
}

/// Split a local model's answer into files and unclaimed prose.
pub fn split_output(answer: &str) -> (Vec<OutputFile>, String) {
    let markers = strict_marker()
        .captures_iter(answer)
        .filter_map(|captures| {
            Some((
                captures.get(0)?,
                captures.name("name")?.as_str().to_string(),
            ))
        })
        .collect::<Vec<_>>();

    let mut candidates = Vec::new();
    let mut strict_ranges = Vec::new();
    for (index, (marker, raw_name)) in markers.iter().enumerate() {
        let end = markers
            .get(index + 1)
            .map_or(answer.len(), |(next, _)| next.start());
        strict_ranges.push((marker.start(), end));
        if let Some(name) = sanitize_name(raw_name) {
            candidates.push(Candidate {
                start: marker.start(),
                end,
                name,
                content: file_content(&answer[marker.end()..end], true),
            });
        }
    }

    let mut cursor = 0usize;
    for (start, end) in &strict_ranges {
        if cursor < *start {
            scan_lenient(answer, cursor, *start, &mut candidates);
        }
        cursor = *end;
    }
    if cursor < answer.len() {
        scan_lenient(answer, cursor, answer.len(), &mut candidates);
    }

    candidates.sort_by_key(|candidate| candidate.start);
    if candidates.is_empty() {
        return (Vec::new(), answer.to_string());
    }

    let mut seen = HashSet::new();
    let mut files = Vec::with_capacity(candidates.len());
    let mut remainder = String::new();
    let mut remainder_cursor = 0usize;
    for candidate in candidates {
        remainder.push_str(&answer[remainder_cursor..candidate.start]);
        remainder_cursor = candidate.end;
        files.push(OutputFile {
            name: unique_name(candidate.name, &mut seen),
            content: candidate.content,
        });
    }
    remainder.push_str(&answer[remainder_cursor..]);

    (files, collapse_blank_lines(&remainder))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_one_strict_file() {
        let (files, remainder) = split_output("=== FILE: notes.md ===\n# Notes\n");

        assert_eq!(
            files,
            vec![OutputFile {
                name: "notes.md".to_string(),
                content: "# Notes".to_string(),
            }]
        );
        assert_eq!(remainder, "");
    }

    #[test]
    fn trims_only_one_newline_from_file_content() {
        let (files, remainder) = split_output("=== FILE: notes.md ===\n\n# Notes\n\n");

        assert_eq!(files[0].content, "\n# Notes\n");
        assert_eq!(remainder, "");
    }

    #[test]
    fn splits_multiple_strict_files_and_unwraps_fences() {
        let answer = "== FILE: path/notes.md ==\n```markdown\n# Notes\n```\n=== file: data.json ===\n```json\n{\"ok\":true}\n```\n";
        let (files, remainder) = split_output(answer);

        assert_eq!(
            files,
            vec![
                OutputFile {
                    name: "notes.md".to_string(),
                    content: "# Notes".to_string(),
                },
                OutputFile {
                    name: "data.json".to_string(),
                    content: "{\"ok\":true}".to_string(),
                },
            ]
        );
        assert_eq!(remainder, "");
    }

    #[test]
    fn splits_lenient_drawio_output_from_the_live_shape() {
        let answer = "path/adversaria.drawio\n\n```xml\n<mxfile host=\"app.diagrams.net\"><diagram id=\"page1\"/></mxfile>\n```\n";
        let (files, remainder) = split_output(answer);

        assert_eq!(files.len(), 1);
        assert_eq!(files[0].name, "adversaria.drawio");
        assert_eq!(
            files[0].content,
            "<mxfile host=\"app.diagrams.net\"><diagram id=\"page1\"/></mxfile>"
        );
        assert_eq!(remainder, "");
    }

    #[test]
    fn unknown_lenient_extension_is_not_a_file() {
        let answer = "archive.zip\n```text\ncontents\n```\n";
        assert_eq!(split_output(answer), (Vec::new(), answer.to_string()));
    }

    #[test]
    fn rejects_parent_path_names() {
        let answer = "=== FILE: ../secret.md ===\nshould stay in the remainder\n";
        assert_eq!(split_output(answer), (Vec::new(), answer.to_string()));
    }

    #[test]
    fn suffixes_colliding_names() {
        let answer = "=== FILE: report.md ===\none\n=== FILE: path/report.md ===\ntwo\n=== FILE: REPORT.md ===\nthree";
        let (files, _) = split_output(answer);

        assert_eq!(
            files
                .iter()
                .map(|file| file.name.as_str())
                .collect::<Vec<_>>(),
            ["report.md", "report-2.md", "REPORT-3.md"]
        );
    }

    #[test]
    fn remainder_keeps_prose_before_and_after_a_lenient_block() {
        let answer = "Before the file.\nresult.json\n```json\n{}\n```\nAfter the file.";
        let (files, remainder) = split_output(answer);

        assert_eq!(files[0].name, "result.json");
        assert_eq!(remainder, "Before the file.\nAfter the file.");
    }

    #[test]
    fn no_markers_returns_the_whole_answer() {
        let answer = "A plain Markdown answer.\n\n\n\nStill the same answer.";
        assert_eq!(split_output(answer), (Vec::new(), answer.to_string()));
    }
}
