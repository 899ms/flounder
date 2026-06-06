export interface LocationRange {
  pathHint: string;
  startLine: number;
  endLine: number;
}

export function parseLocationRanges(location: string): LocationRange[] {
  const ranges: LocationRange[] = [];
  let activePath: string | undefined;

  for (const rawSegment of location.split(/\s*[,;]\s*/)) {
    const segment = rawSegment.trim();
    if (!segment) continue;

    const withPath = /^(.*):\s*(\d+)(?:\s*-\s*(\d+))?$/.exec(segment);
    const continuation = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(segment);
    const match = withPath ?? continuation;
    if (!match) continue;

    const pathHint = withPath ? match[1]?.trim() : activePath;
    const startLine = Number.parseInt(withPath ? (match[2] ?? "") : (match[1] ?? ""), 10);
    const rawEnd = Number.parseInt(withPath ? (match[3] ?? "") : (match[2] ?? ""), 10);
    const endLine = Number.isFinite(rawEnd) ? rawEnd : startLine;
    if (!pathHint || !Number.isFinite(startLine) || !Number.isFinite(endLine)) continue;

    activePath = pathHint;
    ranges.push({
      pathHint,
      startLine: Math.min(startLine, endLine),
      endLine: Math.max(startLine, endLine),
    });
  }

  return ranges;
}

export function locationContainsLine(location: string, line: number, filePattern?: RegExp): boolean {
  if (!Number.isFinite(line) || line < 1) return false;
  return parseLocationRanges(location).some((range) => {
    if (filePattern && !filePattern.test(range.pathHint)) return false;
    return line >= range.startLine && line <= range.endLine;
  });
}
