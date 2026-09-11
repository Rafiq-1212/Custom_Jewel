/**
 * Browser-side "save this as a file" helper, shared by every download button
 * in the app (components/DownloadPanel.tsx, components/ExportPanel.tsx) so
 * the anchor-click dance is written exactly once. Client-only — it touches
 * `document` and `URL.createObjectURL`.
 */

export function downloadFile(filename: string, content: string | Blob, mimeType?: string): void {
  const blob = typeof content === 'string' ? new Blob([content], { type: mimeType }) : content;
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** Decode a `data:` URL into a Blob without a network round-trip. */
export async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const response = await fetch(dataUrl);
  return response.blob();
}
