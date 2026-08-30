// ABOUTME: Normalizes imported Markdown to one title-owned H1 and a safe portable subset.
// ABOUTME: Detects unsupported HTML or MDX while preserving fenced and inline code examples.
import { toString } from "mdast-util-to-string";

import { parseArticleMarkdown } from "@/content/runtime-mdx-plugins";

export type MarkdownHeading = {
  title: string;
  line: number;
  startIndex: number;
  endIndex: number;
  style: "atx" | "setext";
};

export type MarkdownChange = {
  kind: "demoted-heading" | "inserted-title";
  line?: number;
  message: string;
};

export type UnsupportedMarkup = {
  line: number;
  message: string;
};

function plainHeading(value: string) {
  const tree = parseArticleMarkdown(`# ${value}\n`);
  const heading = tree.children[0];
  return heading ? toString(heading).replace(/\s+/gu, " ").trim() : "";
}

function comparableHeading(value: string) {
  return plainHeading(value).toLocaleLowerCase("en-US");
}

export function escapeMarkdownHeading(value: string) {
  return [...value]
    .map((character) =>
      /^[\p{Letter}\p{Number} ]$/u.test(character)
        ? character
        : `&#${character.codePointAt(0)};`,
    )
    .join("");
}

function maskInlineCode(line: string) {
  const characters = line.split("");
  let offset = 0;

  while (offset < line.length) {
    if (line[offset] !== "`") {
      offset += 1;
      continue;
    }

    let markerEnd = offset;
    while (line[markerEnd] === "`") {
      markerEnd += 1;
    }
    const marker = line.slice(offset, markerEnd);
    const closing = line.indexOf(marker, markerEnd);
    if (closing < 0) {
      break;
    }

    for (let index = offset; index < closing + marker.length; index += 1) {
      characters[index] = " ";
    }
    offset = closing + marker.length;
  }

  return characters.join("");
}

function forContentLines(source: string, inspect: (line: string, index: number) => void) {
  const lines = source.replace(/\r\n?/gu, "\n").split("\n");
  let fence: { marker: string; length: number } | null = null;

  for (const [index, line] of lines.entries()) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      const length = fenceMatch[1].length;
      if (fence === null) {
        fence = { marker, length };
      } else if (fence.marker === marker && length >= fence.length) {
        fence = null;
      }
      continue;
    }

    if (fence === null) {
      inspect(line, index);
    }
  }

  return lines;
}

export function findLevelOneHeadings(source: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  const lines = forContentLines(source, (line, index) => {
    const atx = /^ {0,3}#[ \t]+(.+?)[ \t]*#*[ \t]*$/u.exec(line);
    if (atx) {
      headings.push({
        title: plainHeading(atx[1]),
        line: index + 1,
        startIndex: index,
        endIndex: index,
        style: "atx",
      });
    }
  });

  let fence: { marker: string; length: number } | null = null;
  for (let index = 0; index < lines.length - 1; index += 1) {
    const line = lines[index];
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      const length = fenceMatch[1].length;
      if (fence === null) {
        fence = { marker, length };
      } else if (fence.marker === marker && length >= fence.length) {
        fence = null;
      }
      continue;
    }

    if (
      fence === null &&
      line.trim().length > 0 &&
      !/^ {0,3}#/u.test(line) &&
      /^ {0,3}=+[ \t]*$/u.test(lines[index + 1])
    ) {
      headings.push({
        title: plainHeading(line.trim()),
        line: index + 1,
        startIndex: index,
        endIndex: index + 1,
        style: "setext",
      });
      index += 1;
    }
  }

  return headings.sort((left, right) => left.startIndex - right.startIndex);
}

export function findUnsupportedMarkup(source: string): UnsupportedMarkup[] {
  const issues: UnsupportedMarkup[] = [];

  forContentLines(source, (line, index) => {
    const visible = maskInlineCode(line);
    let message: string | null = null;

    if (/^ {0,3}(?:import|export)(?:[ \t]|$)/u.test(visible)) {
      message = "Imports and exports are not supported in imported Markdown.";
    } else if (/<!--|<>|<\/>|<\/?[A-Za-z][A-Za-z\d.-]*(?:[ \t]|\/?>)/u.test(visible)) {
      message = "Custom HTML and JSX elements are not supported in imported Markdown.";
    } else if (/\{%[\s\S]*?%\}/u.test(visible)) {
      message = "GitBook template blocks require manual conversion before import.";
    }

    if (message) {
      issues.push({ line: index + 1, message });
    }
  });

  return issues;
}

export function normalizeTitleHeading(
  source: string,
  title: string,
  originalLineOffset = 0,
) {
  const lines = source.replace(/\r\n?/gu, "\n").split("\n");
  const headings = findLevelOneHeadings(source);
  const changes: MarkdownChange[] = [];
  const firstHeading = headings[0];
  const titleOwned =
    firstHeading !== undefined && comparableHeading(firstHeading.title) === comparableHeading(title);

  for (const [index, heading] of headings.entries()) {
    if (index === 0 && titleOwned) {
      for (let lineIndex = heading.startIndex; lineIndex <= heading.endIndex; lineIndex += 1) {
        lines[lineIndex] = "";
      }
      continue;
    }

    if (heading.style === "atx") {
      lines[heading.startIndex] = lines[heading.startIndex].replace(/^( {0,3})#(?=[ \t])/u, "$1##");
    } else {
      lines[heading.endIndex] = lines[heading.endIndex].replace(/=/gu, "-");
    }
    changes.push({
      kind: "demoted-heading",
      line: originalLineOffset + heading.line,
      message: `Demoted secondary H1 ${JSON.stringify(heading.title)} to H2.`,
    });
  }

  if (!titleOwned) {
    changes.push({
      kind: "inserted-title",
      message: `Inserted the article-owned H1 ${JSON.stringify(title)}.`,
    });
  }

  const body = lines.join("\n").trim();
  return {
    markdown: body
      ? `# ${escapeMarkdownHeading(title)}\n\n${body}\n`
      : `# ${escapeMarkdownHeading(title)}\n`,
    changes,
  };
}
