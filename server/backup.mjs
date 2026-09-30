import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
const db=new DatabaseSync(resolve(process.env.DATA_DIR??'./data','portal.sqlite'),{readOnly:true});
mkdirSync('backups',{recursive:true});
const path=join('backups',`portal-${new Date().toISOString().replace(/[:.]/g,'-')}.sqlite`);
await backup(db,path);db.close();console.log(`Backup saved: ${path}`);
