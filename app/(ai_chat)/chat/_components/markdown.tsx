import * as React from "react"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@boilerplate/ui"

import { CodeBlock } from "./code-block"

/*
 * A small Markdown renderer for assistant replies: headings, paragraphs,
 * emphasis, inline code, links, fenced code blocks, ordered and unordered
 * (nested) lists, block quotes, rules and GFM tables. It builds React
 * elements, never HTML strings, so model output cannot inject markup.
 * Unclosed code fences render as code, which keeps streaming output stable.
 */

type Align = "left" | "center" | "right" | null
type Block =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "code"; language: string; code: string }
  | { type: "list"; ordered: boolean; start: number; items: Block[][] }
  | { type: "blockquote"; blocks: Block[] }
  | { type: "rule" }
  | { type: "table"; header: string[]; align: Align[]; rows: string[][] }

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/
const LIST_ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])(\s+|$)(.*)$/
const QUOTE = /^ {0,3}>\s?(.*)$/
const TABLE_DIVIDER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

function splitRow(line: string): string[] {
  let row = line.trim()
  if (row.startsWith("|")) row = row.slice(1)
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1)
  const cells: string[] = []
  let current = ""
  let inCode = false
  for (let i = 0; i < row.length; i++) {
    const char = row[i]
    if (char === "\\" && row[i + 1] === "|") {
      current += "|"
      i++
    } else if (char === "`") {
      inCode = !inCode
      current += char
    } else if (char === "|" && !inCode) {
      cells.push(current.trim())
      current = ""
    } else {
      current += char
    }
  }
  cells.push(current.trim())
  return cells
}

function startsBlock(line: string) {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || LIST_ITEM.test(line)
}

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n")
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }

    const fence = FENCE.exec(line)
    if (fence) {
      const marker = fence[1]
      const code: string[] = []
      i++
      while (i < lines.length && !lines[i].trimStart().startsWith(marker)) code.push(lines[i++])
      i++ // closing fence (or end of input while streaming)
      blocks.push({ type: "code", language: fence[2], code: code.join("\n") })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2] })
      i++
      continue
    }

    if (RULE.test(line)) {
      blocks.push({ type: "rule" })
      i++
      continue
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = []
      while (i < lines.length && lines[i].trim()) {
        const match = QUOTE.exec(lines[i])
        quoted.push(match ? match[1] : lines[i])
        i++
      }
      blocks.push({ type: "blockquote", blocks: parseBlocks(quoted.join("\n")) })
      continue
    }

    if (line.includes("|") && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1])) {
      const header = splitRow(line)
      const align: Align[] = splitRow(lines[i + 1]).map((cell) =>
        cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : cell.startsWith(":") ? "left" : null
      )
      const rows: string[][] = []
      i += 2
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) rows.push(splitRow(lines[i++]))
      blocks.push({ type: "table", header, align, rows })
      continue
    }

    const item = LIST_ITEM.exec(line)
    if (item) {
      const ordered = /\d/.test(item[2])
      const baseIndent = item[1].length
      const items: string[][] = []
      let current: string[] = []
      let contentIndent = baseIndent + item[2].length + Math.max(1, Math.min(item[3].length, 4))
      current.push(item[4])
      i++

      while (i < lines.length) {
        const next = lines[i]
        const nextItem = LIST_ITEM.exec(next)
        if (nextItem && nextItem[1].length === baseIndent && /\d/.test(nextItem[2]) === ordered) {
          items.push(current)
          current = [nextItem[4]]
          contentIndent = baseIndent + nextItem[2].length + Math.max(1, Math.min(nextItem[3].length, 4))
          i++
          continue
        }
        if (!next.trim()) {
          // A blank line continues the list only when indented content or another item follows.
          const following = lines.slice(i + 1).find((l) => l.trim())
          const followingItem = following ? LIST_ITEM.exec(following) : null
          const continues =
            following !== undefined &&
            ((following.length - following.trimStart().length >= contentIndent) ||
              (followingItem !== null && followingItem[1].length === baseIndent && /\d/.test(followingItem[2]) === ordered))
          if (!continues) break
          current.push("")
          i++
          continue
        }
        const indent = next.length - next.trimStart().length
        if (indent >= contentIndent) {
          current.push(next.slice(contentIndent))
        } else if (indent > baseIndent && nextItem) {
          current.push(next.slice(Math.min(indent, contentIndent)))
        } else if (current[current.length - 1]?.trim() && !startsBlock(next)) {
          current.push(next.trim()) // lazy continuation of the item's paragraph
        } else {
          break
        }
        i++
      }
      items.push(current)
      blocks.push({
        type: "list",
        ordered,
        start: ordered ? Number.parseInt(item[2], 10) : 1,
        items: items.map((lines) => parseBlocks(lines.join("\n"))),
      })
      continue
    }

    const paragraph: string[] = [line]
    i++
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) {
      if (lines[i].includes("|") && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1])) break
      paragraph.push(lines[i++])
    }
    blocks.push({ type: "paragraph", text: paragraph.map((l) => l.trim()).join("\n") })
  }

  return blocks
}

// 1-2 code span, 3-4 link, 5 bold (**), 6 bold (__), 7 strikethrough,
// 8 italic (*), 9-10 italic (_) with the preceding character, 11 bare URL,
// 12 hard line break.
const INLINE =
  /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\[([^\]]+)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)|\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__|~~(?=\S)([\s\S]*?\S)~~|\*(?=[^\s*])([^*]*?[^\s*])\*|(^|[\s(])_(?=\S)([^_]*?\S)_(?=[\s).,;:!?]|$)|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])|( {2,}\n|\\\n)/

function safeHref(url: string): string | null {
  return /^(https?:|mailto:)/i.test(url) ? url : null
}

function renderInline(text: string, keyPrefix = "i"): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  let rest = text
  let index = 0

  while (rest) {
    const match = INLINE.exec(rest)
    if (!match) {
      nodes.push(rest)
      break
    }
    if (match.index > 0) nodes.push(rest.slice(0, match.index))
    const key = `${keyPrefix}-${index++}`

    if (match[1]) {
      nodes.push(
        <code key={key} className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-sm">
          {match[2].replace(/^ (.+) $/, "$1")}
        </code>
      )
    } else if (match[3] !== undefined) {
      const href = safeHref(match[4])
      nodes.push(
        href ? (
          <a key={key} href={href} target="_blank" rel="noreferrer noopener" className="font-medium text-primary underline underline-offset-4">
            {renderInline(match[3], key)}
          </a>
        ) : (
          <React.Fragment key={key}>{renderInline(match[3], key)}</React.Fragment>
        )
      )
    } else if (match[5] !== undefined || match[6] !== undefined) {
      nodes.push(
        <strong key={key} className="font-semibold">
          {renderInline(match[5] ?? match[6], key)}
        </strong>
      )
    } else if (match[7] !== undefined) {
      nodes.push(<del key={key}>{renderInline(match[7], key)}</del>)
    } else if (match[8] !== undefined) {
      nodes.push(<em key={key}>{renderInline(match[8], key)}</em>)
    } else if (match[10] !== undefined) {
      if (match[9]) nodes.push(match[9])
      nodes.push(<em key={key}>{renderInline(match[10], key)}</em>)
    } else if (match[11] !== undefined) {
      nodes.push(
        <a key={key} href={match[11]} target="_blank" rel="noreferrer noopener" className="break-all text-primary underline underline-offset-4">
          {match[11]}
        </a>
      )
    } else {
      nodes.push(<br key={key} />)
    }
    rest = rest.slice(match.index + match[0].length)
  }
  return nodes
}

const HEADING_CLASS: Record<number, string> = {
  1: "mt-6 text-2xl font-semibold tracking-tight first:mt-0",
  2: "mt-6 text-xl font-semibold tracking-tight first:mt-0",
  3: "mt-5 text-lg font-semibold first:mt-0",
  4: "mt-4 text-base font-semibold first:mt-0",
  5: "mt-4 text-sm font-semibold first:mt-0",
  6: "mt-4 text-sm font-semibold text-muted-foreground first:mt-0",
}

function renderBlocks(blocks: Block[], keyPrefix: string, trailing?: React.ReactNode, tight = false): React.ReactNode[] {
  return blocks.map((block, index) => {
    const key = `${keyPrefix}-${index}`
    const isLast = index === blocks.length - 1
    const tail = isLast ? trailing : null

    switch (block.type) {
      case "heading": {
        const Tag = `h${block.level}` as "h1"
        return (
          <Tag key={key} className={HEADING_CLASS[block.level]}>
            {renderInline(block.text, key)}
            {tail}
          </Tag>
        )
      }
      case "paragraph":
        return tight ? (
          <React.Fragment key={key}>
            {renderInline(block.text, key)}
            {tail}
          </React.Fragment>
        ) : (
          <p key={key} className="leading-7">
            {renderInline(block.text, key)}
            {tail}
          </p>
        )
      case "code":
        return (
          <React.Fragment key={key}>
            <CodeBlock code={block.code} language={block.language} />
            {tail}
          </React.Fragment>
        )
      case "list": {
        const ListTag = block.ordered ? "ol" : "ul"
        return (
          <ListTag
            key={key}
            start={block.ordered && block.start !== 1 ? block.start : undefined}
            className={block.ordered ? "list-decimal space-y-1.5 pl-6" : "list-disc space-y-1.5 pl-6"}
          >
            {block.items.map((itemBlocks, itemIndex) => {
              const itemKey = `${key}-${itemIndex}`
              const isTight = itemBlocks.length <= 1 || itemBlocks.every((b) => b.type !== "paragraph" || b === itemBlocks[0])
              return (
                <li key={itemKey} className="pl-1 leading-7 marker:text-muted-foreground [&>*+*]:mt-2">
                  {renderBlocks(itemBlocks, itemKey, isLast && itemIndex === block.items.length - 1 ? trailing : undefined, isTight)}
                </li>
              )
            })}
          </ListTag>
        )
      }
      case "blockquote":
        return (
          <blockquote key={key} className="space-y-3 border-l-2 pl-4 text-muted-foreground">
            {renderBlocks(block.blocks, key, tail)}
          </blockquote>
        )
      case "rule":
        return <hr key={key} className="my-6 border-border" />
      case "table":
        return (
          <React.Fragment key={key}>
            <div className="overflow-hidden rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    {block.header.map((cell, cellIndex) => (
                      <TableHead key={cellIndex} style={{ textAlign: block.align[cellIndex] ?? undefined }}>
                        {renderInline(cell, `${key}-h${cellIndex}`)}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {block.rows.map((row, rowIndex) => (
                    <TableRow key={rowIndex}>
                      {block.header.map((_, cellIndex) => (
                        <TableCell key={cellIndex} className="whitespace-normal" style={{ textAlign: block.align[cellIndex] ?? undefined }}>
                          {renderInline(row[cellIndex] ?? "", `${key}-${rowIndex}-${cellIndex}`)}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {tail}
          </React.Fragment>
        )
    }
  })
}

/** Renders Markdown. `trailing` (for example a streaming cursor) is placed at the end of the last text. */
export function Markdown({ content, trailing }: { content: string; trailing?: React.ReactNode }) {
  const blocks = React.useMemo(() => parseBlocks(content), [content])
  return (
    <div className="space-y-4 text-sm break-words md:text-base">
      {renderBlocks(blocks, "md", trailing)}
      {blocks.length === 0 ? trailing : null}
    </div>
  )
}
