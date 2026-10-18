// DSE mailbox: no model key or automatic task is embedded in this service.
// Apply schema migrations before starting. DB = D1; BUCKET = private R2.
const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_JSON = 300000;
const INITIAL_PROFILE = {exam_year:2027, version:1, updated_at:'2026-10-18', source:'哥哥確認', subjects:[], grades:[], goals:[], notes:'科目、成績、入學年份與目標待妹妹補充；2027 HKDSE 已確認。'};
const INITIAL_AGENT = {active:false, last_checked_at:null, schedule:null};
class HttpError extends Error { constructor(status,message){ super(message);this.status=status; } }
const fail=(s,m)=>{throw new HttpError(s,m);};
const iso=()=>new Date().toISOString();
const row=(env,sql,...params)=>env.DB.prepare(sql).bind(...params).first();
const rows=async(env,sql,...params)=>(await env.DB.prepare(sql).bind(...params).all()).results;
const run=(env,sql,...params)=>env.DB.prepare(sql).bind(...params).run();
const stmt=(env,sql,...params)=>env.DB.prepare(sql).bind(...params);
const sha=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))).map(b=>b.toString(16).padStart(2,'0')).join('');
const equal=async(a,b)=>Boolean(a&&b)&&(await sha(a))===(await sha(b));
const textValue=(v,name,max=20000)=>{if(typeof v!=='string'||!v.trim()||v.length>max)fail(400,name+'格式不正確');return v.trim();};
const integer=v=>{if(!Number.isSafeInteger(v)||v<1)fail(400,'留言編號不正確');return v;};
const idKey=b=>textValue(b.idempotency_key,'提交識別碼',100);
async function boundedBody(request,limit){
 if(Number(request.headers.get('content-length'))>limit)fail(413,'內容太大');
 if(!request.body)return new Uint8Array();
 const reader=request.body.getReader(),chunks=[];let length=0;
 while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>limit){await reader.cancel();fail(413,'內容太大');}chunks.push(value);}
 const data=new Uint8Array(length);let offset=0;for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.length;}return data;
}
async function jsonBody(request){
 if(!(request.headers.get('content-type')||'').toLowerCase().startsWith('application/json'))fail(415,'請以 JSON 提交');
 if(Number(request.headers.get('content-length'))>MAX_JSON)fail(413,'內容太長');
 const s=new TextDecoder().decode(await boundedBody(request,MAX_JSON));
 try{const b=JSON.parse(s);if(!b||Array.isArray(b)||typeof b!=='object')fail(400,'資料格式不正確');return b;}catch(e){if(e instanceof HttpError)throw e;fail(400,'資料格式不正確');}
}
function allowedOrigins(request,env){return new Set([new URL(request.url).origin,...(env.ALLOWED_ORIGINS||'').split(',').map(x=>x.trim()).filter(Boolean)]);}
function checkOrigin(request,env){const origin=request.headers.get('origin');if(origin&&!allowedOrigins(request,env).has(origin))fail(403,'此網頁未獲信箱授權');}
function response(request,env,data,status=200,extra={}){
 const h=new Headers({'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer',...extra});
 const origin=request.headers.get('origin');if(origin&&allowedOrigins(request,env).has(origin)){h.set('access-control-allow-origin',origin);h.set('vary','Origin');h.set('access-control-allow-headers','Authorization, Content-Type, MCP-Protocol-Version');h.set('access-control-allow-methods','GET, POST, PUT, DELETE, OPTIONS');}
 return new Response(data===null?null:JSON.stringify(data),{status,headers:h});
}
async function actor(request,env){
 const bearer=(request.headers.get('authorization')||'').replace(/^Bearer\s+/i,'');
 if(await equal(bearer,env.OWNER_API_KEY))return {role:'owner',key:'owner'};
 if(await equal(bearer,env.AGENT_API_KEY))return {role:'agent',key:'agent'};
 // Enable only behind Sites dispatch, which supplies verified identity headers.
 if(env.TRUST_SITES_IDENTITY==='true'&&env.OWNER_EMAIL&&request.headers.get('oai-authenticated-user-email')?.toLowerCase()===env.OWNER_EMAIL.toLowerCase())return {role:'owner',key:'owner'};
 if(bearer){const inv=await row(env,'SELECT id,role FROM invitations WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?',await sha(bearer),iso());if(inv)return {role:inv.role,key:inv.id};}
 fail(401,'這是私人信箱，請使用你的邀請連結或登入。');
}
const ownerOnly=a=>{if(a.role!=='owner')fail(403,'只有哥哥可以進行此操作');};
const agentOnly=a=>{if(!['owner','agent'].includes(a.role))fail(403,'這項操作需要助教權限');};
async function setting(env,key,fallback){const s=await row(env,'SELECT value FROM settings WHERE key=?',key);return s?JSON.parse(s.value):fallback;}
async function setSetting(env,key,value){await run(env,'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',key,JSON.stringify(value));}
function shapeThread(t){return {...t,status:t.last_human_id>t.answered_through_id?'pending':t.next_status};}
function attachmentURL(id){return '/api/attachments/'+encodeURIComponent(id);}
async function threadData(env,id){
 const t=await row(env,'SELECT * FROM threads WHERE id=?',id);if(!t)fail(404,'找不到這封留言');
 const messages=await rows(env,'SELECT id,role,body,created_at,answered_through_id FROM messages WHERE thread_id=? ORDER BY id',id);
 const files=await rows(env,'SELECT a.id,a.name,a.mime,a.bytes,a.message_id FROM attachments a JOIN messages m ON m.id=a.message_id WHERE m.thread_id=?',id);
 return {thread:shapeThread(t),messages:messages.map(m=>({...m,attachments:files.filter(f=>f.message_id===m.id).map(f=>({...f,url:attachmentURL(f.id)}))}))};
}
async function validateFiles(env,a,ids){
 if(ids===undefined)return [];if(!Array.isArray(ids)||ids.length>3||new Set(ids).size!==ids.length)fail(400,'每則留言最多三張圖片');
 for(const id of ids){const f=await row(env,'SELECT * FROM attachments WHERE id=?',textValue(id,'附件編號',80));if(!f||f.uploader!==a.key||f.message_id!==null)fail(403,'附件不可用，請重新上傳');}return ids;
}
async function createHuman(env,a,b,threadId){
 if(a.role==='agent')fail(403,'助教請使用回覆入口');
 const body=textValue(b.body,'問題內容');
 const key='human:'+a.key+':'+(threadId||'new')+':'+idKey(b);
 const existing=await row(env,'SELECT id,thread_id FROM messages WHERE idempotency_key=?',key);if(existing)return {id:existing.thread_id,message_id:existing.id,duplicate:true};
 const files=await validateFiles(env,a,b.attachment_ids);
 const stamp=iso();let id=threadId;const batch=[];
 if(id){if(!await row(env,'SELECT id FROM threads WHERE id=?',id))fail(404,'找不到這封留言');}
 else{id=(await sha('thread:'+key)).slice(0,32);batch.push(stmt(env,'INSERT INTO threads(id,title,category,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING',id,textValue(b.title,'問題標題',120),typeof b.category==='string'?b.category.slice(0,30):'學習提問',stamp,stamp));}
 batch.push(stmt(env,'INSERT INTO messages(thread_id,role,body,created_at,idempotency_key) VALUES(?,?,?,?,?) ON CONFLICT(idempotency_key) DO NOTHING',id,a.role,body,stamp,key));
 batch.push(stmt(env,"UPDATE threads SET last_human_id=(SELECT MAX(id) FROM messages WHERE thread_id=? AND role!='assistant'),updated_at=? WHERE id=?",id,stamp,id));
 for(const file of files)batch.push(stmt(env,'UPDATE attachments SET message_id=(SELECT id FROM messages WHERE idempotency_key=?) WHERE id=? AND uploader=? AND message_id IS NULL',key,file,a.key));
 await env.DB.batch(batch);
 const saved=await row(env,'SELECT id,thread_id FROM messages WHERE idempotency_key=?',key);return {id:saved.thread_id,message_id:saved.id};
}
async function publishReply(env,b){
 const id=textValue(b.thread_id,'問題編號',80), through=integer(b.through_message_id), body=textValue(b.body,'回答',60000);
 const next=b.status==='needs_info'?'needs_info':'replied',key='answer:'+id+':'+through;
 const existing=await row(env,'SELECT id FROM messages WHERE idempotency_key=?',key);
 if(existing){const notice=await row(env,'SELECT id FROM sync_outbox WHERE reply_message_id=?',existing.id);return {message_id:existing.id,sync_id:notice?.id,duplicate:true};}
 const data=await threadData(env,id),t=data.thread;
 if(t.last_human_id!==through||through<=t.answered_through_id)fail(409,'問題已有變更，請重新讀取最新留言再回答');
 const questions=data.messages.filter(m=>m.role!=='assistant'&&m.id>t.answered_through_id&&m.id<=through);
 if(!questions.length)fail(409,'沒有待回覆的新留言');
 const questionText=questions.map(m=>(m.role==='owner'?'【哥哥補充】':'【妹妹原文】')+'\n'+m.body).join('\n\n');
 const stamp=iso();
 const written=await env.DB.batch([
  stmt(env,'INSERT INTO messages(thread_id,role,body,created_at,idempotency_key,answered_through_id) SELECT ?,?,?,?,?,? FROM threads WHERE id=? AND last_human_id=? AND answered_through_id<? ON CONFLICT(idempotency_key) DO NOTHING',id,'assistant',body,stamp,key,through,id,through,through),
  stmt(env,'UPDATE threads SET answered_through_id=?,next_status=?,updated_at=? WHERE id=? AND answered_through_id<? AND EXISTS(SELECT 1 FROM messages WHERE idempotency_key=?)',through,next,stamp,id,through,key),
  stmt(env,'INSERT INTO sync_outbox(reply_message_id,thread_id,title,question_text,question_messages,answer_text,created_at) SELECT id,?,?,?,?,?,? FROM messages WHERE idempotency_key=? ON CONFLICT(reply_message_id) DO NOTHING',id,t.title,questionText,JSON.stringify(questions),body,stamp,key)
 ]);
 const saved=await row(env,'SELECT id FROM messages WHERE idempotency_key=?',key);if(!saved)fail(409,'妹妹剛剛補充了內容，請重新讀取後再回答');
 const notice=await row(env,'SELECT id FROM sync_outbox WHERE reply_message_id=?',saved.id);return {message_id:saved.id,sync_id:notice.id,duplicate:written[0]?.meta?.changes===0};
}
async function pending(env){const list=await rows(env,'SELECT * FROM threads WHERE last_human_id>answered_through_id ORDER BY updated_at LIMIT 50');return {profile:await setting(env,'profile',INITIAL_PROFILE),threads:await Promise.all(list.map(t=>threadData(env,t.id)))};}
function threadURL(env,id){try{const u=new URL(env.FRONTEND_URL);if(u.protocol!=='https:'&&!['localhost','127.0.0.1','terminal.local'].includes(u.hostname))return null;u.hash='';u.searchParams.set('thread',id);return u.toString();}catch(_){return null;}}
async function syncItems(env,onlyPending=false){const items=await rows(env,'SELECT * FROM sync_outbox'+(onlyPending?' WHERE notified_at IS NULL':'')+' ORDER BY id DESC LIMIT 100');return {items:items.map(x=>({...x,thread_url:threadURL(env,x.thread_id),question_messages:JSON.parse(x.question_messages)}))};}
async function acknowledge(env,b){
 const id=integer(b.sync_id),ref=textValue(b.delivery_reference,'已送達的對話或訊息識別',500);
 const notice=await row(env,'SELECT id,notified_at FROM sync_outbox WHERE id=?',id);if(!notice)fail(404,'找不到同步記錄');
 if(!notice.notified_at)await run(env,'UPDATE sync_outbox SET notified_at=?,delivery_reference=? WHERE id=? AND notified_at IS NULL',iso(),ref,id);
 return {id,acknowledged:true};
}
async function upload(request,env,a){
 if(!env.BUCKET)fail(503,'圖片上傳尚未接通');
 if(Number(request.headers.get('content-length'))>MAX_IMAGE+65536)fail(413,'每張圖片上限 5 MB');
 let form;try{form=await new Response(await boundedBody(request,MAX_IMAGE+65536),{headers:{'content-type':request.headers.get('content-type')||''}}).formData();}catch(e){if(e instanceof HttpError)throw e;fail(400,'圖片上傳格式不正確');}const f=form.get('file');if(!f||typeof f.arrayBuffer!=='function')fail(400,'請選擇圖片');
 if(f.size>MAX_IMAGE||f.size<8)fail(413,'請選擇 5 MB 以內的圖片');
 const bytes=new Uint8Array(await f.arrayBuffer());
 const png=bytes[0]===137&&bytes[1]===80&&bytes[2]===78&&bytes[3]===71;
 const jpg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
 const gif=String.fromCharCode(...bytes.slice(0,6)).startsWith('GIF8');
 const webp=String.fromCharCode(...bytes.slice(0,4))==='RIFF'&&String.fromCharCode(...bytes.slice(8,12))==='WEBP';
 const mime=png?'image/png':jpg?'image/jpeg':gif?'image/gif':webp?'image/webp':null;if(!mime)fail(415,'請使用 JPG、PNG、GIF 或 WebP 圖片');
 const id=crypto.randomUUID(),name=(f.name||'題目圖片').replace(/[\x00-\x1f\\/]/g,'_').slice(0,180);
 await env.BUCKET.put('images/'+id,bytes,{httpMetadata:{contentType:mime}});
 try{await run(env,'INSERT INTO attachments(id,name,mime,bytes,uploader,created_at) VALUES(?,?,?,?,?,?)',id,name,mime,bytes.length,a.key,iso());}catch(e){await env.BUCKET.delete('images/'+id);throw e;}
 return {id,url:attachmentURL(id),name};
}
async function fileRecord(env,a,id){const f=await row(env,'SELECT * FROM attachments WHERE id=?',id);if(!f||(f.message_id===null&&f.uploader!==a.key))fail(404,'找不到圖片');return f;}
const TOOL_DEFINITIONS=[
 {name:'mailbox_read_pending',description:'讀取真人新增、尚未回答的 DSE 問題、前文和學生檔案。',inputSchema:{type:'object',properties:{},additionalProperties:false}},
 {name:'mailbox_read_thread',description:'讀取一個問題的完整問答。',inputSchema:{type:'object',properties:{thread_id:{type:'string'}},required:['thread_id'],additionalProperties:false}},
 {name:'mailbox_publish_reply',description:'把完整回答回寫原帖，並原子建立給哥哥的全文同步記錄；不會代替你在哥哥的 dot 對話發送通知。',inputSchema:{type:'object',properties:{thread_id:{type:'string'},through_message_id:{type:'integer'},body:{type:'string'},status:{type:'string',enum:['replied','needs_info']}},required:['thread_id','through_message_id','body'],additionalProperties:false}},
 {name:'mailbox_read_unsent_sync',description:'讀取已成功回答、但尚未確認送達哥哥 dot 對話的原問題與完整答案。',inputSchema:{type:'object',properties:{},additionalProperties:false}},
 {name:'mailbox_acknowledge_sync',description:'僅在已向哥哥本人 dot 對話發送完整原問題及回答後，記錄送達證據；勿在發送前调用。',inputSchema:{type:'object',properties:{sync_id:{type:'integer'},delivery_reference:{type:'string'}},required:['sync_id','delivery_reference'],additionalProperties:false}},
 {name:'mailbox_heartbeat',description:'完成一次檢查後記錄檢查時間；這不會建立或啟用定時任務。',inputSchema:{type:'object',properties:{},additionalProperties:false}},
 {name:'mailbox_read_image',description:'读取已附在留言里的题目图片。',inputSchema:{type:'object',properties:{attachment_id:{type:'string'}},required:['attachment_id'],additionalProperties:false}}
];
async function mcp(request,env){
 const b=await jsonBody(request),id=b.id??null;
 if(b.method==='notifications/initialized')return response(request,env,null,202);
 if(b.method==='initialize')return response(request,env,{jsonrpc:'2.0',id,result:{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'dse-2027-mailbox',version:'1.0.0'}}});
 if(b.method==='tools/list')return response(request,env,{jsonrpc:'2.0',id,result:{tools:TOOL_DEFINITIONS}});
 if(b.method!=='tools/call')return response(request,env,{jsonrpc:'2.0',id,error:{code:-32601,message:'Method not found'}});
 const a=await actor(request,env);agentOnly(a);const args=b.params?.arguments||{};let result;
 switch(b.params?.name){
  case 'mailbox_read_pending':result=await pending(env);break;
  case 'mailbox_read_thread':result=await threadData(env,textValue(args.thread_id,'問題編號',80));break;
  case 'mailbox_publish_reply':result=await publishReply(env,args);break;
  case 'mailbox_read_unsent_sync':result=await syncItems(env,true);break;
  case 'mailbox_acknowledge_sync':result=await acknowledge(env,args);break;
  case 'mailbox_heartbeat':{const v={...await setting(env,'agent',INITIAL_AGENT),last_checked_at:iso()};await setSetting(env,'agent',v);result=v;break;}
  case 'mailbox_read_image':{const f=await fileRecord(env,a,textValue(args.attachment_id,'圖片編號',80));if(!f.message_id)fail(404,'圖片尚未附於留言');const object=await env.BUCKET.get('images/'+f.id);if(!object)fail(404,'找不到圖片');const arr=new Uint8Array(await object.arrayBuffer());let raw='';for(let i=0;i<arr.length;i+=8192)raw+=String.fromCharCode(...arr.subarray(i,i+8192));return response(request,env,{jsonrpc:'2.0',id,result:{content:[{type:'image',mimeType:f.mime,data:btoa(raw)}]}});}
  default:return response(request,env,{jsonrpc:'2.0',id,error:{code:-32602,message:'Unknown tool'}});
 }
 return response(request,env,{jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result}});
}
async function dispatch(request,env){
 checkOrigin(request,env);if(request.method==='OPTIONS')return response(request,env,null,204);
 const u=new URL(request.url),p=u.pathname;
 if(p==='/api/health'&&request.method==='GET')return response(request,env,{ok:true,configured:Boolean(env.DB),version:'1.0.0'});
 if(p==='/mcp'&&request.method==='POST'){if(!env.DB)fail(503,'信箱儲存尚未接通');return mcp(request,env);}
 if(!p.startsWith('/api/')){if(env.ASSETS)return env.ASSETS.fetch(request);return new Response('DSE mailbox API. Open the configured frontend.',{headers:{'content-type':'text/plain; charset=utf-8'}});}
 if(!env.DB)fail(503,'信箱儲存尚未接通');
 const a=await actor(request,env),method=request.method;
 if(p==='/api/bootstrap'&&method==='GET')return response(request,env,{role:a.role==='agent'?'owner':a.role,agent:await setting(env,'agent',INITIAL_AGENT),profile:await setting(env,'profile',INITIAL_PROFILE),threads:(await rows(env,'SELECT * FROM threads ORDER BY updated_at DESC LIMIT 200')).map(shapeThread)});
 if(p==='/api/profile'&&method==='GET')return response(request,env,await setting(env,'profile',INITIAL_PROFILE));
 if(p==='/api/profile'&&method==='PUT'){ownerOnly(a);const b=await jsonBody(request);if(b.exam_year!==2027||typeof b.version!=='number')fail(400,'請保留已確認的 2027 HKDSE 年份並提供檔案版本');const prior=await setting(env,'profile',INITIAL_PROFILE);if(b.version!==prior.version+1)fail(409,'檔案版本已變更，請重新讀取');await setSetting(env,'profile:'+prior.version,prior);await setSetting(env,'profile',b);return response(request,env,b);}
 if(p==='/api/threads'&&method==='POST')return response(request,env,await createHuman(env,a,await jsonBody(request)),201);
 const tm=p.match(/^\/api\/threads\/([a-zA-Z0-9-]+)$/);if(tm&&method==='GET')return response(request,env,await threadData(env,tm[1]));
 const mm=p.match(/^\/api\/threads\/([a-zA-Z0-9-]+)\/messages$/);if(mm&&method==='POST')return response(request,env,await createHuman(env,a,await jsonBody(request),mm[1]),201);
 if(p==='/api/attachments'&&method==='POST')return response(request,env,await upload(request,env,a),201);
 const fm=p.match(/^\/api\/attachments\/([a-zA-Z0-9-]+)$/);if(fm&&method==='GET'){const f=await fileRecord(env,a,fm[1]);const file=await env.BUCKET?.get('images/'+f.id);if(!file)fail(404,'找不到圖片');const h=new Headers(response(request,env,{}).headers);h.set('content-type',f.mime);h.set('content-disposition',"inline; filename*=UTF-8''"+encodeURIComponent(f.name));return new Response(file.body,{headers:h});}
 if(p==='/api/invitations'&&method==='POST'){
  ownerOnly(a);const b=await jsonBody(request);if(b.role!=='student')fail(400,'只能建立妹妹的邀請');
  const token=Array.from(crypto.getRandomValues(new Uint8Array(32))).map(x=>x.toString(16).padStart(2,'0')).join(''),id=crypto.randomUUID();
  const target=new URL(env.FRONTEND_URL||new URL(request.url).origin);if(target.protocol!=='https:'&&!['localhost','127.0.0.1','terminal.local'].includes(target.hostname))fail(500,'信箱網址未設定');
  await run(env,'INSERT INTO invitations(id,token_hash,role,created_at,expires_at) VALUES(?,?,?,?,?)',id,await sha(token),'student',iso(),'2027-08-31T15:59:59.000Z');target.hash='k='+token;return response(request,env,{id,url:target.toString(),expires_at:'2027-08-31T15:59:59.000Z'},201);
 }
 const im=p.match(/^\/api\/invitations\/([a-zA-Z0-9-]+)$/);if(im&&method==='DELETE'){ownerOnly(a);await run(env,'UPDATE invitations SET revoked_at=? WHERE id=?',iso(),im[1]);return response(request,env,{revoked:true});}
 if(p==='/api/sync'&&method==='GET'){agentOnly(a);return response(request,env,await syncItems(env));}
 if(p==='/api/agent/pending'&&method==='GET'){agentOnly(a);return response(request,env,await pending(env));}
 if(p==='/api/agent/replies'&&method==='POST'){agentOnly(a);return response(request,env,await publishReply(env,await jsonBody(request)));}
 if(p==='/api/agent/sync'&&method==='GET'){agentOnly(a);return response(request,env,await syncItems(env,true));}
 if(p==='/api/agent/sync/ack'&&method==='POST'){agentOnly(a);return response(request,env,await acknowledge(env,await jsonBody(request)));}
 if(p==='/api/agent/heartbeat'&&method==='POST'){agentOnly(a);const v={...await setting(env,'agent',INITIAL_AGENT),last_checked_at:iso()};await setSetting(env,'agent',v);return response(request,env,v);}
 if(p==='/api/agent/config'&&method==='PUT'){ownerOnly(a);const b=await jsonBody(request);if(typeof b.active!=='boolean')fail(400,'請提供啟用狀態');if(b.active&&(!b.schedule||!b.schedule_id))fail(400,'先建立真實任務，再記錄任務編號和頻率');const v={...await setting(env,'agent',INITIAL_AGENT),active:b.active,schedule:b.schedule||null,schedule_id:b.schedule_id||null};await setSetting(env,'agent',v);return response(request,env,v);}
 fail(404,'找不到這個操作');
}
export default {async fetch(request,env,ctx){try{return await dispatch(request,env);}catch(e){return response(request,env,{error:e instanceof HttpError?e.message:'信箱暫時無法完成此操作，請稍後再試。'},e instanceof HttpError?e.status:500);}}};
