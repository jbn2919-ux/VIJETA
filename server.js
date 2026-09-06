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
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
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


function seedInitialCompetitions(){
  const key='seed_2026_09_lica_bmo_v1';
  const exists=db.prepare('SELECT value FROM app_settings WHERE key=?').get(key);
  if(exists) return;
  const insert=db.prepare(`INSERT OR IGNORE INTO competitions(id,name,start,end,roles,fields,milestones,posterData,archived,createdAt,updatedAt)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
  const now=nowISO();
  const lica={
    id:'active_sep_lica_2026',
    name:'ACTIVE SEPTEMBER — LICA',
    start:'2026-09-01', end:'2026-09-15', roles:['lica'],
    fields:[
      {id:'agencyStrength',label:'31-08-2026 की Total Agency Strength',note:'Percentage activation इसी total agency strength पर reckoned है.'},
      {id:'activeAgents',label:'Campaign में Active Agents',note:'Poster के activation levels के लिए active agents.'},
      {id:'activationPercent',label:'Activation %',note:'Poster के अनुसार 30% / 35% / 40% levels. Percentage poster rule के अनुसार दर्ज करें.'},
      {id:'inactiveActivated',label:'31-08-2026 को Inactive Agents में से Activated Agents',note:'हर ऐसे Active Agent पर ₹200 additional cash award.'}
    ],
    milestones:[
      {title:'Level A — 30% Activation',reward:'₹300 — हर 2 Active Agents के block पर',condition:'activationPercent >= 30 && activeAgents >= 10'},
      {title:'Level B — 35% Activation',reward:'Level-A पर 20% Extra',condition:'activationPercent >= 35 && activeAgents >= 12'},
      {title:'Level C — 40% Activation',reward:'Level-A पर 50% Extra',condition:'activationPercent >= 40 && activeAgents >= 15'},
      {title:'Additional Cash Award — Inactive Agents Activation',reward:'₹200 — प्रत्येक Activated Inactive Agent',condition:'inactiveActivated >= 1'}
    ],
    posterData:'/active-september-lica.jpg', archived:false
  };
  const bmo={
    id:'platinum_raksha_bmo_2026',
    name:'PLATINUM RAKSHA — Launching Day Campaign for BMOs',
    start:'2026-09-07', end:'2026-09-07', roles:['marketing'],
    fields:[
      {id:'bpjrPolicies',label:'07-09-2026: BP/JR Policies',note:'Poster में BP/JR policies का combined count.'}
    ],
    milestones:[
      {title:'Level 1 — 20 BP/JR Policies',reward:'₹4,000 for Branch',condition:'bpjrPolicies >= 20'},
      {title:'Level 2 — Every 10 Policies (up to 50)',reward:'₹2,000 additional',condition:'bpjrPolicies >= 30'},
      {title:'Level 3 — Every 10 Policies (up to 50)',reward:'₹2,000 additional',condition:'bpjrPolicies >= 40'},
      {title:'Level 4 — Every 10 Policies (up to 50)',reward:'₹2,000 additional',condition:'bpjrPolicies >= 50'},
      {title:'Thereafter — Every 5 Policies',reward:'₹2,000 additional per 5 policies',condition:'bpjrPolicies >= 55'}
    ],
    posterData:'/platinum-raksha-bmo.jpg', archived:false
  };
  const tx=db.transaction(()=>{
    for(const c of [lica,bmo]) insert.run(c.id,c.name,c.start,c.end,JSON.stringify(c.roles),JSON.stringify(c.fields),JSON.stringify(c.milestones),c.posterData,0,now,now);
    db.prepare('INSERT INTO app_settings(key,value) VALUES(?,?)').run(key,now);
  });
  tx();
  audit('SEED_INITIAL_COMPETITIONS',null);
}
seedInitialCompetitions();
// Migrate the original five hard-coded/source competitions into the same
// server-backed competition table used by all future poster uploads.
function seedLegacySourceCompetitions(){
  const key='seed_legacy_source_competitions_v1';
  if(db.prepare('SELECT value FROM app_settings WHERE key=?').get(key)) return;
  const insert=db.prepare(`INSERT OR IGNORE INTO competitions(id,name,start,end,roles,fields,milestones,posterData,archived,createdAt,updatedAt)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
  const now=nowISO();
  const legacy=[
    {id:'launchA',name:'Launching Day Special — Agents',start:'2026-09-07',end:'2026-09-07',roles:['agent'],fields:[{id:'t770nop',label:'07-09-2026: T-770 NOP',note:'हर NOP = ₹500'},{id:'t770tfp',label:'07-09-2026: T-770 TFP (₹)',note:'हर ₹50,000 block = ₹250'},{id:'jrsp',label:'07-09-2026: T-894 SP Policies',note:'हर SP Policy = ₹1,000'},{id:'jrnp',label:'07-09-2026: T-894 NSP Policies',note:'हर NSP Policy = ₹500'}],milestones:[{title:'T-770 NOP Reward',reward:'₹500 each',condition:'t770nop >= 1'},{title:'T-770 TFP Reward',reward:'₹250 per ₹50,000 block',condition:'t770tfp >= 50000'},{title:'T-894 SP Reward',reward:'₹1,000 each',condition:'jrsp >= 1'},{title:'T-894 NSP Reward',reward:'₹500 each',condition:'jrnp >= 1'}],posterData:'/source-launch-agents.jpg'},
    {id:'launchB',name:'Launching Day Special — DOS/LICAS',start:'2026-09-07',end:'2026-09-07',roles:['dos'],fields:[{id:'dosQualAgents',label:'07-09-2026: Qualifying Agents',note:'पहले 3 = ₹1,000; उसके बाद हर 3 = ₹1,200'},{id:'dosSpPremium',label:'07-09-2026: T-894 SP Premium (₹)',note:'हर ₹1 लाख SP Premium block = ₹200'}],milestones:[{title:'पहले 3 Qualifying Agents',reward:'₹1,000',condition:'dosQualAgents >= 3'},{title:'हर अगला Block of 3 Qualifying Agents',reward:'₹1,200',condition:'dosQualAgents >= 6'},{title:'New Jeevan Raksha SP Premium Bonus',reward:'₹200 / ₹1 लाख',condition:'dosSpPremium >= 100000'}],posterData:'/source-launch-dos-licas.jpg'},
    {id:'uleap',name:'U-LEAP',start:'2026-09-01',end:'2026-09-30',roles:['agent'],fields:[{id:'ulip',label:'इस महीने की ULIP Policies',note:'Cancelled/Dishonoured policies अलग से exclude होती हैं.'},{id:'invalidUlip',label:'Cancelled / Dishonoured ULIP Policies',note:'ये ULIP count में नहीं गिनी जाएँगी.'},{id:'appointment',label:'Valid Appointment Letter?',note:'U-LEAP eligibility check'},{id:'enach',label:'Payment Pre-validated eNACH?',note:'U-LEAP eligibility check'}],milestones:[{title:'11 ULIP',reward:'₹5,000',condition:'ulip >= 11'},{title:'21 ULIP',reward:'₹15,000',condition:'ulip >= 21'},{title:'35 ULIP',reward:'₹35,000',condition:'ulip >= 35'},{title:'51 ULIP',reward:'₹65,000',condition:'ulip >= 51'},{title:'75 ULIP',reward:'₹1,00,000',condition:'ulip >= 75'},{title:'101 ULIP',reward:'₹1,75,000',condition:'ulip >= 101'}],posterData:'/source-uleap.jpg'},
    {id:'platinum',name:'प्लेटिनम धमाका',start:'2026-09-01',end:'2026-09-30',roles:['agent'],fields:[{id:'ulip',label:'इस महीने की ULIP Policies',note:'Total NOP calculation में शामिल'},{id:'otherNop',label:'इस महीने की Other Policies',note:'Total NOP calculation में शामिल'},{id:'totalTfp',label:'इस महीने का Total TFP (₹ लाख)',note:'Platinum TFP thresholds के लिए'}],milestones:[{title:'Level 3 — Multipurpose Fan',reward:'Multipurpose Fan',condition:'ulip >= 5 || otherNop >= 5'},{title:'Level 4 — Mixer Grinder',reward:'Mixer Grinder',condition:'ulip >= 7 || otherNop >= 7'},{title:'Level 5 — Gas Stove',reward:'Gas Stove',condition:'ulip >= 10 || otherNop >= 10'},{title:'Level 6 — Gas Stove + Multipurpose Fan',reward:'Gas Stove + Multipurpose Fan',condition:'ulip >= 15 || otherNop >= 15'},{title:'Level 7 — Mixer Grinder + Fan + Gas Stove',reward:'Mixer Grinder + Fan + Gas Stove',condition:'ulip >= 21 || otherNop >= 21'},{title:'Level 8 — Samsung Galaxy 5G Mobile',reward:'Samsung Galaxy 5G Mobile',condition:'ulip >= 31 || otherNop >= 31'},{title:'Level 9 — Fully Automatic Washing Machine',reward:'Fully Automatic Washing Machine',condition:'ulip >= 41 || otherNop >= 41'},{title:'Level 10 — Split AC',reward:'Split AC',condition:'ulip >= 51 || otherNop >= 51'},{title:'Level 11 — Split AC + Samsung Galaxy 5G Mobile',reward:'Split AC + Samsung Galaxy 5G Mobile',condition:'ulip >= 75 || otherNop >= 75'},{title:'Level 12 — Scooty',reward:'Scooty',condition:'ulip >= 101 || otherNop >= 101'},{title:'Level 13 — Motor Cycle (Hero Glamour)',reward:'Motor Cycle (Hero Glamour)',condition:'ulip >= 125 || otherNop >= 125'},{title:'Level 14 — Royal Enfield — Bullet / Thunder Bird',reward:'Royal Enfield — Bullet / Thunder Bird',condition:'ulip >= 150 || otherNop >= 150'}],posterData:'/source-platinum.jpg'},
    {id:'picnic',name:'पॉलिसी करें, पिकनिक चलें',start:'2026-09-02',end:'2026-09-07',roles:['agent'],fields:[{id:'picnicNop',label:'02–07 Sep की NOP',note:'1 = ₹150 • 2 = ₹300 • 3 = Picnic (Single)'},{id:'puriQualified',label:'अगस्त Gateway to Puri में पहले से qualify?',note:'3 Picnic NOP पर Electric Kettle condition'}],milestones:[{title:'1 NOP',reward:'₹150',condition:'picnicNop >= 1'},{title:'2 NOP',reward:'₹300',condition:'picnicNop >= 2'},{title:'3 NOP',reward:'Picnic (Single)',condition:'picnicNop >= 3'}],posterData:'/source-picnic.jpg'}
  ];
  const tx=db.transaction(()=>{
    for(const c of legacy) insert.run(c.id,c.name,c.start,c.end,JSON.stringify(c.roles),JSON.stringify(c.fields),JSON.stringify(c.milestones),c.posterData,0,now,now);
    db.prepare('INSERT INTO app_settings(key,value) VALUES(?,?)').run(key,now);
  });
  tx();
  audit('MIGRATE_LEGACY_SOURCE_COMPETITIONS',null);
}
seedLegacySourceCompetitions();

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
