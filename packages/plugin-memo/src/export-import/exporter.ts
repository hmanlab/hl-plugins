// Project exporter. Bundles project.yaml + hmanlab.db + manifest.json into
// a zip at the requested output path (default: ~/hmanlab-exports/<name>-<date>.zip).
//
// Round-trip fidelity is preserved by VACUUM INTO (the SQLite-blessed way to
// snapshot a live DB into a clean file with no WAL). FTS5 indexes come along
// for free — they're inside the DB.

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import AdmZip from "adm-zip"
import { openProjectDb, openRootDb } from "../db.js"
import { projectDbPath, projectRegister } from "../project/registry.js"
import { ensureHome, hmanlabHome, projectsDirPath } from "../config.js"
import { CURRENT_SCHEMA_VERSION, type Manifest, ManifestSchema } from "./manifest.js"

export type ExportResult = {
  path: string
  sizeBytes: number
  memoryCount: number
}

function todayIsoDate(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10)
}

/** Default export dir under the user's home. */
function defaultExportDir(): string {
  return join(hmanlabHome(), "..", "hmanlab-exports")
}

/**
 * Export a project to a zip. The zip contains exactly three entries:
 *   project.yaml, hmanlab.db, manifest.json
 * The root.db (with user_persona + ai_personas) is NEVER included.
 */
export async function projectExport(args: {
  name: string
  outputPath?: string
  now?: number
}): Promise<ExportResult> {
  const now = args.now ?? Date.now()
  ensureHome()

  const projectsRoot = projectsDirPath()
  const dbPath = projectDbPath(projectsRoot, args.name)
  const yamlPath = join(projectsRoot, args.name, "project.yaml")
  if (!existsSync(dbPath)) {
    throw new Error(`Project "${args.name}" has no database at ${dbPath}`)
  }
  if (!existsSync(yamlPath)) {
    throw new Error(`Project "${args.name}" has no project.yaml at ${yamlPath}`)
  }

  // Snapshot the live DB to a temp file via VACUUM INTO.
  const tmpDump = join(
    tmpdir(),
    `hmanlab-export-${args.name}-${now}-${Math.random().toString(36).slice(2)}.db`,
  )
  const projectDb = openProjectDb(dbPath)
  try {
    projectDb.exec(`VACUUM INTO '${tmpDump.replace(/'/g, "''")}'`)
  } finally {
    projectDb.close()
  }

  // Count memories + channels.
  const dumpDb = openProjectDb(tmpDump)
  try {
    const count = (dumpDb.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n
    const channelRows = dumpDb
      .prepare("SELECT DISTINCT channel FROM memories WHERE channel IS NOT NULL ORDER BY channel")
      .all() as Array<{ channel: string }>

    const manifest: Manifest = ManifestSchema.parse({
      hmanlab_memory_version: "1.0.0",
      exported_at: new Date(now).toISOString(),
      project_name: args.name,
      schema_version: CURRENT_SCHEMA_VERSION,
      memory_count: count,
      channels: channelRows.map((r) => r.channel),
      embedding_model: "hash-embedder-v1", // Phase 06 placeholder; real model in 1.1
      embedding_dim: 384,
    })

    const outPath = args.outputPath ?? join(defaultExportDir(), `${args.name}-${todayIsoDate(now)}.zip`)
    mkdirSync(join(outPath, ".."), { recursive: true })

    const zip = new AdmZip()
    zip.addLocalFile(yamlPath)
    zip.addLocalFile(tmpDump, "", "hmanlab.db")
    zip.addFile("manifest.json", Buffer.from(JSON.stringify(manifest, null, 2)))
    zip.writeZip(outPath)

    return {
      path: outPath,
      sizeBytes: statSync(outPath).size,
      memoryCount: count,
    }
  } finally {
    dumpDb.close()
    // Best-effort cleanup of the temp dump.
    try {
      const { unlinkSync } = await import("node:fs")
      unlinkSync(tmpDump)
    } catch {
      // ignore
    }
  }
}
