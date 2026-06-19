// mmx-tools.ts
//
// OpenCode plugin that wraps the official MiniMax mmx-cli so the LLM can
// generate images, video, music, speech, run web search, describe images,
// and check Token Plan quota — all from inside an OpenCode session without
// leaving the chat.
//
// Requires once on the machine:
//   npm install -g mmx-cli
//   mmx auth login --api-key sk-xxxxx
// After that, no key is needed in opencode.
//
// All generated files default to ~/Desktop/mmx-output/. The user can override
// the default directory permanently via the MMX_OUTPUT_DIR env var; the LLM
// should never pass out_dir / out_path unless the user explicitly asked.

import { tool } from "@opencode-ai/plugin"
import { homedir } from "node:os"
import { basename, dirname, join, resolve, isAbsolute } from "node:path"
import { mkdirSync, existsSync } from "node:fs"

const DEFAULT_OUT_DIR = join(homedir(), "Desktop", "mmx-output")

function resolveOutDir(outDir: string | undefined, worktree: string): string {
  const target = outDir ?? process.env.MMX_OUTPUT_DIR ?? DEFAULT_OUT_DIR
  return isAbsolute(target) ? target : resolve(worktree, target)
}

function isSuspiciousOutDir(absPath: string): boolean {
  const home = homedir()
  const suspects = [home, join(home, "Desktop"), "/tmp", "/private/tmp", "."]
  return absPath === "" || suspects.includes(absPath)
}

function warnSuspiciousOutDir(originalArg: string, usedInstead: string): string {
  return `Note: out_dir/out_path "${originalArg}" looks like a mistake (home directory, Desktop root, /tmp, or cwd). Saving to "${usedInstead}" instead. Pass an explicit subdirectory to override.`
}

function resolveFilePath(
  argsOutPath: string | undefined,
  worktree: string,
  defaultFileName: string,
): { filePath: string; wasSuspicious: boolean; originalArg: string | undefined } {
  const envDir = process.env.MMX_OUTPUT_DIR ?? DEFAULT_OUT_DIR
  const requested = argsOutPath ?? join(envDir, defaultFileName)
  const requestedDirAbs = isAbsolute(requested)
    ? dirname(requested)
    : resolve(worktree, dirname(requested))
  if (isSuspiciousOutDir(requestedDirAbs)) {
    return {
      filePath: join(DEFAULT_OUT_DIR, basename(requested)),
      wasSuspicious: true,
      originalArg: argsOutPath,
    }
  }
  return {
    filePath: isAbsolute(requested) ? requested : join(requestedDirAbs, basename(requested)),
    wasSuspicious: false,
    originalArg: argsOutPath,
  }
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

async function runMmx(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["mmx", ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

export default async () => {
  return {
    tool: {
      // ──────────────────────────────────────────────────────────────────
      // IMAGE GENERATION (primary tool)
      // ──────────────────────────────────────────────────────────────────
      mmx_image: tool({
        description:
          "Generate one or more images from a text prompt using MiniMax's image-01 model via mmx-cli. Use this whenever the user asks for an image, illustration, logo, artwork, photo, or any visual asset. Aspect ratios: 1:1, 16:9, 9:16, 4:3, 3:4, 21:9. Pass seed for reproducible results. Returns the saved file path.",
        args: {
          prompt: tool.schema
            .string()
            .describe(
              "Detailed text description of the image. Be specific about subject, style, lighting, composition, mood.",
            ),
          aspect_ratio: tool.schema
            .string()
            .optional()
            .describe("Aspect ratio. One of: 1:1, 16:9, 9:16, 4:3, 3:4, 21:9. Default 1:1."),
          n: tool.schema
            .number()
            .optional()
            .describe("Number of images to generate. Default 1, max 4."),
          seed: tool.schema
            .number()
            .optional()
            .describe("Random seed for reproducible generation."),
          out_dir: tool.schema
            .string()
            .optional()
            .describe(
              "Override save directory. Leave unset unless the user explicitly asked for a different save location in this conversation. Default: ~/Desktop/mmx-output/ (or $MMX_OUTPUT_DIR if set). Suspicious paths fall back to the default with a warning.",
            ),
          optimize_prompt: tool.schema
            .boolean()
            .optional()
            .describe("Auto-optimize the prompt for better quality."),
          filename_prefix: tool.schema
            .string()
            .optional()
            .describe("Filename prefix. Defaults to a unique per-call value (image-<timestamp>) so back-to-back calls don't overwrite each other. Pass an explicit value for predictable sequential naming."),
        },
        async execute(args, ctx) {
          const requestedDir = resolveOutDir(args.out_dir, ctx.worktree)
          const outDir = isSuspiciousOutDir(requestedDir) ? DEFAULT_OUT_DIR : requestedDir
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
            return `mmx image generate failed (exit ${exitCode}):\n${stderr || stdout || "(no output)"}`
          }
          let msg = `Image generation complete.\n\n${stdout.trim()}\n\nSaved to: ${outDir}\nFilename prefix: ${filenamePrefix}`
          if (outDir !== requestedDir && args.out_dir) {
            msg += `\n\n${warnSuspiciousOutDir(args.out_dir, outDir)}`
          }
          return msg
        },
      }),

      // ──────────────────────────────────────────────────────────────────
      // SPEECH SYNTHESIS
      // ──────────────────────────────────────────────────────────────────
      mmx_speech: tool({
        description:
          "Synthesize speech from text using MiniMax's speech-2.8-hd model. Use when the user wants a voiceover, narration, audio file, TTS, or to read text aloud. Saves an MP3 and returns the path. 40+ languages. Default voice: English_expressive_narrator.",
        args: {
          text: tool.schema
            .string()
            .describe("The text to speak. Up to 10,000 characters."),
          voice: tool.schema
            .string()
            .optional()
            .describe("Voice ID. Default English_expressive_narrator."),
          speed: tool.schema
            .number()
            .optional()
            .describe("Speech speed multiplier. Default 1.0."),
          out_path: tool.schema
            .string()
            .optional()
            .describe("Override output .mp3 path. Leave unset unless the user explicitly asked for a different save location in this conversation. Default: ~/Desktop/mmx-output/speech-<timestamp>.mp3 (or $MMX_OUTPUT_DIR if set). Suspicious parent directories fall back to the default with a warning."),
        },
        async execute(args, ctx) {
          const { filePath: outPath, wasSuspicious, originalArg } = resolveFilePath(
            args.out_path,
            ctx.worktree,
            `speech-${Date.now()}.mp3`,
          )
          ensureDir(dirname(outPath))
          const cliArgs = ["speech", "synthesize", "--text", args.text]
          if (args.voice) cliArgs.push("--voice", args.voice)
          if (args.speed != null) cliArgs.push("--speed", String(args.speed))
          cliArgs.push("--out", outPath, "--non-interactive")
          const { stdout, stderr, exitCode } = await runMmx(cliArgs)
          if (exitCode !== 0) {
            return `mmx speech synthesize failed (exit ${exitCode}):\n${stderr || stdout || "(no output)"}`
          }
          let msg = `Speech synthesized.\n\nSaved to: ${outPath}`
          if (wasSuspicious && originalArg) {
            msg += `\n\n${warnSuspiciousOutDir(originalArg, outPath)}`
          }
          return msg
        },
      }),

      // ──────────────────────────────────────────────────────────────────
      // VIDEO GENERATION
      // ──────────────────────────────────────────────────────────────────
      mmx_video: tool({
        description:
          "Generate a short video from a text prompt using MiniMax's Hailuo-2.3 model. Use when the user wants a video clip, animation, or motion graphic. Generation can take 1-3 minutes. Returns the output MP4 file path.",
        args: {
          prompt: tool.schema
            .string()
            .describe("Detailed description of the video scene, including camera movement and action."),
          model: tool.schema
            .string()
            .optional()
            .describe("Model ID. Default MiniMax-Hailuo-2.3. Use MiniMax-Hailuo-2.3-Fast for quicker lower-quality results."),
          out_path: tool.schema
            .string()
            .optional()
            .describe("Override output .mp4 path. Leave unset unless the user explicitly asked for a different save location in this conversation. Default: ~/Desktop/mmx-output/video-<timestamp>.mp4 (or $MMX_OUTPUT_DIR if set). Suspicious parent directories fall back to the default with a warning."),
        },
        async execute(args, ctx) {
          const { filePath: outPath, wasSuspicious, originalArg } = resolveFilePath(
            args.out_path,
            ctx.worktree,
            `video-${Date.now()}.mp4`,
          )
          ensureDir(dirname(outPath))
          const cliArgs = ["video", "generate", "--prompt", args.prompt]
          if (args.model) cliArgs.push("--model", args.model)
          cliArgs.push("--download", outPath, "--non-interactive")
          const { stdout, stderr, exitCode } = await runMmx(cliArgs)
          if (exitCode !== 0) {
            return `mmx video generate failed (exit ${exitCode}):\n${stderr || stdout || "(no output)"}`
          }
          let msg = `Video generation complete.\n\nSaved to: ${outPath}`
          if (wasSuspicious && originalArg) {
            msg += `\n\n${warnSuspiciousOutDir(originalArg, outPath)}`
          }
          return msg
        },
      }),

      // ──────────────────────────────────────────────────────────────────
      // MUSIC GENERATION
      // ──────────────────────────────────────────────────────────────────
      mmx_music: tool({
        description:
          "Generate a song or instrumental music from a style prompt using MiniMax's music-2.6 model. Use when the user wants background music, a theme song, a jingle, or instrumental music. Either supply lyrics or set instrumental=true.",
        args: {
          prompt: tool.schema
            .string()
            .describe("Style description: genre, mood, instruments, tempo. E.g. 'cinematic orchestral, building tension'."),
          lyrics: tool.schema
            .string()
            .optional()
            .describe("Song lyrics with structure tags like [Verse], [Chorus]. Omit for instrumental."),
          instrumental: tool.schema
            .boolean()
            .optional()
            .describe("If true, generate instrumental music with no vocals."),
          vocals: tool.schema
            .string()
            .optional()
            .describe("Vocal style hint, e.g. 'warm male baritone'."),
          bpm: tool.schema.number().optional().describe("Exact tempo in BPM."),
          out_path: tool.schema
            .string()
            .optional()
            .describe("Override output .mp3 path. Leave unset unless the user explicitly asked for a different save location in this conversation. Default: ~/Desktop/mmx-output/music-<timestamp>.mp3 (or $MMX_OUTPUT_DIR if set). Suspicious parent directories fall back to the default with a warning."),
        },
        async execute(args, ctx) {
          const { filePath: outPath, wasSuspicious, originalArg } = resolveFilePath(
            args.out_path,
            ctx.worktree,
            `music-${Date.now()}.mp3`,
          )
          ensureDir(dirname(outPath))
          const cliArgs = ["music", "generate", "--prompt", args.prompt]
          if (args.lyrics) cliArgs.push("--lyrics", args.lyrics)
          if (args.instrumental) cliArgs.push("--instrumental")
          if (args.vocals) cliArgs.push("--vocals", args.vocals)
          if (args.bpm != null) cliArgs.push("--bpm", String(args.bpm))
          cliArgs.push("--out", outPath, "--non-interactive")
          const { stdout, stderr, exitCode } = await runMmx(cliArgs)
          if (exitCode !== 0) {
            return `mmx music generate failed (exit ${exitCode}):\n${stderr || stdout || "(no output)"}`
          }
          let msg = `Music generation complete.\n\nSaved to: ${outPath}`
          if (wasSuspicious && originalArg) {
            msg += `\n\n${warnSuspiciousOutDir(originalArg, outPath)}`
          }
          return msg
        },
      }),

      // ──────────────────────────────────────────────────────────────────
      // WEB SEARCH
      // ──────────────────────────────────────────────────────────────────
      mmx_search: tool({
        description:
          "Search the web using MiniMax's search API. Use when the user wants current information, news, facts, or anything time-sensitive. Returns a textual summary of search results.",
        args: {
          query: tool.schema.string().describe("The search query."),
        },
        async execute(args, ctx) {
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
            return `mmx search failed (exit ${exitCode}):\n${stderr || stdout || "(no output)"}`
          }
          return stdout.trim() || "(no results)"
        },
      }),

      // ──────────────────────────────────────────────────────────────────
      // VISION (image understanding)
      // ──────────────────────────────────────────────────────────────────
      mmx_vision: tool({
        description:
          "Describe or analyze an image using MiniMax's vision model. Pass a local file path or URL. Returns a textual description. Useful when the user uploads an image and wants analysis, OCR, or a description.",
        args: {
          image: tool.schema
            .string()
            .describe("Local file path or URL of the image."),
          prompt: tool.schema
            .string()
            .optional()
            .describe("Custom question about the image. Default 'Describe the image.'"),
        },
        async execute(args, ctx) {
          const cliArgs = ["vision", "describe", "--image", args.image]
          if (args.prompt) cliArgs.push("--prompt", args.prompt)
          cliArgs.push("--non-interactive")
          const { stdout, stderr, exitCode } = await runMmx(cliArgs)
          if (exitCode !== 0) {
            return `mmx vision describe failed (exit ${exitCode}):\n${stderr || stdout || "(no output)"}`
          }
          return stdout.trim() || "(no description)"
        },
      }),

      // ──────────────────────────────────────────────────────────────────
      // QUOTA CHECK
      // ──────────────────────────────────────────────────────────────────
      mmx_quota: tool({
        description:
          "Show current Token Plan usage and remaining quota (5-hour rolling and weekly windows). Use when the user asks about quota, usage, limits, or how many calls they have left.",
        args: {},
        async execute(_args, ctx) {
          let { stdout, stderr, exitCode } = await runMmx(["quota"])
          if (exitCode !== 0) {
            const fallback = await runMmx(["quota", "show", "--non-interactive"])
            if (fallback.exitCode === 0) {
              stdout = fallback.stdout
              stderr = fallback.stderr
              exitCode = fallback.exitCode
            } else {
              return `mmx quota failed (exit ${exitCode}):\n${stderr || "(no stderr)"}`
            }
          }
          const raw = stdout.trim()
          let data: any
          try {
            data = JSON.parse(raw)
          } catch {
            return raw || "(no quota info)"
          }
          const rows = (data.model_remains ?? []).map((m: any) => {
            const reset = new Date(m.end_time).toUTCString().replace(/^[^,]+,\s*/, "")
            return `| ${m.model_name} | ${m.current_interval_remaining_percent}% left | ${m.current_weekly_remaining_percent}% left | resets ${reset} |`
          })
          const header = "| Model | 5h window | Weekly | Next reset |\n|---|---|---|---|"
          return `Quota — Token Plan\n\n${header}\n${rows.join("\n")}\n`
        },
      }),
    },
  }
}
