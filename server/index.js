import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import Database from 'better-sqlite3';
import http from 'node:http';
import { Server } from 'socket.io';
import { randomUUID, randomBytes } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const PORT=Number(process.env.PORT||3001);
const ORIGIN=process.env.CLIENT_ORIGIN||'http://localhost:5173';
const SECRET=process.env.JWT_SECRET||'local-development-only-change-this-secret';
if(process.env.NODE_ENV==='production' && (!process.env.JWT_SECRET||SECRET.length<32)) throw new Error('Set a strong JWT_SECRET in production.');
const db=new Database(path.join(here,'relay.sqlite'));
db.pragma('journal_mode = WAL');db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS servers (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id), invite_code TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS memberships (server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY(server_id,user_id));
CREATE TABLE IF NOT EXISTS channels (id TEXT PRIMARY KEY, server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id), content TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS messages_channel_idx ON messages(channel_id,created_at);
`);
// Profile schema upgrades are additive so existing installations keep their data.
const cols=db.prepare('PRAGMA table_info(users)').all().map(x=>x.name);
for(const [column,definition] of Object.entries({display_name:'TEXT',bio:'TEXT',avatar_url:'TEXT',banner_url:'TEXT',gradient_a:'TEXT',gradient_b:'TEXT',gradient_angle:'INTEGER'})){
 if(!cols.includes(column))db.exec(`ALTER TABLE users ADD COLUMN ${column} ${definition}`);
}
db.exec(`
CREATE TABLE IF NOT EXISTS earned_badges (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, badge_key TEXT NOT NULL, granted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(user_id,badge_key));
CREATE TABLE IF NOT EXISTS account_entitlements (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, premium_since TEXT, premium_active INTEGER NOT NULL DEFAULT 0, boost_since TEXT, boost_active INTEGER NOT NULL DEFAULT 0);
`);
const uploads=path.join(here,'uploads');fs.mkdirSync(uploads,{recursive:true});
const profileFields='id,username,display_name,bio,avatar_url,banner_url,gradient_a,gradient_b,gradient_angle,created_at';
const premiumTiers=[['diamond',72],['citrine',60],['pink_sapphire',36],['ruby',24],['quartz',12],['sapphire',6],['silver',3],['jade',1],['matte',0]];
const boostTiers=[['2_years',24],['18_months',18],['15_months',15],['1_year',12],['9_months',9],['6_months',6],['3_months',3],['2_months',2],['1_month',1],['first_boost',0]];
function monthsSince(start){if(!start)return 0;const d=new Date(start),now=new Date();if(Number.isNaN(d.getTime())||d>now)return 0;let n=(now.getUTCFullYear()-d.getUTCFullYear())*12+now.getUTCMonth()-d.getUTCMonth();if(now.getUTCDate()<d.getUTCDate())n--;return Math.max(0,n)}
function profile(id){const u=db.prepare(`SELECT ${profileFields} FROM users WHERE id=?`).get(id);if(!u)return null;const earned=db.prepare('SELECT badge_key,granted_at FROM earned_badges WHERE user_id=? ORDER BY granted_at ASC').all(id);const ent=db.prepare('SELECT * FROM account_entitlements WHERE user_id=?').get(id);const badges=earned.map(x=>({key:x.badge_key,kind:'earned',granted_at:x.granted_at}));if(ent?.premium_active)badges.push({key:'premium_'+premiumTiers.find(x=>monthsSince(ent.premium_since)>=x[1])[0],kind:'premium'});if(ent?.boost_active)badges.push({key:'boost_'+boostTiers.find(x=>monthsSince(ent.boost_since)>=x[1])[0],kind:'boost'});return {...u,display_name:u.display_name||u.username,bio:u.bio||'',gradient_a:u.gradient_a||'#8058f5',gradient_b:u.gradient_b||'#ec57ab',gradient_angle:u.gradient_angle??135,badges,subscription:{premium_active:!!ent?.premium_active,boost_active:!!ent?.boost_active}}}
const app=express();app.use(cors({origin:ORIGIN}));app.use(express.json({limit:'3mb'}));app.use('/uploads',express.static(uploads,{fallthrough:false,maxAge:'1d'}));
const httpServer=http.createServer(app);const io=new Server(httpServer,{cors:{origin:ORIGIN}});
const publicUser=u=>({id:u.id,username:u.username});
const sign=user=>jwt.sign({sub:user.id},SECRET,{expiresIn:'7d'});
const auth=(req,res,next)=>{try{const token=(req.headers.authorization||'').replace(/^Bearer /,'');const data=jwt.verify(token,SECRET);const user=db.prepare('SELECT id,username FROM users WHERE id=?').get(data.sub);if(!user)return res.status(401).json({error:'Account not found'});req.user=user;next()}catch{return res.status(401).json({error:'Authentication required'})}};
const safe=(fn)=>(req,res)=>{try{fn(req,res)}catch(e){console.error(e);res.status(500).json({error:'Something went wrong'})}};
const belongs=(userId,serverId)=>!!db.prepare('SELECT 1 FROM memberships WHERE user_id=? AND server_id=?').get(userId,serverId);
const accessChannel=(userId,channelId)=>db.prepare('SELECT channels.* FROM channels JOIN memberships ON memberships.server_id=channels.server_id WHERE channels.id=? AND memberships.user_id=?').get(channelId,userId);
const serverList=(userId)=>db.prepare('SELECT s.id,s.name,s.owner_id,s.invite_code FROM servers s JOIN memberships m ON m.server_id=s.id WHERE m.user_id=? ORDER BY s.name').all(userId);
const code=()=>randomBytes(6).toString('hex');
const limit=new Map();const rate=(req,res,next)=>{const key=req.ip||'unknown';const now=Date.now();const old=limit.get(key)||{n:0,until:now+60000};if(now>old.until){old.n=0;old.until=now+60000}old.n++;limit.set(key,old);if(old.n>90)return res.status(429).json({error:'Too many requests; retry shortly'});next()};app.use('/api',rate);
app.post('/api/register',safe((req,res)=>{const username=String(req.body.username||'').trim();const password=String(req.body.password||'');if(!/^[a-zA-Z0-9_.]{3,24}$/.test(username)||password.length<8||password.length>128)return res.status(400).json({error:'Username must be 3–24 letters, digits, _ or .; password at least 8 characters'});if(db.prepare('SELECT 1 FROM users WHERE username=?').get(username))return res.status(409).json({error:'Username is taken'});const user={id:randomUUID(),username};db.prepare('INSERT INTO users (id,username,password_hash) VALUES (?,?,?)').run(user.id,username,bcrypt.hashSync(password,12));db.prepare('INSERT INTO account_entitlements(user_id) VALUES (?)').run(user.id);const ordinal=db.prepare('SELECT COUNT(*) AS n FROM users').get().n;if(ordinal<=100)db.prepare('INSERT INTO earned_badges (user_id,badge_key) VALUES (?,?)').run(user.id,'jumpstart');res.status(201).json({token:sign(user),user})}));
app.post('/api/login',safe((req,res)=>{const u=db.prepare('SELECT * FROM users WHERE username=?').get(String(req.body.username||'').trim());if(!u||!bcrypt.compareSync(String(req.body.password||''),u.password_hash))return res.status(401).json({error:'Incorrect username or password'});res.json({token:sign(u),user:publicUser(u)})}));
app.get('/api/me',auth,safe((req,res)=>res.json(req.user)));
app.get('/api/me/profile',auth,safe((req,res)=>res.json(profile(req.user.id))));
app.get('/api/users/:id/profile',auth,safe((req,res)=>{const p=profile(req.params.id);if(!p)return res.status(404).json({error:'Profile not found'});res.json(p)}));
app.patch('/api/me/profile',auth,safe((req,res)=>{
 const {display_name,bio,gradient_a,gradient_b,gradient_angle}=req.body||{};
 if(typeof display_name!=='string'||display_name.trim().length<1||display_name.trim().length>32||typeof bio!=='string'||bio.length>500||![gradient_a,gradient_b].every(c=>typeof c==='string'&&/^#[0-9a-fA-F]{6}$/.test(c))||!Number.isInteger(gradient_angle)||gradient_angle<0||gradient_angle>360)return res.status(400).json({error:'Invalid profile data'});
 db.prepare('UPDATE users SET display_name=?,bio=?,gradient_a=?,gradient_b=?,gradient_angle=? WHERE id=?').run(display_name.trim(),bio,gradient_a,gradient_b,gradient_angle,req.user.id);
 res.json(profile(req.user.id));
}));
app.post('/api/me/assets',auth,safe((req,res)=>{
 const {kind,data}=req.body||{};
 if(!['avatar','banner'].includes(kind)||typeof data!=='string')return res.status(400).json({error:'Invalid upload'});
 const match=/^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(data);
 if(!match)return res.status(400).json({error:'Upload a PNG, JPEG, WebP or GIF image'});
 const bytes=Buffer.from(match[2],'base64');if(bytes.length<32||bytes.length>2*1024*1024)return res.status(400).json({error:'Images must be under 2 MB'});
 const type=match[1],valid=(type==='png'&&bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))||(type==='jpeg'&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)||(type==='gif'&&['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6)))||(type==='webp'&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP');
 if(!valid)return res.status(400).json({error:'Invalid image content'});
 const extension=type==='jpeg'?'jpg':type;const filename=`${randomUUID()}.${extension}`;fs.writeFileSync(path.join(uploads,filename),bytes,{flag:'wx'});
 db.prepare(`UPDATE users SET ${kind==='avatar'?'avatar_url':'banner_url'}=? WHERE id=?`).run(`/uploads/${filename}`,req.user.id);res.json(profile(req.user.id));
}));
// Administrative endpoints are disabled unless an explicit secret is configured.
const admin=(req,res,next)=>{if(!process.env.RELAY_ADMIN_TOKEN||process.env.RELAY_ADMIN_TOKEN.length<24||req.headers['x-relay-admin-token']!==process.env.RELAY_ADMIN_TOKEN)return res.status(403).json({error:'Admin access required'});next()};
const earnable=new Set(['early_supporter_dingo','winter_dingo','event_dingo','jumpstart','moderator','moderator_alumni','bug_hunter','bug_hunter_ruby','partnered_owner','seal_alpha','seal_bravo','seal_charlie','bot_developer']);
app.post('/api/admin/award',admin,safe((req,res)=>{const {user_id,badge_key}=req.body;if(!earnable.has(badge_key)||!db.prepare('SELECT 1 FROM users WHERE id=?').get(user_id))return res.status(400).json({error:'Unknown user or badge'});if(badge_key==='bot_developer'&&Date.now()>new Date('2027-01-19T00:00:00Z').getTime())return res.status(400).json({error:'Bot Developer badge issuance ended January 18, 2027'});db.prepare('INSERT OR IGNORE INTO earned_badges(user_id,badge_key) VALUES (?,?)').run(user_id,badge_key);res.json(profile(user_id))}));
app.post('/api/admin/entitlements',admin,safe((req,res)=>{const {user_id,premium_active,boost_active,premium_since,boost_since}=req.body;if(!db.prepare('SELECT 1 FROM users WHERE id=?').get(user_id)||typeof premium_active!=='boolean'||typeof boost_active!=='boolean')return res.status(400).json({error:'Invalid entitlement'});const goodDate=v=>v===null||(typeof v==='string'&&!Number.isNaN(Date.parse(v)));if(!goodDate(premium_since)||!goodDate(boost_since))return res.status(400).json({error:'Invalid date'});db.prepare('INSERT INTO account_entitlements(user_id,premium_active,boost_active,premium_since,boost_since) VALUES (?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET premium_active=excluded.premium_active,boost_active=excluded.boost_active,premium_since=COALESCE(excluded.premium_since,account_entitlements.premium_since),boost_since=COALESCE(excluded.boost_since,account_entitlements.boost_since)').run(user_id,Number(premium_active),Number(boost_active),premium_since,boost_since);res.json(profile(user_id))}));
app.get('/api/servers',auth,safe((req,res)=>res.json(serverList(req.user.id))));
app.post('/api/servers',auth,safe((req,res)=>{const name=String(req.body.name||'').trim();if(name.length<2||name.length>60)return res.status(400).json({error:'Server name must be 2–60 characters'});const s={id:randomUUID(),name,owner_id:req.user.id,invite_code:code()};const create=db.transaction(()=>{db.prepare('INSERT INTO servers (id,name,owner_id,invite_code) VALUES (?,?,?,?)').run(s.id,s.name,s.owner_id,s.invite_code);db.prepare('INSERT INTO memberships (server_id,user_id) VALUES (?,?)').run(s.id,req.user.id);db.prepare('INSERT INTO channels (id,server_id,name) VALUES (?,?,?)').run(randomUUID(),s.id,'general')});create();res.status(201).json(s)}));
app.post('/api/join',auth,safe((req,res)=>{const s=db.prepare('SELECT * FROM servers WHERE invite_code=?').get(String(req.body.code||'').trim());if(!s)return res.status(404).json({error:'Invite not found'});db.prepare('INSERT OR IGNORE INTO memberships (server_id,user_id) VALUES (?,?)').run(s.id,req.user.id);res.json(s)}));
app.get('/api/servers/:id/channels',auth,safe((req,res)=>{if(!belongs(req.user.id,req.params.id))return res.status(403).json({error:'Not a member'});res.json(db.prepare('SELECT id,server_id,name FROM channels WHERE server_id=? ORDER BY rowid').all(req.params.id))}));
app.post('/api/servers/:id/channels',auth,safe((req,res)=>{const s=db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.id);if(!s||!belongs(req.user.id,s.id))return res.status(403).json({error:'Not a member'});if(s.owner_id!==req.user.id)return res.status(403).json({error:'Only the server owner can create channels in this version'});const name=String(req.body.name||'').trim().toLowerCase().replace(/\s+/g,'-');if(!/^[a-z0-9_-]{2,32}$/.test(name))return res.status(400).json({error:'Channel name must be 2–32 characters'});const c={id:randomUUID(),server_id:s.id,name};db.prepare('INSERT INTO channels (id,server_id,name) VALUES (?,?,?)').run(c.id,c.server_id,c.name);io.to(`server:${s.id}`).emit('channel:created',c);res.status(201).json(c)}));
app.get('/api/channels/:id/messages',auth,safe((req,res)=>{if(!accessChannel(req.user.id,req.params.id))return res.status(403).json({error:'No channel access'});res.json(db.prepare('SELECT m.id,m.channel_id,m.user_id,m.content,m.created_at,u.username,u.display_name,u.avatar_url FROM messages m JOIN users u ON u.id=m.user_id WHERE channel_id=? ORDER BY m.rowid DESC LIMIT 100').all(req.params.id).reverse())}));
app.post('/api/channels/:id/messages',auth,safe((req,res)=>{const c=accessChannel(req.user.id,req.params.id);if(!c)return res.status(403).json({error:'No channel access'});const content=String(req.body.content||'').trim();if(!content||content.length>2000)return res.status(400).json({error:'Message must contain 1–2000 characters'});const id=randomUUID();db.prepare('INSERT INTO messages (id,channel_id,user_id,content) VALUES (?,?,?,?)').run(id,c.id,req.user.id,content);const m=db.prepare('SELECT m.*,u.username,u.display_name,u.avatar_url FROM messages m JOIN users u ON u.id=m.user_id WHERE m.id=?').get(id);io.to(`server:${c.server_id}`).emit('message:new',m);res.status(201).json(m)}));
io.use((socket,next)=>{try{const data=jwt.verify(socket.handshake.auth?.token,SECRET);const user=db.prepare('SELECT id,username FROM users WHERE id=?').get(data.sub);if(!user)throw Error('No account');socket.data.user=user;next()}catch{next(new Error('Unauthorized'))}});
io.on('connection',socket=>{const joinRooms=()=>{for(const s of serverList(socket.data.user.id))socket.join(`server:${s.id}`)};joinRooms();socket.on('servers:refresh',joinRooms)});
app.get('/api/health',(req,res)=>res.json({ok:true}));
if(process.env.NODE_ENV==='production'){app.use(express.static(path.join(here,'../client/dist')));app.get('*',(req,res)=>res.sendFile(path.join(here,'../client/dist/index.html')))}
httpServer.listen(PORT,()=>console.log(`Relay API running at http://localhost:${PORT}`));
