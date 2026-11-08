import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { seal,unseal,defaults,hash } from './core.js';
export function openStore(env=process.env){
 const key=Buffer.from(env.APP_ENCRYPTION_KEY||'','base64'); if(key.length!==32)throw Error('APP_ENCRYPTION_KEY must encode 32 bytes');
 const dir=env.APP_DATA_DIR||'/data'; mkdirSync(dir,{recursive:true,mode:0o700});
 const db=new DatabaseSync(`${dir}/app.sqlite`); db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY,expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY,started TEXT NOT NULL,ended TEXT,trigger TEXT,status TEXT NOT NULL,object TEXT,size INTEGER,error TEXT,notification TEXT,upload_id TEXT);
 PRAGMA user_version=1;`);
 const get=k=>{const r=db.prepare('SELECT value FROM kv WHERE key=?').get(k);return r?JSON.parse(r.value):null;};
 const set=(k,v)=>db.prepare('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k,JSON.stringify(v));
 if(get('identity')!==env.APP_USER_EMAIL){db.exec('DELETE FROM sessions');db.prepare("DELETE FROM kv WHERE key IN ('credential','enrollment')").run();set('identity',env.APP_USER_EMAIL);}
 return {db,get,set,key,settings:()=>get('settings')?unseal(get('settings'),key):defaults(),saveSettings:s=>set('settings',seal(s,key)),reset:()=>{db.exec('DELETE FROM sessions');db.prepare("DELETE FROM kv WHERE key IN ('credential','enrollment')").run();},session:t=>db.prepare('SELECT id FROM sessions WHERE id=? AND expires>?').get(hash(t),Date.now())};
}
