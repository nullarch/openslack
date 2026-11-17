import { contextBridge, ipcRenderer } from 'electron';

// Only the "add a server" page gets this bridge; server pages run with no preload at all.
contextBridge.exposeInMainWorld('desktop', {
  addServer: (input: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('add-server', input),
  brand: (): Promise<{ name: string }> => ipcRenderer.invoke('brand'),
});
