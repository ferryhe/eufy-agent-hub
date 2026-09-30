type ExportFile = { createWritable(): Promise<WritableStream> }
type ExportFilePicker = (options: {
  suggestedName: string
  types: Array<{ description: string; accept: Record<string, string[]> }>
}) => Promise<ExportFile>

const safeFilename = (name: string) => name.replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').replace(/[. ]+$/g, '').slice(0, 180) || 'recording.mp4'

export async function chooseExportFile(name: string): Promise<ExportFile | undefined> {
  const host = window as Window & { showSaveFilePicker?: ExportFilePicker }
  if (!host.showSaveFilePicker) throw Object.assign(new Error('SAVE_FILE_PICKER_UNAVAILABLE'), { code: 'SAVE_FILE_PICKER_UNAVAILABLE' })
  try {
    return await host.showSaveFilePicker({
      suggestedName: safeFilename(name),
      types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }],
    })
  } catch (error) { if ((error as { name?: string })?.name === 'AbortError') return undefined; throw error }
}

export async function saveArtifactToFile(file: ExportFile, url: string) {
  const response = await fetch(url)
  if (!response.ok || !response.body) throw Object.assign(new Error('EXPORT_FILE_UNAVAILABLE'), { code: 'EXPORT_FILE_UNAVAILABLE' })
  await response.body.pipeTo(await file.createWritable())
}
