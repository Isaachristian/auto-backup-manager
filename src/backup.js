import { spawn } from 'node:child_process';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { B2 } from './b2.js';
import { sendMail } from './smtp.js';
export function safeError(error,s){let text=String(error.message||error).slice(0,4000);for(const secret of [s.postgres.password,s.b2.key,s.smtp.password])if(secret)text=text.split(secret).join('[redacted]');return text;}
export async function postgresProcess(p,args){let dir;const env={...process.env,PGPASSWORD:p.password,PGSSLMODE:p.sslmode,PGCONNECT_TIMEOUT:'15'};if(p.ca){dir=await mkdtemp(join(tmpdir(),'backup-ca-'));await writeFile(join(dir,'ca.pem'),p.ca,{mode:0o600});env.PGSSLROOTCERT=join(dir,'ca.pem');}const child=spawn(args[0],['--host',p.host,'--port',String(p.port),'--username',p.user,'--dbname',p.database,...args.slice(1)],{env,stdio:['ignore','pipe','pipe']});return {child,cleanup:()=>dir?rm(dir,{recursive:true,force:true}):Promise.resolve()};}
export class BackupManager{
 constructor(store){this.store=store;this.active=null;}
 async recover(){const rows=this.store.db.prepare("SELECT * FROM runs WHERE status='running'").all();for(const r of rows){let status='interrupted',error='Container stopped during backup';try{const b=new B2(this.store.settings().b2);if(r.upload_id){const info=await b.info(r.upload_id);if(info.action==='upload'){this.store.db.prepare("UPDATE runs SET status='success',ended=?,size=? WHERE id=?").run(new Date().toISOString(),info.contentLength,r.id);continue;}await b.cancel(r.upload_id);}}catch{error+='; check B2 for unfinished upload';}this.store.db.prepare('UPDATE runs SET status=?,ended=?,error=? WHERE id=?').run(status,new Date().toISOString(),error,r.id);}}
 start(trigger){if(this.active)throw Error('A backup is already running');const s=this.store.settings(),id=randomUUID(),started=new Date().toISOString(),name=`${s.b2.prefix}${started.replace(/[:.]/g,'-')}-${id}.sql.gz`;this.store.db.prepare('INSERT INTO runs(id,started,trigger,status,object) VALUES (?,?,?,?,?)').run(id,started,trigger,'running',name);this.active=this.run(id,name,s).finally(()=>{this.active=null;});return id;}
 async run(id,name,s){let processInfo;try{processInfo=await postgresProcess(s.postgres,['pg_dump','--format=plain','--no-password']);const child=processInfo.child;this.child=child;let stderr='';child.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(-4000);});const exit=once(child,'close').then(([code])=>{if(code!==0)throw Error(`pg_dump failed (${code}): ${stderr}`);});const gzip=createGzip();const pump=pipeline(child.stdout,gzip);const source=(async function*(){for await(const b of gzip)yield b;await exit;await pump;})();exit.catch(e=>gzip.destroy(e));pump.catch(()=>{});const result=await new B2(s.b2).upload(source,name,fileId=>this.store.db.prepare('UPDATE runs SET upload_id=? WHERE id=?').run(fileId,id));this.store.db.prepare("UPDATE runs SET status='success',ended=?,size=? WHERE id=?").run(new Date().toISOString(),result.size,id);
 }catch(e){processInfo?.child.kill('SIGTERM');const error=safeError(e,s);this.store.db.prepare("UPDATE runs SET status='failed',ended=?,error=? WHERE id=?").run(new Date().toISOString(),error,id);if(s.smtp.enabled){try{await sendMail(s.smtp,'Database backup failed',`Run: ${id}\nDatabase: ${s.postgres.database}\nTime: ${new Date().toISOString()}\n${error}`);}catch(mailError){this.store.db.prepare('UPDATE runs SET notification=? WHERE id=?').run(safeError(mailError,s),id);}}}finally{this.child=null;await processInfo?.cleanup();}}
}
