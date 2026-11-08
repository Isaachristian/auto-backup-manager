import { B2 } from '../src/b2.js';
import assert from 'node:assert/strict';
// No external network: consume one GiB through the real multipart buffering code.
class Sink extends B2{async call(method){if(method==='b2_start_large_file')return {fileId:'test'};if(method==='b2_get_upload_part_url')return {uploadUrl:'unused',authorizationToken:'test'};return {};}async request(){return {};}}
const source=(async function*(){for(let i=0;i<1024;i++)yield Buffer.alloc(1024*1024,i%256);})();let peak=0;const timer=setInterval(()=>peak=Math.max(peak,process.memoryUsage().rss),1);const b=new Sink({bucketId:'test'});const result=await b.upload(source,'test.sql.gz',()=>{});clearInterval(timer);peak=Math.max(peak,process.memoryUsage().rss);assert.equal(result.size,1024**3);assert.ok(peak<300*1024**2,`Unexpected memory use: ${peak}`);console.log(`PASS: streamed 1 GiB, RSS <= ${(peak/1024**2).toFixed(1)} MiB; no archive file created.`);
