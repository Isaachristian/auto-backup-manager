import { randomBytes } from 'node:crypto';
import { openStore } from '../src/store.js';
import { token,hash } from '../src/core.js';
const cmd=process.argv[2];
if(cmd==='key'){console.log(randomBytes(32).toString('base64'));}
else if(['enroll','reset'].includes(cmd)){const store=openStore();if(cmd==='enroll'&&store.get('credential'))throw Error('Already enrolled; use reset to invalidate the passkey and sessions');if(cmd==='reset')store.reset();const value=token();store.set('enrollment',{hash:hash(value),expires:Date.now()+15*60000});console.log(`Enrollment token (valid 15 minutes):\n${value}`);store.db.close();}
else if(cmd==='backup-state'){const store=openStore();const destination=process.argv[3];if(!destination)throw Error('Provide an output SQLite path');const { backup }=await import('node:sqlite');await backup(store.db,destination);store.db.close();console.log('State backed up; preserve APP_ENCRYPTION_KEY separately.');}
else {console.log('Usage: npm run admin -- key | enroll | reset | backup-state OUTPUT');process.exitCode=1;}
