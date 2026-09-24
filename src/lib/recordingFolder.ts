/** The folder a new recording is filed into: the folder open in the sidebar, else none. */
export function folderForNewRecording(viewedFolderId: number | null): number | null {
  return viewedFolderId ?? null;
}
