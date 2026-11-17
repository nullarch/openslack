import { cp, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import * as sqlite from 'node:sqlite';

/**
 * Copy a data directory while the server keeps running: the database through
 * SQLite's online backup API (a consistent snapshot, WAL included), then the
 * uploaded files. Files added after the snapshot may be copied too; they are
 * simply unreferenced in the restored database.
 */
export async function backupDataDir(dataDir: string, destination: string): Promise<{ database: string; files: boolean }> {
  const backup = (sqlite as { backup?: (db: sqlite.DatabaseSync, path: string) => Promise<number> }).backup;
  if (!backup) throw new Error('Backups need Node.js 22.16 or newer (node:sqlite backup).');
  const source = join(dataDir, 'app.db');
  await stat(source);
  await mkdir(destination, { recursive: true });
  const target = join(destination, 'app.db');
  const db = new sqlite.DatabaseSync(source, { readOnly: true });
  try {
    await backup(db, target);
  } finally {
    db.close();
  }
  const files = join(dataDir, 'files');
  const hasFiles = await stat(files).then(
    () => true,
    () => false,
  );
  if (hasFiles) await cp(files, join(destination, 'files'), { recursive: true, force: true });
  return { database: target, files: hasFiles };
}
