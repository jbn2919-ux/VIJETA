const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 7);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'vijeta.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS competitions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  start TEXT NOT NULL,
  end TEXT NOT NULL,
  roles TEXT NOT NULL,
  fields TEXT NOT NULL,
  milestones TEXT NOT NULL,
  posterData TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL,
  updatedAt TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  tokenHash TEXT PRIMARY KEY,
  expiresAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  competitionId TEXT,
  at TEXT NOT NULL
);
`);

app.disable('x-powered-by');
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));
app.use((req,res,next)=>{
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','same-origin');
  next();
});

function hashToken(token){ return crypto.createHash('sha256').update(token).digest('hex'); }
function nowISO(){ return new Date().toISOString(); }
function cookieOptions(maxAge){
  return `HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${process.env.NODE_ENV==='production'?'; Secure':''}`;
}
function isAdmin(req){
  const raw=(req.headers.cookie||'').match(/(?:^|; )vijeta_admin=([^;]+)/)?.[1];
  if(!raw) return false;
  const row=db.prepare('SELECT expiresAt FROM sessions WHERE tokenHash=?').get(hashToken(raw));
  if(!row || row.expiresAt < Date.now()){
    if(row) db.prepare('DELETE FROM sessions WHERE tokenHash=?').run(hashToken(raw));
    return false;
  }
  return true;
}
function requireAdmin(req,res,next){ if(!isAdmin(req)) return res.status(401).json({error:'ADMIN_REQUIRED'}); next(); }
function cleanComp(c){
  return {
    id:c.id,name:c.name,start:c.start,end:c.end,
    roles:JSON.parse(c.roles||'[]'),fields:JSON.parse(c.fields||'[]'),
    milestones:JSON.parse(c.milestones||'[]'),posterData:c.posterData||'',
    archived:!!c.archived,createdAt:c.createdAt,updatedAt:c.updatedAt||null
  };
}
function allComps(){ return db.prepare('SELECT * FROM competitions ORDER BY start ASC, createdAt ASC').all().map(cleanComp); }
function getComp(id){ const c=db.prepare('SELECT * FROM competitions WHERE id=?').get(id); return c?cleanComp(c):null; }
function validateComp(c){
  if(!c || !String(c.name||'').trim()) throw new Error('Competition name is required');
  if(!/^\\d{4}-\\d{2}-\\d{2}$/.test(c.start)||!/^\\d{4}-\\d{2}-\\d{2}$/.test(c.end)) throw new Error('Invalid dates');
  if(c.end<c.start) throw new Error('End date cannot be before start date');
  if(!Array.isArray(c.roles)||!c.roles.length) throw new Error('At least one role is required');
  if(!Array.isArray(c.fields)||!c.fields.length) throw new Error('At least one input field is required');
  const ids=new Set(c.fields.map(f=>String(f.id||'').trim()).filter(Boolean));
  for(const f of c.fields){ if(!String(f.id||'').trim()||!String(f.label||'').trim()) throw new Error('Every field needs an id and label'); }
  for(const m of (c.milestones||[])){
    if(!String(m.title||'').trim()) throw new Error('Every milestone needs a title');
    const atoms=String(m.condition||'').match(/[A-Za-z_][\\w-]*\\s*(?:>=|<=|==|!=|>|<)/g)||[];
    const bad=atoms.map(x=>x.trim().split(/\\s+/)[0]).filter(x=>!ids.has(x));
    if(bad.length) throw new Error('Unknown field id in milestone: '+bad.join(', '));
  }
}
function audit(action,id){ db.prepare('INSERT INTO audit_log(action,competitionId,at) VALUES(?,?,?)').run(action,id||null,nowISO()); }

app.get('/api/health',(req,res)=>res.json({ok:true,time:nowISO()}));
app.get('/api/competitions',(req,res)=>res.json({competitions:allComps()}));
app.get('/api/admin/me',(req,res)=>res.json({admin:isAdmin(req)}));

app.post('/api/admin/login',(req,res)=>{
  if(!ADMIN_PASSWORD) return res.status(503).json({error:'ADMIN_PASSWORD_NOT_CONFIGURED'});
  const supplied=String(req.body.password||'');
  const a=Buffer.from(supplied); const b=Buffer.from(ADMIN_PASSWORD);
  const ok=a.length===b.length && crypto.timingSafeEqual(a,b);
  if(!ok) return res.status(401).json({error:'INVALID_PASSWORD'});
  const token=crypto.randomBytes(32).toString('hex');
  const expiresAt=Date.now()+SESSION_DAYS*86400000;
  db.prepare('INSERT INTO sessions(tokenHash,expiresAt) VALUES(?,?)').run(hashToken(token),expiresAt);
  res.setHeader('Set-Cookie',`vijeta_admin=${token}; ${cookieOptions(SESSION_DAYS*86400)}`);
  res.json({ok:true,expiresAt});
});
app.post('/api/admin/logout',(req,res)=>{
  const raw=(req.headers.cookie||'').match(/(?:^|; )vijeta_admin=([^;]+)/)?.[1];
  if(raw) db.prepare('DELETE FROM sessions WHERE tokenHash=?').run(hashToken(raw));
  res.setHeader('Set-Cookie','vijeta_admin=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
  res.json({ok:true});
});

app.post('/api/admin/competitions',requireAdmin,(req,res)=>{
  try{
    const c=req.body; validateComp(c);
    const id=c.id||('dyn_'+Date.now().toString(36)+'_'+crypto.randomBytes(3).toString('hex'));
    const createdAt=nowISO();
    db.prepare(`INSERT INTO competitions(id,name,start,end,roles,fields,milestones,posterData,archived,createdAt,updatedAt)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id,String(c.name).trim(),c.start,c.end,JSON.stringify(c.roles),JSON.stringify(c.fields),JSON.stringify(c.milestones||[]),c.posterData||'',c.archived?1:0,createdAt,createdAt);
    audit('CREATE',id); res.json({ok:true,competition:getComp(id)});
  }catch(e){res.status(400).json({error:e.message});}
});
app.put('/api/admin/competitions/:id',requireAdmin,(req,res)=>{
  try{
    const old=getComp(req.params.id); if(!old) return res.status(404).json({error:'NOT_FOUND'});
    const c={...old,...req.body,id:req.params.id}; validateComp(c);
    db.prepare(`UPDATE competitions SET name=?,start=?,end=?,roles=?,fields=?,milestones=?,posterData=?,archived=?,updatedAt=? WHERE id=?`)
      .run(String(c.name).trim(),c.start,c.end,JSON.stringify(c.roles),JSON.stringify(c.fields),JSON.stringify(c.milestones||[]),c.posterData||'',c.archived?1:0,nowISO(),req.params.id);
    audit('UPDATE',req.params.id); res.json({ok:true,competition:getComp(req.params.id)});
  }catch(e){res.status(400).json({error:e.message});}
});
app.post('/api/admin/competitions/:id/archive',requireAdmin,(req,res)=>{
  const c=getComp(req.params.id); if(!c) return res.status(404).json({error:'NOT_FOUND'});
  db.prepare('UPDATE competitions SET archived=1,updatedAt=? WHERE id=?').run(nowISO(),req.params.id); audit('ARCHIVE',req.params.id); res.json({ok:true,competition:getComp(req.params.id)});
});
app.delete('/api/admin/competitions/:id/poster',requireAdmin,(req,res)=>{
  const c=getComp(req.params.id); if(!c) return res.status(404).json({error:'NOT_FOUND'});
  db.prepare('UPDATE competitions SET posterData="",updatedAt=? WHERE id=?').run(nowISO(),req.params.id); audit('DELETE_POSTER',req.params.id); res.json({ok:true,competition:getComp(req.params.id)});
});
app.delete('/api/admin/competitions/:id',requireAdmin,(req,res)=>{
  const c=getComp(req.params.id); if(!c) return res.status(404).json({error:'NOT_FOUND'});
  db.prepare('DELETE FROM competitions WHERE id=?').run(req.params.id); audit('DELETE_COMPETITION',req.params.id); res.json({ok:true});
});
app.get('/api/admin/audit',requireAdmin,(req,res)=>res.json({audit:db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200').all()}));

// Optional AI poster extraction. The AI only proposes structured rules; admin must review and approve.
app.post('/api/admin/parse-poster',requireAdmin,async(req,res)=>{
  if(!process.env.OPENAI_API_KEY) return res.status(503).json({error:'OPENAI_API_KEY_NOT_CONFIGURED'});
  const image=String(req.body.image||'');
  if(!/^data:image\/(png|jpeg|jpg|webp);base64,/i.test(image)) return res.status(400).json({error:'Provide a poster image as a data URL'});
  const model=process.env.OPENAI_MODEL||'gpt-5';
  const prompt=`You are the VIJETA competition-rule extraction assistant. Read ONLY what is visibly supported by the poster image. Never invent, infer, merge, or silently correct a rule. Return JSON only with this schema:\n{"name":"","start":"YYYY-MM-DD","end":"YYYY-MM-DD","roles":[],"fields":[{"id":"safe_ascii_id","label":"","note":""}],"milestones":[{"title":"","reward":"","condition":""}],"warnings":[]}.\nRules: preserve dates and rewards exactly as shown; if a date is ambiguous, leave it blank and add a warning; create numeric input fields needed to evaluate conditions; conditions must use field IDs with only >= <= == != > < and && ||; if the poster has a rule you cannot safely express, put it in warnings instead of guessing.`;
  try{
    const r=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{'Authorization':'Bearer '+process.env.OPENAI_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({model,input:[{role:'user',content:[{type:'input_text',text:prompt},{type:'input_image',image_url:image}]}],text:{format:{type:'json_object'}}})});
    const data=await r.json();
    if(!r.ok) return res.status(502).json({error:'AI provider error',detail:data});
    const text=(data.output||[]).flatMap(x=>x.content||[]).map(x=>x.text||'').join('');
    let parsed; try{parsed=JSON.parse(text)}catch{ return res.status(502).json({error:'AI returned invalid JSON',raw:text}); }
    res.json({ok:true,proposal:parsed});
  }catch(e){res.status(502).json({error:'AI request failed',detail:e.message});}
});

app.use(express.static(path.join(__dirname,'public'),{extensions:['html']}));
app.get('/*splat',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

// Clean expired sessions periodically.
setInterval(()=>db.prepare('DELETE FROM sessions WHERE expiresAt < ?').run(Date.now()),60*60*1000).unref();

app.listen(PORT,()=>console.log(`VIJETA Final System running on http://localhost:${PORT}`));
