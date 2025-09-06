import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const DATA_DIR = process.env.LICENSE_DATA_PATH || './data';
const LICENSE_FILE = path.join(DATA_DIR, 'licenses.json');

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(LICENSE_FILE)) {
    fs.writeFileSync(LICENSE_FILE, JSON.stringify({ keys: [], clients: {} }, null, 2));
  }
}
ensure();

function read() { return JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf8')); }
function write(s) { fs.writeFileSync(LICENSE_FILE, JSON.stringify(s, null, 2)); }

function genKey(len = 16) {
  const raw = crypto.randomBytes(len).toString('base64url').toUpperCase().replace(/[^A-Z0-9]/g,'');
  return raw.slice(0,16).replace(/(.{4})/g,'$1-').replace(/-$/,'');
}

function addDur(d, unit) {
  const t = new Date(d);
  if (unit === 'minute') t.setMinutes(t.getMinutes()+1);
  if (unit === 'hour') t.setHours(t.getHours()+1);
  if (unit === 'day') t.setDate(t.getDate()+1);
  if (unit === 'week') t.setDate(t.getDate()+7);
  if (unit === 'month') t.setMonth(t.getMonth()+1);
  if (unit === 'year') t.setFullYear(t.getFullYear()+1);
  return t;
}

export function generateKey({ plan='day', createdBy='admin', maxSessions=1 }) {
  const s = read();
  const key = genKey();
  const it = {
    key, plan,
    status: 'unused', // unused | active | expired | revoked
    createdBy, createdAt: new Date().toISOString(),
    ownerId: null, activatedAt: null, expiresAt: null,
    sessionsUsed: 0, maxSessions
  };
  s.keys.push(it); write(s); return it;
}

export function listKeys(){ return read().keys; }
export function findKey(k){ return read().keys.find(x=>x.key===k); }

export function deleteKey(k){
  const s = read(); const i = s.keys.findIndex(x=>x.key===k);
  if (i===-1) return false; s.keys.splice(i,1); write(s); return true;
}
export function revokeKey(k){
  const s = read(); const it = s.keys.find(x=>x.key===k);
  if (!it) return false; it.status='revoked'; write(s); return true;
}

export function activateKey({ key, userId }) {
  const s = read(); const it = s.keys.find(x=>x.key===key);
  if (!it) return { ok:false, error:'INVALID_KEY' };
  if (it.status !== 'unused') return { ok:false, error:'ALREADY_USED_OR_BLOCKED' };
  if (it.sessionsUsed >= it.maxSessions) return { ok:false, error:'MAX_SESSIONS' };
  const now = new Date(); const exp = addDur(now, it.plan);
  it.status='active'; it.ownerId=userId; it.activatedAt=now.toISOString(); it.expiresAt=exp.toISOString();
  it.sessionsUsed += 1;
  s.clients[userId] = { key: it.key, expiresAt: it.expiresAt, plan: it.plan };
  write(s);
  return { ok:true, plan: it.plan, expiresAt: it.expiresAt };
}

export function getClient(userId){ return read().clients[userId] || null; }

export function clearExpiredClient(userId){
  const s = read();
  if (s.clients[userId]) { delete s.clients[userId]; write(s); }
}

export function isActive(userId){
  const s = read(); const c = s.clients[userId]; if (!c) return false;
  const key = s.keys.find(x=>x.key===c.key);
  const timeOk = new Date(c.expiresAt) > new Date();
  const statusOk = key && key.status==='active';
  return !!(timeOk && statusOk);
}

export function allClients(){
  const s = read();
  return Object.entries(s.clients).map(([uid,v])=>{
    return { userId:Number(uid), key:v.key, plan:v.plan, expiresAt:v.expiresAt };
  });
}

export function expireSweep(){
  const s = read(); const now = new Date();
  for (const it of s.keys) {
    if (it.status==='active' && it.expiresAt && new Date(it.expiresAt)<=now) it.status='expired';
  }
  write(s);
}

export function purgeExpiredKeys(){
  const s = read(); const now = new Date();
  const alive = new Set();
  s.keys = s.keys.filter(k => {
    const isExpired = k.status==='expired' || (k.expiresAt && new Date(k.expiresAt) <= now);
    if (!isExpired) alive.add(k.key);
    return !isExpired;
  });
  for (const uid of Object.keys(s.clients)) {
    if (!alive.has(s.clients[uid].key)) delete s.clients[uid];
  }
  write(s);
}
