// Minimal type stubs for adm-zip (no official @types package). We use a
// small subset of the API; surface only what we call.

declare module "adm-zip" {
  interface IZipEntry {
    entryName: string
    getData(): Buffer
  }
  class AdmZip {
    constructor(file?: string)
    addLocalFile(localPath: string, zipPath?: string, zipName?: string): void
    addFile(entryName: string, content: Buffer): void
    getEntries(): IZipEntry[]
    getEntry(name: string): IZipEntry | undefined
    extractAllTo(target: string, overwrite?: boolean): void
    writeZip(targetFilePath: string): void
    toBuffer(): Buffer
  }
  export = AdmZip
}
