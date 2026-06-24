// Project importer. Validates a zip, runs integrity_check on the included
// DB, extracts to ~/.hmanlab/projects/<name>/, and inserts a row in the
// root projects table.
//
// Refuses imports whose manifest.schema_version exceeds the current version
// (per PRD open Q1). Refuses imports whose DB fails integrity_check. Refuses
// duplicate-name imports unless the caller provides an explicit override.

import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import { openProjectDb, openRootDb } from "../db.js"
import { ensureHome, hmanlabHome, projectsDirPath } from "../config.js"
import { projectGet, projectRegister } from "../project/registry.js"
import { CURRENT_SCHEMA_VERSION, type Manifest, ManifestSchema } from "./manifest.js"

export type ImportResult = {
  name: string
  memoryCount: number
  channels: string[]
  manifest: Manifest
}

/**
 * Import a project from a zip. The zip must contain project.yaml +
 * hmanlab.db + manifest.json at the root.
 */
export async function projectImport(args: {
  archivePath: string
  name?: string
}): Promise<ImportResult> {
  if (!existsSync(args.archivePath)) {
    throw new Error(`Archive not found: ${args.archivePath}`)
  }
  ensureHome()

  const zip = new AdmZip(args.archivePath)
  const entries = new Set(zip.getEntries().map((e) => e.entryName))

  for (const required of ["project.yaml", "hmanlab.db", "manifest.json"]) {
    if (!entries.has(required)) {
      throw new Error(
        `Archive is missing required entry "${required}". ` +
          `Got: ${[...entries].join(", ")}`,
      )
    }
  }

  const manifestEntry = zip.getEntry("manifest.json")!
  let manifest: Manifest
  try {
    manifest = ManifestSchema.parse(JSON.parse(manifestEntry.getData().toString("utf-8")))
  } catch (err) {
    throw new Error(`manifest.json is invalid: ${(err as Error).message}`)
  }

  if (manifest.schema_version > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Archive was exported with schema_version ${manifest.schema_version}; ` +
        `this server supports up to ${CURRENT_SCHEMA_VERSION}. ` +
        `Upgrade hmanlab-memory before importing.`,
    )
  }

  // Extract to a temp dir first so we can integrity-check before committing.
  const tmpDir = join(hmanlabHome(), `.import-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(tmpDir, { recursive: true })
  zip.extractAllTo(tmpDir, true)

  const tmpDb = join(tmpDir, "hmanlab.db")
  if (!existsSync(tmpDb)) {
    throw new Error(`Archive's hmanlab.db missing after extract`)
  }

  // Integrity check before we touch the user's projects dir.
  const checkDb = openProjectDb(tmpDb)
  try {
    const result = checkDb.prepare("PRAGMA integrity_check").get() as
      | { integrity_check: string }
      | undefined
    if (!result || result.integrity_check !== "ok") {
      throw new Error(
        `Archive's hmanlab.db failed integrity_check: ${result?.integrity_check ?? "(no result)"}`,
      )
    }
  } finally {
    checkDb.close()
  }

  const targetName = args.name ?? manifest.project_name

  // Check for duplicate name.
  const rootDb = openRootDb()
  try {
    const existing = projectGet(rootDb, targetName)
    if (existing && !args.name) {
      throw new Error(
        `Project "${targetName}" is already registered. ` +
          `Pass --name to import under a different name, or unregister first.`,
      )
    }
  } finally {
    rootDb.close()
  }

  // Commit: move files into ~/.hmanlab/projects/<name>/ and register.
  const projectsRoot = projectsDirPath()
  const targetDir = join(projectsRoot, targetName)
  mkdirSync(targetDir, { recursive: true })

  // Read project.yaml so we can register with the original description / path.
  const yamlPath = join(tmpDir, "project.yaml")
  const yamlRaw = JSON.parse(
    JSON.stringify({
      name: targetName,
      // Use a placeholder path; user can re-register later with the real one.
      // The CLI's "import" flow uses the path the user passed.
      path: targetDir,
    }),
  )

  // Copy files.
  writeFileSync(join(targetDir, "project.yaml"), zip.getEntry("project.yaml")!.getData())
  // Read tmpDump bytes and write to final destination.
  const tmpDbBytes = zip.getEntry("hmanlab.db")!.getData()
  writeFileSync(join(targetDir, "hmanlab.db"), tmpDbBytes)

  // Register in root.projects. description / path come from the user or yaml.
  const rootDb2 = openRootDb()
  try {
    projectRegister(rootDb2, projectsRoot, {
      name: targetName,
      path: yamlRaw.path,
    })
  } finally {
    rootDb2.close()
  }

  // Clean up temp dir.
  try {
    const { rmSync } = await import("node:fs")
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    // ignore
  }

  return {
    name: targetName,
    memoryCount: manifest.memory_count,
    channels: manifest.channels,
    manifest,
  }
}
