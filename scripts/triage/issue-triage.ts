#!/usr/bin/env -S npx tsx
import OpenAI from "openai"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { readFile, readdir } from "node:fs/promises"
import { join, relative } from "node:path"

const exec = promisify(execFile)

const {
  GITHUB_TOKEN,
  LLM_API_KEY,
  ISSUE_NUMBER,
  ISSUE_TITLE = "",
  ISSUE_BODY = "",
  REPO = "",
} = process.env

const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.minimax.io/v1"
const OPENAI_MODEL = process.env.OPENAI_MODEL || "MiniMax-M3"

const BOT_AUTHOR = "github-actions[bot]"
const MENTION = "@hmanlab"
const MAX_FILE_BYTES = 6_000
const MAX_FILE_LINES = 400
const MAX_KEYWORDS = 15
const MAX_RANKED_FILES = 8
const RG_TIMEOUT_MS = 30_000
const CODE_EXTS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md", ".yml", ".yaml", ".sh"])
const ALWAYS_INCLUDE = ["AGENTS.md", "README.md", "package.json", "tsconfig.base.json"]

const log = (msg: string) => console.log(`[triage] ${msg}`)
const fail = (msg: string): never => {
  throw new Error(msg)
}

function required(name: string, value: string | undefined): string {
  if (!value) fail(`missing env: ${name}`)
  return value as string
}

function containsMention(text: string): boolean {
  return text.toLowerCase().includes(MENTION)
}

function stripThinking(text: string): string {
  let out = text
  while (true) {
    const open = out.indexOf("<think>")
    if (open === -1) break
    const close = out.indexOf("</think>", open)
    if (close === -1) break
    out = out.slice(0, open) + out.slice(close + "</think>".length)
  }
  return out.replace(/^\s*(?:<think>[\s\S]*?<\/think>\s*)+/i, "").trim()
}

function extractKeywords(text: string): string[] {
  const words = new Set<string>()
  for (const m of text.matchAll(/`([^`\n]{3,60})`/g)) {
    const v = m[1]?.trim()
    if (v) words.add(v)
  }
  for (const m of text.matchAll(/(?:Error|TypeError|ReferenceError|SyntaxError):\s*([^\n]+)/g)) {
    const v = m[1]?.trim().slice(0, 80)
    if (v) words.add(v)
  }
  for (const m of text.matchAll(
    /((?:\.{0,2}\/)?(?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|js|mjs|cjs|json|md|yml|yaml|sh))/g,
  )) {
    const v = m[1]
    if (v) words.add(v)
  }
  return [...words].filter((k) => k.length >= 3).slice(0, MAX_KEYWORDS)
}

async function listRepoFiles(root: string): Promise<string[]> {
  async function walk(dir: string): Promise<string[]> {
    const out: string[] = []
    let entries: import("node:fs").Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return out
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git" || e.name === "dist" || e.name === "build") continue
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name.startsWith(".") && e.name !== ".github") continue
        out.push(...(await walk(p)))
      } else if (e.isFile() && CODE_EXTS.has("." + (e.name.split(".").pop() ?? ""))) {
        out.push(p)
      }
    }
    return out
  }
  return walk(root)
}

async function rgSearch(root: string, pattern: string): Promise<string[]> {
  try {
    const { stdout } = await exec(
      "rg",
      [
        "-l",
        "-i",
        "--no-heading",
        "--no-messages",
        "--type-add",
        "code:*.{ts,tsx,js,mjs,cjs,json,md,yml,yaml,sh}",
        "-t",
        "code",
        "--max-count",
        "5",
        "--",
        pattern,
        root,
      ],
      { timeout: RG_TIMEOUT_MS, maxBuffer: 5_000_000 },
    )
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
  } catch (e: unknown) {
    const code = (e as { code?: number })?.code
    if (code === 1) return []
    const msg = e instanceof Error ? e.message : String(e)
    log(`rg warn for "${pattern.slice(0, 40)}": ${msg}`)
    return []
  }
}

async function readTruncated(path: string): Promise<string> {
  const raw = await readFile(path, "utf8")
  if (raw.length <= MAX_FILE_BYTES && raw.split("\n").length <= MAX_FILE_LINES) {
    return "```\n" + raw + "\n```"
  }
  const lines = raw.split("\n").slice(0, MAX_FILE_LINES).join("\n")
  const truncated = lines.length > MAX_FILE_BYTES ? lines.slice(0, MAX_FILE_BYTES) : lines
  return "```\n" + truncated + "\n```\n" + `// ...truncated (${raw.length} bytes total)\n`
}

async function findContextFiles(keywords: string[]): Promise<string[]> {
  const cwd = process.cwd()
  const allFiles = new Set(await listRepoFiles(cwd))
  const rank = new Map<string, number>()

  const hits = await Promise.all(keywords.map((k) => rgSearch(cwd, k)))
  for (const list of hits) {
    for (const file of list) {
      rank.set(file, (rank.get(file) ?? 0) + 1)
    }
  }

  const ranked = [...rank.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f)

  const always = ALWAYS_INCLUDE.map((f) => join(cwd, f)).filter((f) => allFiles.has(f))
  const seen = new Set(always.map((f) => relative(cwd, f)))
  const out = [...always]

  for (const f of ranked) {
    const rel = relative(cwd, f)
    if (seen.has(rel)) continue
    seen.add(rel)
    out.push(f)
    if (out.length >= MAX_RANKED_FILES + always.length) break
  }
  return out
}

function buildPrompt(title: string, body: string, context: string): string {
  return [
    "A user opened the following GitHub issue on hmanlab/hl-plugins.",
    "",
    "## Issue",
    `**Title:** ${title}`,
    "",
    "**Body:**",
    body || "(empty)",
    "",
    "## Repo context",
    "",
    context,
    "",
    "## Your task",
    "",
    "You are a maintainer-triage bot for hmanlab/hl-plugins. Analyze the issue against the repo context and produce a single markdown comment to be posted on the issue.",
    "",
    "Use the AGENTS.md issue body format, in this order:",
    "1. **Summary** — one-paragraph description of the problem",
    "2. **Repro / Steps to reproduce** — minimal code or commands that trigger the bug",
    "3. **Root cause** — file path + line number + offending snippet, plus why it matters",
    "4. **Impact** — who hits this, what state/data is affected",
    "5. **Proposed fix** — concrete code change (the actual diff, not a hand-wave)",
    "6. **Behavior after the fix** — before/after table for the affected scenarios",
    "7. **Alternatives considered** — what else was on the table and why this won",
    "8. **Affected files** — exact paths to change",
    "9. **Version** — which release this targets",
    "",
    "Rules:",
    "- Use file:line refs where possible.",
    "- If the issue is not actually a bug (feature request, question, support), say so at the top and skip the rest.",
    "- If you can't identify a root cause from the code provided, say what additional info you'd need.",
    "- Be terse. The maintainer will skim.",
    "- Do not wrap your whole reply in a ```markdown fence — GitHub renders plain markdown.",
    "- Do not greet or sign off. Start directly with the analysis.",
  ].join("\n")
}

async function postComment(token: string, repo: string, issueNumber: number, body: string): Promise<void> {
  const res = await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body }),
  })
  if (!res.ok) {
    const text = await res.text()
    fail(`post comment failed: ${res.status} ${text.slice(0, 200)}`)
  }
}

async function postFailure(token: string, repo: string, issueNumber: number, err: unknown): Promise<void> {
  const msg = err instanceof Error ? err.message : String(err)
  const body = [
    "**hmanlab-triage:** failed to analyze this issue.",
    "",
    "```",
    msg.slice(0, 400),
    "```",
    "",
    "See the Actions run for details.",
  ].join("\n")
  try {
    await postComment(token, repo, issueNumber, body)
  } catch (e) {
    log(`failure comment also failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function main(): Promise<void> {
  const token = required("GITHUB_TOKEN", GITHUB_TOKEN)
  const apiKey = required("LLM_API_KEY", LLM_API_KEY)
  const repo = required("REPO", REPO)
  const issueNumber = Number(required("ISSUE_NUMBER", ISSUE_NUMBER))
  if (!Number.isFinite(issueNumber)) fail(`ISSUE_NUMBER is not a number: ${ISSUE_NUMBER}`)

  if (!containsMention(ISSUE_TITLE) && !containsMention(ISSUE_BODY)) {
    log("no @hmanlab mention in title or body, skipping")
    return
  }

  if (ISSUE_BODY.includes(BOT_AUTHOR)) {
    log("detected bot author in body, skipping")
    return
  }

  log(`analyzing issue #${issueNumber} in ${repo}`)
  log(`provider=${OPENAI_BASE_URL}  model=${OPENAI_MODEL}`)

  const keywords = extractKeywords(`${ISSUE_BODY}\n${ISSUE_TITLE}`)
  log(`keywords (${keywords.length}): ${keywords.join(", ") || "(none)"}`)

  const contextFiles = keywords.length > 0 ? await findContextFiles(keywords) : []
  log(
    `context files (${contextFiles.length}): ${contextFiles.map((f) => relative(process.cwd(), f)).join(", ") || "(none)"}`,
  )

  const contextParts: string[] = []
  for (const f of contextFiles) {
    try {
      const content = await readTruncated(f)
      contextParts.push(`### ${relative(process.cwd(), f)}\n\n${content}`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log(`read warn ${relative(process.cwd(), f)}: ${msg}`)
    }
  }
  const context = contextParts.join("\n\n") || "(no matching files found)"

  const client = new OpenAI({ apiKey, baseURL: OPENAI_BASE_URL })
  const prompt = buildPrompt(ISSUE_TITLE, ISSUE_BODY, context)

  let comment: string
  try {
    const isMiniMax = OPENAI_MODEL.toLowerCase().startsWith("minimax-")
    const completion = await client.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.2,
      ...(isMiniMax ? { extra_body: { thinking: { type: "disabled" } } } : {}),
      messages: [
        {
          role: "system",
          content:
            "You are a precise, terse maintainer-triage bot. You cite file:line. You never invent behavior you cannot see in the code. You follow the AGENTS.md issue body format exactly. Your reply is the final comment — no thinking blocks, no <think> tags, no preamble.",
        },
        { role: "user", content: prompt },
      ],
    })
    const raw = completion.choices[0]?.message?.content?.trim() ?? ""
    if (!raw) fail("LLM returned empty completion")
    comment = stripThinking(raw)
  } catch (e) {
    await postFailure(token, repo, issueNumber, e)
    throw e
  }

  await postComment(token, repo, issueNumber, comment)
  log("comment posted")
}

main().catch((e: unknown) => {
  console.error("[triage] FATAL:", e)
  process.exit(1)
})
