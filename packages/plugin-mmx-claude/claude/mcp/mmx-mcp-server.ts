// mmx-mcp-server.ts
//
// MCP server that exposes the seven mmx tools to Claude Code. Loaded
// at startup by Claude Code's mcpServers config; communicates over
// stdio via JSON-RPC.
//
// Built with:  bun build ./claude/mcp/mmx-mcp-server.ts --target=bun
//                   --outfile=./dist/mmx-mcp-server.js
//
// All generated files default to ~/Desktop/mmx-output/. The user can
// override the default directory permanently via $MMX_OUTPUT_DIR; the
// LLM should never pass out_dir / out_path unless the user explicitly
// asked.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
// Import from `zod/v3` so the type identity matches the SDK's internal
// zod-compat. Without this, the SDK's AnySchema = z3.ZodTypeAny | z4.$ZodType
// rejects the zod `ZodString` we hand in (TS sees two distinct ZodString
// types because they were loaded from different module specifiers).
import { z } from "zod/v3"
import { dirname } from "node:path"
import {
  DEFAULT_OUT_DIR,
  ensureDir,
  resolveFilePath,
  resolveOutDir,
  runMmx,
  warnSuspiciousOutDir,
} from "../../src/lib.js"

const server = new McpServer({
  name: "mmx-claude",
  version: "0.1.0",
})

// Claude Code does not have a worktree concept the way OpenCode does.
// process.cwd() is the closest analogue — it's the directory Claude was
// launched from, which is what relative paths in tool args would resolve
// against. The OpenCode plugin uses ctx.worktree; we use cwd() here.
const worktree = process.cwd()

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] }
}

// ─── mmx_image ──────────────────────────────────────────────────────────
server.registerTool(
  "mmx_image",
  {
    description:
      "Generate one or more images from a text prompt using MiniMax's image-01 model via mmx-cli. Use this whenever the user asks for an image, illustration, logo, artwork, photo, or any visual asset. Aspect ratios: 1:1, 16:9, 9:16, 4:3, 3:4, 21:9. Pass seed for reproducible results. Returns the saved file path.",
    inputSchema: {
      prompt: z
        .string()
        .describe(
          "Detailed text description of the image. Be specific about subject, style, lighting, composition, mood.",
        ),
      aspect_ratio: z
        .string()
        .optional()
        .describe("Aspect ratio. One of: 1:1, 16:9, 9:16, 4:3, 3:4, 21:9. Default 1:1."),
      n: z.number().optional().describe("Number of images to generate. Default 1, max 4."),
      seed: z.number().optional().describe("Random seed for reproducible generation."),
      out_dir: z
        .string()
        .optional()
        .describe(
          "Override save directory. Leave unset unless the user explicitly asked for a different save location in this conversation. Default: ~/Desktop/mmx-output/ (or $MMX_OUTPUT_DIR if set). Suspicious paths fall back to the default with a warning.",
        ),
      optimize_prompt: z.boolean().optional().describe("Auto-optimize the prompt for better quality."),
      filename_prefix: z
        .string()
        .optional()
        .describe(
          "Filename prefix. Defaults to a unique per-call value (image-<timestamp>) so back-to-back calls don't overwrite each other. Pass an explicit value for predictable sequential naming.",
        ),
    },
  },
  async (args) => {
    const requestedDir = resolveOutDir(args.out_dir, worktree)
    const outDir = requestedDir === "" || requestedDir === "." ? DEFAULT_OUT_DIR : requestedDir
    ensureDir(outDir)
    const filenamePrefix = args.filename_prefix ?? `image-${Date.now()}`
    const cliArgs = ["image", "generate", "--prompt", args.prompt]
    if (args.aspect_ratio) cliArgs.push("--aspect-ratio", args.aspect_ratio)
    if (args.n) cliArgs.push("--n", String(args.n))
    if (args.seed != null) cliArgs.push("--seed", String(args.seed))
    if (args.optimize_prompt) cliArgs.push("--prompt-optimizer")
    cliArgs.push("--out-dir", outDir, "--out-prefix", filenamePrefix, "--non-interactive")
    const { stdout, stderr, exitCode } = await runMmx(cliArgs)
    if (exitCode !== 0) {
      return textResult(`mmx image generate failed (exit ${exitCode}):\n${stderr || stdout || "(no output)"}`)
    }
    let msg = `Image generation complete.\n\n${stdout.trim()}\n\nSaved to: ${outDir}\nFilename prefix: ${filenamePrefix}`
    if (outDir !== requestedDir && args.out_dir) {
      msg += `\n\n${warnSuspiciousOutDir(args.out_dir, outDir)}`
    }
    return textResult(msg)
  },
)

// ─── mmx_speech ─────────────────────────────────────────────────────────
server.registerTool(
  "mmx_speech",
  {
    description:
      "Synthesize speech from text using MiniMax's speech-2.8-hd model. Use when the user wants a voiceover, narration, audio file, TTS, or to read text aloud. Saves an MP3 and returns the path. 40+ languages. Default voice: English_expressive_narrator.",
    inputSchema: {
      text: z.string().describe("The text to speak. Up to 10,000 characters."),
      voice: z.string().optional().describe("Voice ID. Default English_expressive_narrator."),
      speed: z.number().optional().describe("Speech speed multiplier. Default 1.0."),
      out_path: z
        .string()
        .optional()
        .describe(
          "Override output .mp3 path. Leave unset unless the user explicitly asked for a different save location in this conversation. Default: ~/Desktop/mmx-output/speech-<timestamp>.mp3 (or $MMX_OUTPUT_DIR if set). Suspicious parent directories fall back to the default with a warning.",
        ),
    },
  },
  async (args) => {
    const {
      filePath: outPath,
      wasSuspicious,
      originalArg,
    } = resolveFilePath(args.out_path, worktree, `speech-${Date.now()}.mp3`)
    ensureDir(dirname(outPath))
    const cliArgs = ["speech", "synthesize", "--text", args.text]
    if (args.voice) cliArgs.push("--voice", args.voice)
    if (args.speed != null) cliArgs.push("--speed", String(args.speed))
    cliArgs.push("--out", outPath, "--non-interactive")
    const { stdout, stderr, exitCode } = await runMmx(cliArgs)
    if (exitCode !== 0) {
      return textResult(
        `mmx speech synthesize failed (exit ${exitCode}):\n${stderr || stdout || "(no output)"}`,
      )
    }
    let msg = `Speech synthesized.\n\nSaved to: ${outPath}`
    if (wasSuspicious && originalArg) {
      msg += `\n\n${warnSuspiciousOutDir(originalArg, outPath)}`
    }
    return textResult(msg)
  },
)

// ─── mmx_video ──────────────────────────────────────────────────────────
server.registerTool(
  "mmx_video",
  {
    description:
      "Generate a short video from a text prompt using MiniMax's Hailuo-2.3 model. Use when the user wants a video clip, animation, or motion graphic. Generation can take 1-3 minutes. Returns the output MP4 file path.",
    inputSchema: {
      prompt: z
        .string()
        .describe("Detailed description of the video scene, including camera movement and action."),
      model: z
        .string()
        .optional()
        .describe(
          "Model ID. Default MiniMax-Hailuo-2.3. Use MiniMax-Hailuo-2.3-Fast for quicker lower-quality results.",
        ),
      out_path: z
        .string()
        .optional()
        .describe(
          "Override output .mp4 path. Leave unset unless the user explicitly asked for a different save location in this conversation. Default: ~/Desktop/mmx-output/video-<timestamp>.mp4 (or $MMX_OUTPUT_DIR if set). Suspicious parent directories fall back to the default with a warning.",
        ),
    },
  },
  async (args) => {
    const {
      filePath: outPath,
      wasSuspicious,
      originalArg,
    } = resolveFilePath(args.out_path, worktree, `video-${Date.now()}.mp4`)
    ensureDir(dirname(outPath))
    const cliArgs = ["video", "generate", "--prompt", args.prompt]
    if (args.model) cliArgs.push("--model", args.model)
    cliArgs.push("--download", outPath, "--non-interactive")
    const { stdout, stderr, exitCode } = await runMmx(cliArgs)
    if (exitCode !== 0) {
      return textResult(`mmx video generate failed (exit ${exitCode}):\n${stderr || stdout || "(no output)"}`)
    }
    let msg = `Video generation complete.\n\nSaved to: ${outPath}`
    if (wasSuspicious && originalArg) {
      msg += `\n\n${warnSuspiciousOutDir(originalArg, outPath)}`
    }
    return textResult(msg)
  },
)

// ─── mmx_music ──────────────────────────────────────────────────────────
server.registerTool(
  "mmx_music",
  {
    description:
      "Generate a song or instrumental music from a style prompt using MiniMax's music-2.6 model. Use when the user wants background music, a theme song, a jingle, or instrumental music. Either supply lyrics or set instrumental=true.",
    inputSchema: {
      prompt: z
        .string()
        .describe(
          "Style description: genre, mood, instruments, tempo. E.g. 'cinematic orchestral, building tension'.",
        ),
      lyrics: z
        .string()
        .optional()
        .describe("Song lyrics with structure tags like [Verse], [Chorus]. Omit for instrumental."),
      instrumental: z.boolean().optional().describe("If true, generate instrumental music with no vocals."),
      vocals: z.string().optional().describe("Vocal style hint, e.g. 'warm male baritone'."),
      bpm: z.number().optional().describe("Exact tempo in BPM."),
      out_path: z
        .string()
        .optional()
        .describe(
          "Override output .mp3 path. Leave unset unless the user explicitly asked for a different save location in this conversation. Default: ~/Desktop/mmx-output/music-<timestamp>.mp3 (or $MMX_OUTPUT_DIR if set). Suspicious parent directories fall back to the default with a warning.",
        ),
    },
  },
  async (args) => {
    const {
      filePath: outPath,
      wasSuspicious,
      originalArg,
    } = resolveFilePath(args.out_path, worktree, `music-${Date.now()}.mp3`)
    ensureDir(dirname(outPath))
    const cliArgs = ["music", "generate", "--prompt", args.prompt]
    if (args.lyrics) cliArgs.push("--lyrics", args.lyrics)
    if (args.instrumental) cliArgs.push("--instrumental")
    if (args.vocals) cliArgs.push("--vocals", args.vocals)
    if (args.bpm != null) cliArgs.push("--bpm", String(args.bpm))
    cliArgs.push("--out", outPath, "--non-interactive")
    const { stdout, stderr, exitCode } = await runMmx(cliArgs)
    if (exitCode !== 0) {
      return textResult(`mmx music generate failed (exit ${exitCode}):\n${stderr || stdout || "(no output)"}`)
    }
    let msg = `Music generation complete.\n\nSaved to: ${outPath}`
    if (wasSuspicious && originalArg) {
      msg += `\n\n${warnSuspiciousOutDir(originalArg, outPath)}`
    }
    return textResult(msg)
  },
)

// ─── mmx_search ─────────────────────────────────────────────────────────
server.registerTool(
  "mmx_search",
  {
    description:
      "Search the web using MiniMax's search API. Use when the user wants current information, news, facts, or anything time-sensitive. Returns a textual summary of search results.",
    inputSchema: {
      query: z.string().describe("The search query."),
    },
  },
  async (args) => {
    const { stdout, stderr, exitCode } = await runMmx([
      "search",
      "query",
      "--q",
      args.query,
      "--output",
      "json",
      "--non-interactive",
    ])
    if (exitCode !== 0) {
      return textResult(`mmx search failed (exit ${exitCode}):\n${stderr || stdout || "(no output)"}`)
    }
    return textResult(stdout.trim() || "(no results)")
  },
)

// ─── mmx_vision ─────────────────────────────────────────────────────────
server.registerTool(
  "mmx_vision",
  {
    description:
      "Describe or analyze an image using MiniMax's vision model. Pass a local file path or URL. Returns a textual description. Useful when the user uploads an image and wants analysis, OCR, or a description.",
    inputSchema: {
      image: z.string().describe("Local file path or URL of the image."),
      prompt: z
        .string()
        .optional()
        .describe("Custom question about the image. Default 'Describe the image.'"),
    },
  },
  async (args) => {
    const cliArgs = ["vision", "describe", "--image", args.image]
    if (args.prompt) cliArgs.push("--prompt", args.prompt)
    cliArgs.push("--non-interactive")
    const { stdout, stderr, exitCode } = await runMmx(cliArgs)
    if (exitCode !== 0) {
      return textResult(
        `mmx vision describe failed (exit ${exitCode}):\n${stderr || stdout || "(no output)"}`,
      )
    }
    return textResult(stdout.trim() || "(no description)")
  },
)

// ─── mmx_quota ──────────────────────────────────────────────────────────
server.registerTool(
  "mmx_quota",
  {
    description:
      "Show current Token Plan usage and remaining quota (5-hour rolling and weekly windows). Use when the user asks about quota, usage, limits, or how many calls they have left.",
  },
  async () => {
    let { stdout, stderr, exitCode } = await runMmx(["quota"])
    if (exitCode !== 0) {
      const fallback = await runMmx(["quota", "show", "--non-interactive"])
      if (fallback.exitCode === 0) {
        stdout = fallback.stdout
        stderr = fallback.stderr
        exitCode = fallback.exitCode
      } else {
        return textResult(`mmx quota failed (exit ${exitCode}):\n${stderr || "(no stderr)"}`)
      }
    }
    const raw = stdout.trim()
    let data: any
    try {
      data = JSON.parse(raw)
    } catch {
      return textResult(raw || "(no quota info)")
    }
    const rows = (data.model_remains ?? []).map((m: any) => {
      const reset = new Date(m.end_time).toUTCString().replace(/^[^,]+,\s*/, "")
      return `| ${m.model_name} | ${m.current_interval_remaining_percent}% left | ${m.current_weekly_remaining_percent}% left | resets ${reset} |`
    })
    const header = "| Model | 5h window | Weekly | Next reset |\n|---|---|---|---|"
    return textResult(`Quota — Token Plan\n\n${header}\n${rows.join("\n")}\n`)
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
