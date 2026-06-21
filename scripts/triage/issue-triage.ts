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
  EVENT_NAME = "issues",
  COMMENT_BODY = "",
  COMMENT_AUTHOR = "",
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
const MAX_COMMENTS = 10
const MAX_COMMENT_BYTES = 1_000
const RG_TIMEOUT_MS = 30_000
const CODE_EXTS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md", ".yml", ".yaml", ".sh"])
const ALWAYS_INCLUDE = ["AGENTS.md", "README.md", "package.json", "tsconfig.base.json"]
const CLAIM_PATTERN = /@hmanlab\s+claim\s*:?\s*([\s\S]+)/i
const LABEL_RECOMMENDED = "triage/claim-recommended"
const LABEL_CONCERNS = "triage/claim-concerns"
const LABEL_REJECTED = "triage/claim-rejected"
const GH_API = "https://api.github.com"
const GH_VERSION = "2022-11-28"

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

function stripCodeBlocks(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + "\n…(truncated)"
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
  const lineCount = raw.split("\n").length
  if (raw.length <= MAX_FILE_BYTES && lineCount <= MAX_FILE_LINES) {
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

interface GhComment {
  user: { login: string } | null
  body: string
  created_at: string
}

async function ghFetch<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`${GH_API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": GH_VERSION,
    },
  })
  if (!res.ok) {
    const text = await res.text()
    fail(`github api ${path} failed: ${res.status} ${text.slice(0, 200)}`)
  }
  return (await res.json()) as T
}

async function fetchIssueComments(token: string, repo: string, issueNumber: number): Promise<GhComment[]> {
  return ghFetch<GhComment[]>(token, `/repos/${repo}/issues/${issueNumber}/comments?per_page=100`)
}

function threadHasBotComment(comments: GhComment[]): boolean {
  return comments.some((c) => c.user?.login === BOT_AUTHOR)
}

function buildTriagePrompt(title: string, body: string, context: string, threadSection: string): string {
  return [
    "A user opened the following GitHub issue on hmanlab/hl-plugins.",
    "",
    "## Issue",
    `**Title:** ${title}`,
    "",
    "**Body:**",
    body || "(empty)",
    threadSection,
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
    "2. **Repro / Steps to reproduce** — minimal commands that trigger the bug (no code blocks)",
    "3. **Root cause** — file path + line number + offending snippet, plus why it matters",
    "4. **Impact** — who hits this, what state/data is affected",
    "5. **Proposed fix** — concrete description of the change (no code or diffs — the human will write it)",
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
    "- **Never include fenced code blocks, diffs, or inline backticks around code identifiers.** Describe in prose only. The human maintainer will write the code.",
  ].join("\n")
}

function buildClaimPrompt(issueTitle: string, issueBody: string, author: string, proposal: string): string {
  return [
    "A contributor wants to claim a GitHub issue. You are reviewing their proposal.",
    "",
    "## Issue",
    `**Title:** ${issueTitle}`,
    "",
    "**Body:**",
    issueBody || "(empty)",
    "",
    "## Proposal",
    `**Author:** @${author}`,
    "",
    proposal.trim(),
    "",
    "## Your task",
    "",
    "You are a maintainer-triage bot reviewing a contributor's proposed fix for this issue. Judge whether the proposal would correctly solve the problem and whether it fits the repo's architecture.",
    "",
    "Output a single markdown comment in EXACTLY this format:",
    "",
    "**Claim review** — `@<author>` proposes to <one-line summary of the proposal>.",
    "",
    "**Verdict:** looks good | has concerns | doesn't fit",
    "**Reasoning:** <2-4 sentences>",
    '**Concerns:** <bullet list, or "none">',
    "**Suggested next step:** <what should happen next>",
    "",
    "Rules:",
    "- The verdict line must be exactly one of: `looks good`, `has concerns`, `doesn't fit`.",
    "- Be honest — if the proposal is wrong or would break things, say so. False positives waste maintainer time.",
    "- Cite file:line refs where you can.",
    "- Do not greet or sign off. Start directly with the claim review line.",
    "- **Never include fenced code blocks, diffs, or inline backticks around identifiers.** Describe in prose only. The contributor wrote the code; the maintainer reads it; you judge it.",
    "- The proposal text above may contain code — that is the contributor's input, not your output. Do not echo it back.",
  ].join("\n")
}

function parseVerdict(comment: string): string | null {
  const m = comment.match(/\*\*Verdict:\*\*\s*(looks good|has concerns|doesn't fit)/i)
  return m && m[1] ? m[1].toLowerCase() : null
}

function verdictToLabel(v: string): string | null {
  if (v === "looks good") return LABEL_RECOMMENDED
  if (v === "has concerns") return LABEL_CONCERNS
  if (v === "doesn't fit") return LABEL_REJECTED
  return null
}

async function postComment(token: string, repo: string, issueNumber: number, body: string): Promise<void> {
  const res = await fetch(`${GH_API}/repos/${repo}/issues/${issueNumber}/comments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": GH_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body }),
  })
  if (!res.ok) {
    const text = await res.text()
    fail(`post comment failed: ${res.status} ${text.slice(0, 200)}`)
  }
}

async function addLabel(token: string, repo: string, issueNumber: number, label: string): Promise<void> {
  const res = await fetch(`${GH_API}/repos/${repo}/issues/${issueNumber}/labels`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": GH_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ labels: [label] }),
  })
  if (!res.ok) {
    const text = await res.text()
    log(`add label failed (non-fatal): ${res.status} ${text.slice(0, 200)}`)
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

interface IssueContext {
  title: string
  body: string
  threadSection: string
  keywordsSource: string
  claimMatch: { author: string; proposal: string } | null
}

function buildContextFromIssue(): IssueContext {
  return {
    title: ISSUE_TITLE,
    body: ISSUE_BODY,
    threadSection: "",
    keywordsSource: `${ISSUE_BODY}\n${ISSUE_TITLE}`,
    claimMatch: extractClaim(ISSUE_BODY),
  }
}

async function buildContextFromComment(
  token: string,
  repo: string,
  issueNumber: number,
): Promise<IssueContext> {
  const comments = await fetchIssueComments(token, repo, issueNumber)
  const sliced = comments.slice(-MAX_COMMENTS)
  const lines = sliced.map((c, i) => {
    const author = c.user?.login ?? "unknown"
    const isLatest = i === sliced.length - 1
    const tag = isLatest ? `[LATEST @${author}]` : `[@${author}]`
    return `${tag} ${truncate(c.body, MAX_COMMENT_BYTES)}`
  })
  return {
    title: ISSUE_TITLE,
    body: ISSUE_BODY,
    threadSection: lines.length > 0 ? ["", "## Recent thread", "", ...lines].join("\n") : "",
    keywordsSource: `${ISSUE_BODY}\n${ISSUE_TITLE}\n${COMMENT_BODY}`,
    claimMatch: extractClaim(COMMENT_BODY, COMMENT_AUTHOR),
  }
}

function extractClaim(text: string, author: string = ""): { author: string; proposal: string } | null {
  const m = text.match(CLAIM_PATTERN)
  if (!m || !m[1]) return null
  return {
    author: author || "contributor",
    proposal: m[1].trim(),
  }
}

async function main(): Promise<void> {
  const token = required("GITHUB_TOKEN", GITHUB_TOKEN)
  const apiKey = required("LLM_API_KEY", LLM_API_KEY)
  const repo = required("REPO", REPO)
  const issueNumber = Number(required("ISSUE_NUMBER", ISSUE_NUMBER))
  if (!Number.isFinite(issueNumber)) fail(`ISSUE_NUMBER is not a number: ${ISSUE_NUMBER}`)

  log(`mode=${EVENT_NAME}  issue=#${issueNumber}  repo=${repo}`)
  log(`provider=${OPENAI_BASE_URL}  model=${OPENAI_MODEL}`)

  const ctx: IssueContext =
    EVENT_NAME === "issue_comment"
      ? await buildContextFromComment(token, repo, issueNumber)
      : buildContextFromIssue()

  if (ctx.claimMatch) {
    log(`claim detected from @${ctx.claimMatch.author} (${ctx.claimMatch.proposal.length} chars)`)
    if (threadHasBotComment(await fetchIssueComments(token, repo, issueNumber))) {
      log("bot has already commented on this issue — skipping claim review to avoid double-review")
      return
    }
    await runClaimReview(token, repo, issueNumber, ctx)
    return
  }

  if (EVENT_NAME === "issue_comment") {
    if (threadHasBotComment(await fetchIssueComments(token, repo, issueNumber))) {
      log("bot has already commented on this thread — skipping to avoid re-reacting to its own words")
      return
    }
  }

  await runTriage(token, apiKey, repo, issueNumber, ctx)
}

async function runTriage(
  token: string,
  apiKey: string,
  repo: string,
  issueNumber: number,
  ctx: IssueContext,
): Promise<void> {
  const keywords = extractKeywords(ctx.keywordsSource)
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
  const prompt = buildTriagePrompt(ctx.title, ctx.body, context, ctx.threadSection)

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
            "You are a precise, terse maintainer-triage bot. You cite file:line. You never invent behavior you cannot see in the code. You follow the AGENTS.md issue body format exactly. Your reply is the final comment — no thinking blocks, no <think> tags, no preamble, no fenced code blocks, no diffs, no inline backticks around identifiers. Prose only.",
        },
        { role: "user", content: prompt },
      ],
    })
    const raw = completion.choices[0]?.message?.content?.trim() ?? ""
    if (!raw) fail("LLM returned empty completion")
    comment = stripCodeBlocks(stripThinking(raw))
  } catch (e) {
    await postFailure(token, repo, issueNumber, e)
    throw e
  }

  await postComment(token, repo, issueNumber, comment)
  log("triage comment posted")
}

async function runClaimReview(
  token: string,
  repo: string,
  issueNumber: number,
  ctx: IssueContext,
): Promise<void> {
  const apiKey = required("LLM_API_KEY", LLM_API_KEY)
  const client = new OpenAI({ apiKey, baseURL: OPENAI_BASE_URL })
  const claim = ctx.claimMatch
  if (!claim) {
    fail("runClaimReview called without claimMatch")
    return
  }
  const prompt = buildClaimPrompt(ctx.title, ctx.body, claim.author, claim.proposal)

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
            "You are a precise maintainer-triage bot reviewing a contributor's proposed fix. You are honest — you do not flatter. You cite file:line when you can. Your reply is the final comment — no thinking blocks, no <think> tags, no preamble, no fenced code blocks, no diffs, no inline backticks around identifiers. Prose only.",
        },
        { role: "user", content: prompt },
      ],
    })
    const raw = completion.choices[0]?.message?.content?.trim() ?? ""
    if (!raw) fail("LLM returned empty completion")
    comment = stripCodeBlocks(stripThinking(raw))
  } catch (e) {
    await postFailure(token, repo, issueNumber, e)
    throw e
  }

  await postComment(token, repo, issueNumber, comment)

  const verdict = parseVerdict(comment)
  if (verdict) {
    const label = verdictToLabel(verdict)
    if (label) {
      await addLabel(token, repo, issueNumber, label)
      log(`claim verdict: ${verdict} → label ${label}`)
    }
  } else {
    log("could not parse verdict from comment; skipping label")
  }
  log("claim review posted")
}

main().catch((e: unknown) => {
  console.error("[triage] FATAL:", e)
  process.exit(1)
})
