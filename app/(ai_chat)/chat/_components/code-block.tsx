"use client"

import * as React from "react"
import { CheckIcon, CopyIcon } from "lucide-react"
import { Button, cn } from "@boilerplate/ui"

type TokenKind = "keyword" | "string" | "comment" | "number" | "literal"

const TOKEN_CLASS: Record<TokenKind, string> = {
  keyword: "text-chart-1 font-medium",
  string: "text-chart-2",
  comment: "text-muted-foreground italic",
  number: "text-code-number",
  literal: "text-chart-4",
}

const JS_KEYWORDS =
  "abstract as async await break case catch class const continue debugger declare default delete do else enum export extends finally for from function get if implements import in instanceof interface let new of package private protected public readonly return set static super switch this throw try type typeof var void while with yield"
const SQL_KEYWORDS =
  "select from where and or not in is null like between join inner left right outer full on group by order having limit offset as distinct union all insert into values update set delete create table view alter drop index primary key foreign references case when then else end exists with count sum avg min max cast coalesce asc desc top"
const ABAP_KEYWORDS =
  "abap abstract define view entity as select from where and or not in is initial bound null like between inner left outer join on association to composition of parent root key define behavior for implementation managed unmanaged persistent table lock master etag authorization create update delete field readonly mandatory action determination validation data types type ref table line begin end report program class definition implementation method methods endmethod endclass public protected private section interface endinterface final create inheriting redefinition importing exporting changing returning raising value exceptions loop at into endloop if elseif else endif case when others endcase do enddo while endwhile try catch cleanup endtry raise exception new cast conv corresponding call function perform form endform append clear free modify insert read with sort by ascending descending move write message constants field-symbols field-symbol assign unassign check exit continue return group single up rows order distinct count sum min max avg cds annotation extend projection provider contract transactional_query transactional_interface use redirected @ endselect commit rollback work"
const PY_KEYWORDS =
  "and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield"
const LITERALS = new Set(["true", "false", "null", "undefined", "none", "abap_true", "abap_false", "space"])

type LanguageRules = { comment: string; string: string; keywords: Set<string>; caseInsensitive: boolean; word: string }

const C_COMMENT = String.raw`\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)`
const QUOTED = String.raw`"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'`

function rulesFor(language: string): LanguageRules {
  const lang = language.toLowerCase()
  const words = (list: string) => new Set(list.split(" "))
  if (lang === "abap" || lang === "cds" || lang === "abap-cds") {
    return {
      comment: String.raw`^\*[^\n]*|"[^\n]*`,
      string: String.raw`'(?:''|[^'\n])*'|\x60(?:\x60\x60|[^\x60\n])*\x60|\|(?:\\.|[^|\\])*\|`,
      keywords: words(ABAP_KEYWORDS),
      caseInsensitive: true,
      word: String.raw`[A-Za-z_][\w-]*`,
    }
  }
  if (lang === "sql" || lang === "hana" || lang === "sqlscript") {
    return { comment: String.raw`--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)`, string: QUOTED, keywords: words(SQL_KEYWORDS), caseInsensitive: true, word: String.raw`[A-Za-z_]\w*` }
  }
  if (["python", "py", "bash", "sh", "shell", "yaml", "yml", "toml"].includes(lang)) {
    return { comment: String.raw`#[^\n]*`, string: QUOTED, keywords: words(PY_KEYWORDS), caseInsensitive: false, word: String.raw`[A-Za-z_]\w*` }
  }
  if (["xml", "html", "xhtml", "svg"].includes(lang)) {
    return { comment: String.raw`<!--[\s\S]*?(?:-->|$)`, string: QUOTED, keywords: new Set(), caseInsensitive: false, word: String.raw`[A-Za-z_][\w:.-]*` }
  }
  // JavaScript, TypeScript, JSON, Java, C#, UI5 and unknown languages.
  return {
    comment: C_COMMENT,
    string: `${QUOTED}|\`(?:\\\\.|[^\`\\\\])*\``,
    keywords: words(JS_KEYWORDS),
    caseInsensitive: false,
    word: String.raw`[A-Za-z_$][\w$]*`,
  }
}

function highlight(code: string, language: string): React.ReactNode[] {
  const rules = rulesFor(language)
  const pattern = new RegExp(`(${rules.comment})|(${rules.string})|(\\b\\d+(?:\\.\\d+)?\\b)|(${rules.word})`, "gm")
  const nodes: React.ReactNode[] = []
  let last = 0
  let index = 0

  for (const match of code.matchAll(pattern)) {
    const start = match.index ?? 0
    if (start > last) nodes.push(code.slice(last, start))
    const [text, comment, string, number, word] = match
    let kind: TokenKind | null = null
    if (comment) kind = "comment"
    else if (string) kind = "string"
    else if (number) kind = "number"
    else if (word) {
      const key = rules.caseInsensitive ? word.toLowerCase() : word
      if (LITERALS.has(word.toLowerCase())) kind = "literal"
      else if (rules.keywords.has(key)) kind = "keyword"
    }
    nodes.push(
      kind ? (
        <span key={index++} className={TOKEN_CLASS[kind]}>
          {text}
        </span>
      ) : (
        text
      )
    )
    last = start + text.length
  }
  if (last < code.length) nodes.push(code.slice(last))
  return nodes
}

export function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = React.useState(false)
  const highlighted = React.useMemo(() => highlight(code, language), [code, language])

  React.useEffect(() => {
    if (!copied) return
    const timeout = window.setTimeout(() => setCopied(false), 2000)
    return () => window.clearTimeout(timeout)
  }, [copied])

  async function copy() {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="overflow-hidden rounded-lg border bg-code text-code-foreground">
      <div className="flex items-center justify-between border-b py-1 pr-1 pl-3">
        <span className="font-mono text-xs text-muted-foreground">{language || "text"}</span>
        <Button type="button" variant="ghost" size="xs" onClick={copy} aria-live="polite">
          {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className={cn("overflow-x-auto p-3 font-mono text-sm leading-6")}>
        <code>{highlighted}</code>
      </pre>
    </div>
  )
}
