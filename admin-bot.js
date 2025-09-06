import { Telegraf, Markup } from 'telegraf';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  generateKey, listKeys, revokeKey, deleteKey, allClients
} from './license-store.js';
import { getUsageSummary } from './usage.js';

const ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN;
const DATA_DIR = process.env.LICENSE_DATA_PATH || './data';
const ADMIN_FILE = path.join(DATA_DIR, 'admin.json');

function ensure(){
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(ADMIN_FILE)) {
    const pw = process.env.ADMIN_PASSWORD || 'admin123';
    const rec = makeHash(pw);
    fs.writeFileSync(ADMIN_FILE, JSON.stringify({ pass: rec, sessions: [] }, null, 2));
  }
}
ensure();

function readA(){ return JSON.parse(fs.readFileSync(ADMIN_FILE,'utf8')); }
function writeA(a){ fs.writeFileSync(ADMIN_FILE, JSON.stringify(a,null,2)); }

function makeHash(pw){
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(pw, salt, 120000, 32, 'sha256').toString('hex');
  return { salt, hash };
}
function verifyHash(pw, rec){
  const h = crypto.pbkdf2Sync(pw, rec.salt, 120000, 32, 'sha256').toString('hex');
  return h === rec.hash;
}
function isLogged(id){
  const a = readA(); return a.sessions.includes(String(id));
}
function login(id){
  const a = readA(); if (!a.sessions.includes(String(id))) a.sessions.push(String(id)); writeA(a);
}
function logout(id){
  const a = readA(); a.sessions = a.sessions.filter(x=>x!==String(id)); writeA(a);
}
function changePassword(oldPw, newPw){
  const a = readA(); if (!verifyHash(oldPw, a.pass)) return false;
  a.pass = makeHash(newPw); writeA(a); return true;
}

// حالة محادثة
const state = new Map(); // userId -> { expect, tmp, ttl }
function setState(uid, v){ state.set(String(uid), { ...v, ttl: Date.now()+2*60*1000 }); }
function getState(uid){
  const s = state.get(String(uid));
  if (!s) return null;
  if (Date.now()> (s.ttl||0)) { state.delete(String(uid)); return null; }
  return s;
}
function clearState(uid){ state.delete(String(uid)); }

function guard(ctx){ return isLogged(ctx.from?.id); }

function mainMenu(){
  return Markup.inlineKeyboard([
    [Markup.button.callback('🧠 تحديث البرومت','m_prompt')],
    [Markup.button.callback('🔑 توليد مفتاح','m_gen')],
    [Markup.button.callback('📋 قائمة المفاتيح','m_list')],
    [Markup.button.callback('👥 العملاء المفعلون','m_clients')],
    [Markup.button.callback('📊 استهلاك عام','m_usage')],
    [Markup.button.callback('🔐 تغيير كلمة المرور','m_pw')],
    [Markup.button.callback('🚪 تسجيل خروج','m_logout')],
  ]);
}
function backMenu(){ return Markup.inlineKeyboard([[Markup.button.callback('⬅️ رجوع للقائمة','m_back')]]); }

export default function setupAdminBot(){
  if (!ADMIN_BOT_TOKEN) { console.log('ADMIN_BOT_TOKEN غير مضبوط. تخطي البوت الإداري.'); return; }
  const bot = new Telegraf(ADMIN_BOT_TOKEN);

  bot.start(async ctx => {
    if (isLogged(ctx.from.id)) return ctx.reply('لوحة التحكم:', mainMenu());
    const kb = Markup.inlineKeyboard([[Markup.button.callback('🔑 تسجيل دخول','login')]]);
    await ctx.reply('مرحبًا. هذه لوحة إدمن.\nاضغط لتسجيل الدخول.', kb);
  });

  // تسجيل دخول زرّي
  bot.action('login', async ctx => {
    await ctx.answerCbQuery();
    setState(ctx.from.id, { expect: 'login_pw' });
    await ctx.reply('أدخل كلمة المرور الآن:', backMenu());
  });

  // تغيير كلمة المرور زرّي
  bot.action('m_pw', async ctx => {
    if (!guard(ctx)) return askLogin(ctx);
    await ctx.answerCbQuery();
    setState(ctx.from.id, { expect: 'pw_old' });
    await ctx.reply('أدخل كلمة المرور الحالية:', backMenu());
  });

  // تحديث البرومت
  bot.action('m_prompt', async ctx => {
    if (!guard(ctx)) return askLogin(ctx);
    await ctx.answerCbQuery();
    const kb = Markup.inlineKeyboard([
      [Markup.button.callback('📝 إرسال نص جديد','p_txt'), Markup.button.callback('📄 رفع ملف .txt','p_file')],
      [Markup.button.callback('⬅️ رجوع','m_back')]
    ]);
    await ctx.reply('اختر طريقة تحديث prompt.txt:', kb);
  });
  bot.action('p_txt', async ctx => {
    if (!guard(ctx)) return askLogin(ctx);
    await ctx.answerCbQuery();
    setState(ctx.from.id, { expect: 'prompt_text' });
    await ctx.reply('أرسل النص الآن:', backMenu());
  });
  bot.action('p_file', async ctx => {
    if (!guard(ctx)) return askLogin(ctx);
    await ctx.answerCbQuery();
    setState(ctx.from.id, { expect: 'prompt_file' });
    await ctx.reply('ارفع ملف .txt الآن:', backMenu());
  });

  // توليد مفتاح بالأزرار (يشمل دقيقة)
  bot.action('m_gen', async ctx => {
    if (!guard(ctx)) return askLogin(ctx);
    await ctx.answerCbQuery();
    const kb = Markup.inlineKeyboard([
      [Markup.button.callback('1 دقيقة','dur_minute'), Markup.button.callback('ساعة','dur_hour')],
      [Markup.button.callback('يوم','dur_day'), Markup.button.callback('أسبوع','dur_week')],
      [Markup.button.callback('شهر','dur_month'), Markup.button.callback('سنة','dur_year')],
      [Markup.button.callback('⬅️ رجوع','m_back')]
    ]);
    await ctx.reply('اختر مدة المفتاح:', kb);
  });

  const durMap = { dur_minute:'minute', dur_hour:'hour', dur_day:'day', dur_week:'week', dur_month:'month', dur_year:'year' };
  bot.on('callback_query', async ctx => {
    const d = ctx.callbackQuery.data;

    if (d in durMap) {
      if (!guard(ctx)) return askLogin(ctx);
      await ctx.answerCbQuery();
      const k = generateKey({ plan: durMap[d], createdBy:'founder', maxSessions:1 });
      return ctx.reply([
        '🔑 تم إنشاء مفتاح:',
        `• ${k.key}`,
        `• المدة: ${k.plan}`,
        `• الحالة: ${k.status}`
      ].join('\n'), backMenu());
    }

    if (d === 'm_list') {
      if (!guard(ctx)) return askLogin(ctx);
      await ctx.answerCbQuery();
      return renderKeys(ctx, 0);
    }

    if (d.startsWith('k_page_')) {
      if (!guard(ctx)) return askLogin(ctx);
      const p = Number(d.split('_').pop());
      await ctx.answerCbQuery();
      return renderKeys(ctx, p);
    }

    if (d.startsWith('k_rev_')) {
      if (!guard(ctx)) return askLogin(ctx);
      const key = d.slice('k_rev_'.length); await ctx.answerCbQuery();
      const ok = revokeKey(key);
      return ctx.reply(ok?'تم الإيقاف.':'فشل الإيقاف.', backMenu());
    }

    if (d.startsWith('k_del_')) {
      if (!guard(ctx)) return askLogin(ctx);
      const key = d.slice('k_del_'.length); await ctx.answerCbQuery();
      const ok = deleteKey(key);
      return ctx.reply(ok?'تم الحذف.':'فشل الحذف.', backMenu());
    }

    if (d === 'm_clients') {
      if (!guard(ctx)) return askLogin(ctx);
      await ctx.answerCbQuery();
      const cs = allClients();
      if (!cs.length) return ctx.reply('لا عملاء مفعلين الآن.', backMenu());
      const rows = cs.map(c => `${c.userId} | ${c.plan} | ${new Date(c.expiresAt).toLocaleString()}`);
      return ctx.reply(rows.join('\n'), backMenu());
    }

    if (d === 'm_usage') {
      if (!guard(ctx)) return askLogin(ctx);
      await ctx.answerCbQuery();
      const s = getUsageSummary();
      return ctx.reply([
        `المستهلك التقديري: ${s.consumedUSD} USD`,
        `نماذج: ${Object.keys(s.models||{}).length}`
      ].join('\n'), backMenu());
    }

    if (d === 'm_logout') {
      if (!isLogged(ctx.from.id)) return ctx.answerCbQuery();
      logout(ctx.from.id);
      await ctx.answerCbQuery('تم تسجيل الخروج');
      return ctx.reply('تم تسجيل الخروج.');
    }

    if (d === 'm_back') {
      await ctx.answerCbQuery();
      if (isLogged(ctx.from.id)) return ctx.reply('القائمة:', mainMenu());
      const kb = Markup.inlineKeyboard([[Markup.button.callback('🔑 تسجيل دخول','login')]]);
      return ctx.reply('مرحبًا. اضغط للدخول.', kb);
    }
  });

  // استلام نصوص حسب الحالة
  bot.on('text', async ctx => {
    const s = getState(ctx.from.id);
    if (!s) {
      if (isLogged(ctx.from.id)) return ctx.reply('القائمة:', mainMenu());
      const kb = Markup.inlineKeyboard([[Markup.button.callback('🔑 تسجيل دخول','login')]]);
      return ctx.reply('اضغط لتسجيل الدخول.', kb);
    }

    // تسجيل الدخول
    if (s.expect === 'login_pw') {
      const pw = ctx.message.text.trim();
      const a = readA();
      if (verifyHash(pw, a.pass)) {
        login(ctx.from.id); clearState(ctx.from.id);
        return ctx.reply('تم تسجيل الدخول.', mainMenu());
      }
      return ctx.reply('كلمة مرور خاطئة. حاول مجددًا:', backMenu());
    }

    // تغيير كلمة المرور
    if (s.expect === 'pw_old') {
      setState(ctx.from.id, { expect:'pw_new', tmp:{ old: ctx.message.text.trim() } });
      return ctx.reply('أدخل كلمة المرور الجديدة:', backMenu());
    }
    if (s.expect === 'pw_new') {
      const oldPw = s.tmp?.old || '';
      const newPw = ctx.message.text.trim();
      const ok = changePassword(oldPw, newPw);
      clearState(ctx.from.id);
      return ctx.reply(ok ? 'تم تغيير كلمة المرور.' : 'فشل. كلمة المرور القديمة غير صحيحة.', mainMenu());
    }

    // تحديث البرومت كنص
    if (s.expect === 'prompt_text') {
      const p = path.join(process.cwd(),'prompt.txt');
      fs.writeFileSync(p, ctx.message.text, 'utf8');
      clearState(ctx.from.id);
      return ctx.reply('تم تحديث prompt.txt من النص.', mainMenu());
    }

    return ctx.reply('القائمة:', mainMenu());
  });

  // استقبال ملف txt للبرومت
  bot.on('document', async ctx => {
    const s = getState(ctx.from.id);
    if (!s || s.expect !== 'prompt_file') return;
    const doc = ctx.message.document;
    if (!/\.txt$/i.test(doc.file_name||'')) {
      return ctx.reply('ارفع ملف .txt فقط.', backMenu());
    }
    const link = await ctx.telegram.getFileLink(doc.file_id);
    const buf = await fetch(link.href).then(r=>r.arrayBuffer()).then(b=>Buffer.from(b));
    const p = path.join(process.cwd(),'prompt.txt');
    fs.writeFileSync(p, buf);
    clearState(ctx.from.id);
    return ctx.reply('تم تحديث prompt.txt من الملف.', mainMenu());
  });

  function askLogin(ctx){
    const kb = Markup.inlineKeyboard([[Markup.button.callback('🔑 تسجيل دخول','login')]]);
    ctx.reply('سجّل دخولك أولًا.', kb);
  }

  async function renderKeys(ctx, page){
    const all = listKeys().filter(k=>k.status!=='expired').slice().reverse(); // إخفاء المنتهي
    if (!all.length) return ctx.reply('لا توجد مفاتيح حالية.', backMenu());

    const pageSize = 10;
    const pages = Math.ceil(all.length/pageSize);
    const p = Math.max(0, Math.min(page, pages-1));
    const slice = all.slice(p*pageSize, (p+1)*pageSize);

    const lines = slice.map(it => {
      const own = it.ownerId ? ` | uid:${it.ownerId}` : '';
      const exp = it.expiresAt ? ` | ينتهي: ${new Date(it.expiresAt).toLocaleString()}` : '';
      return `${it.key} | ${it.plan} | ${it.status}${own}${exp}`;
    }).join('\n');

    const nav = [];
    if (p>0) nav.push(Markup.button.callback('⬅️ السابق', `k_page_${p-1}`));
    nav.push(Markup.button.callback(`صفحة ${p+1}/${pages}`, 'm_back'));
    if (p<pages-1) nav.push(Markup.button.callback('التالي ➡️', `k_page_${p+1}`));

    const actions = slice.map(it => [
      Markup.button.callback(`❌ Revoke ${it.key.slice(0,4)}`, `k_rev_${it.key}`),
      Markup.button.callback(`🗑 Delete`, `k_del_${it.key}`)
    ]);

    await ctx.reply(lines, Markup.inlineKeyboard([...actions, nav, [Markup.button.callback('⬅️ رجوع','m_back')]]));
  }

  bot.launch().then(()=>console.log('🚀 Admin bot launched (button-only, time-based keys)'));
}
