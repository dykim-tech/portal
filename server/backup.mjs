import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { createBackup, pruneExpiredBackups } from './backups.mjs';
const db=new DatabaseSync(resolve(process.env.DATA_DIR??'./data','portal.sqlite'),{readOnly:true});
try {
  const saved=await createBackup(db,resolve(process.env.BACKUP_DIR??'./backups'));
  console.log(`Backup saved: ${saved.name}`);
  pruneExpiredBackups(resolve(process.env.BACKUP_DIR??'./backups'));
} finally { db.close(); }
