import { randomBytes, createCipheriv, createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';
export const token = () => randomBytes(32).toString('base64url');
export const hash = s => createHash('sha256').update(s).digest('hex');
export function equal(a,b) { const x=Buffer.from(a),y=Buffer.from(b); return x.length===y.length && timingSafeEqual(x,y); }
export function seal(value,key) { const iv=randomBytes(12), c=createCipheriv('aes-256-gcm',key,iv); const data=Buffer.concat([c.update(JSON.stringify(value)),c.final()]); return Buffer.concat([iv,c.getAuthTag(),data]).toString('base64'); }
export function unseal(value,key) { const b=Buffer.from(value,'base64'),d=createDecipheriv('aes-256-gcm',key,b.subarray(0,12)); d.setAuthTag(b.subarray(12,28)); return JSON.parse(Buffer.concat([d.update(b.subarray(28)),d.final()]).toString()); }
export function localTime(date,zone) { const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date).map(x=>[x.type,x.value])); return {day:`${parts.year}-${parts.month}-${parts.day}`,time:`${parts.hour}:${parts.minute}`}; }
export function nextRun(schedule,now=new Date(),lastDay=null) { if(!schedule.enabled)return null; for(let m=1;m<=2940;m++){const d=new Date(Math.floor(now.getTime()/60000)*60000+m*60000); const local=localTime(d,schedule.zone); if(local.time===schedule.time&&`${schedule.zone}:${local.day}`!==lastDay)return d.toISOString();} return null; }
export function validateSettings(s) {
 if(!s || typeof s!=='object')throw Error('Invalid settings');
 for(const section of ['postgres','b2','smtp','schedule']) if(!s[section] || typeof s[section]!=='object')throw Error(`Missing ${section}`);
 const p=s.postgres,b=s.b2,e=s.smtp,t=s.schedule;
 for(const v of [p.password,p.ca,e.host,e.user,e.password,e.from])if(typeof v!=='string'||v.includes('\0'))throw Error('Invalid connection field');
 if(typeof e.enabled!=='boolean'||typeof t.zone!=='string')throw Error('Invalid settings');
 for(const v of [p.host,p.database,p.user,b.keyId,b.key,b.bucketId])if(typeof v!=='string'||!v.trim()||/[\r\n\0]/.test(v))throw Error('Database and B2 connection fields are required');
 if(!Number.isInteger(+p.port)||+p.port<1||+p.port>65535)throw Error('Invalid database port');
 if(!['verify-full','require','disable'].includes(p.sslmode))throw Error('Invalid PostgreSQL TLS mode');
 if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(t.time))throw Error('Invalid daily time');
 localTime(new Date(),t.zone);
 if(typeof t.enabled!=='boolean')throw Error('Invalid schedule');
 if(typeof b.prefix!=='string'||b.prefix.includes('\0'))throw Error('Invalid prefix');
 if(e.enabled){if(!e.host||!['tls','starttls'].includes(e.mode)||!Number.isInteger(+e.port)||+e.port<1||+e.port>65535)throw Error('Invalid SMTP connection'); if(!Array.isArray(e.recipients)||!e.recipients.length||e.recipients.length>20)throw Error('Provide 1–20 recipients'); for(const addr of [e.from,...e.recipients])if(typeof addr!=='string'||! /^[^\s<>@]+@[^\s<>@]+$/.test(addr))throw Error('Invalid email address');}
 return s;
}
export const defaults=()=>({postgres:{host:'',port:5432,database:'',user:'',password:'',sslmode:'verify-full',ca:''},b2:{keyId:'',key:'',bucketId:'',prefix:'backups/'},smtp:{enabled:false,host:'smtp.resend.com',port:465,mode:'tls',user:'resend',password:'',from:'',recipients:[]},schedule:{enabled:false,time:'03:00',zone:'America/Chicago'}});
