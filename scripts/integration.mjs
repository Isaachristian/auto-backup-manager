// Creates an isolated disposable PostgreSQL container; no host ports are exposed.
import { execFile,spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID,randomBytes } from 'node:crypto';
import { gzipSync,gunzipSync } from 'node:zlib';
const exec=promisify(execFile),runtime=process.env.CONTAINER_RUNTIME||'podman',image=process.env.APP_IMAGE||'auto-backup-manager:local',name='abm-test-'+randomUUID();
const run=(...args)=>exec(runtime,args,{maxBuffer:16*1024*1024});
try{
 await run('run','--rm','-d','--name',name,'--network','none','-e','POSTGRES_HOST_AUTH_METHOD=trust','docker.io/library/postgres:16');
 let ready=false;for(let i=0;i<60;i++){try{await run('exec',name,'pg_isready','-U','postgres');ready=true;break;}catch{await new Promise(r=>setTimeout(r,500));}}if(!ready)throw Error('Postgres did not start');
 await run('exec',name,'psql','-U','postgres','-c',"CREATE DATABASE source;");
 await run('exec',name,'psql','-U','postgres','-d','source','-c',"CREATE TABLE records(id integer PRIMARY KEY, value text); INSERT INTO records VALUES (1, 'backup works');");
 const {stdout}=await run('run','--rm','--network',`container:${name}`,image,'pg_dump','--host','127.0.0.1','--username','postgres','--dbname','source','--format=plain');
 const archive=gzipSync(stdout);if(!archive.length)throw Error('Empty archive');
 await run('exec',name,'psql','-U','postgres','-c','CREATE DATABASE restored;');
 await new Promise((resolve,reject)=>{const p=spawn(runtime,['exec','-i',name,'psql','-v','ON_ERROR_STOP=1','-U','postgres','-d','restored'],{stdio:['pipe','ignore','inherit']});p.on('error',reject);p.on('close',code=>code===0?resolve():reject(Error('Restore failed')));p.stdin.end(gunzipSync(archive));});
 const restored=await run('exec',name,'psql','-U','postgres','-d','restored','-Atc','SELECT value FROM records WHERE id=1');if(restored.stdout.trim()!=='backup works')throw Error('Restored data mismatch');
 console.log('PASS: PostgreSQL 16 dump, gzip archive, SQL restore, and restored data verification.');
 const app=name+'-app';
 try {
 await run('run','--rm','-d','--name',app,'--network','none','-e','APP_ORIGIN=https://backups.example.test','-e','APP_USER_EMAIL=owner@example.test','-e',`APP_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`,image);
 let healthy=false;for(let i=0;i<30;i++){try{await run('exec',app,'node','-e',"fetch('http://127.0.0.1:3000/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))");healthy=true;break;}catch{await new Promise(r=>setTimeout(r,200));}}if(!healthy)throw Error('App container not healthy');
 const uid=await run('exec',app,'id','-u');if(uid.stdout.trim()==='0')throw Error('App runs as root');
 await run('exec',app,'node','scripts/admin.js','enroll');
 await run('exec',app,'node','--input-type=module','-e',"import {openStore} from './src/store.js';const s=openStore();s.set('smoke','persisted');s.db.close();");
 await run('restart',app);
 const state=await run('exec',app,'node','--input-type=module','-e',"import {openStore} from './src/store.js';const s=openStore();if(s.get('smoke')!=='persisted'||!s.get('enrollment'))process.exit(1);s.db.close();");
 await run('exec',app,'node','scripts/admin.js','reset');
 console.log('PASS: non-root app container, health endpoint, enrollment/reset commands, and SQLite persistence across restart.');
 }finally{await run('stop','--time','5',app).catch(()=>{});}

}finally{await run('stop','--time','5',name).catch(()=>{});}
