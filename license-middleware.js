import {
  activateKey, isActive, getClient, clearExpiredClient,
  expireSweep, purgeExpiredKeys
} from './license-store.js';
import { trackUsage } from './usage.js';

function isCmd(t, name){ return typeof t==='string' && t.trim().toLowerCase().startsWith('/'+name); }
function extractKey(msg){
  if (!msg) return null;
  const m = msg.trim().match(/[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/i);
  return m ? m[0].toUpperCase() : null;
}

export function attachLicensing({ bot }){
  bot.use(async (ctx, next) => {
    const uid = ctx.from?.id;
    const txt = ctx.message?.text || ctx.update?.message?.text || '';

    // تفعيل مفتاح بلصقه أو عبر /activate
    if (isCmd(txt,'activate') || extractKey(txt)) {
      const key = extractKey(txt);
      if (!key) { await ctx.reply('أرسل مفتاح الاشتراك بصيغة XXXX-XXXX-XXXX-XXXX أو استخدم /activate KEY'); return; }
      const r = activateKey({ key, userId: uid });
      if (!r.ok) { await ctx.reply('مفتاح غير صالح/مستخدم.'); return; }
      await ctx.reply(`تم التفعيل: ${r.plan}\nينتهي: ${new Date(r.expiresAt).toLocaleString()}`);
      return;
    }

    // السماح فقط لمن لديه اشتراك نشط زمنيًا
    if (uid && isActive(uid)) {
      bot.context._trackUsage = (userId, model, usage) => trackUsage(userId, model, usage);
      return next();
    }

    // انتهى الوقت
    const c = getClient(uid);
    if (c && new Date(c.expiresAt) <= new Date()){
      await ctx.reply('انتهى اشتراكك. أرسل مفتاحًا جديدًا للتجديد.');
      clearExpiredClient(uid);
      return;
    }

    await ctx.reply('هذه الخدمة تتطلب مفتاح اشتراك. أرسل مفتاحك بصيغة XXXX-XXXX-XXXX-XXXX أو استخدم /activate KEY');
  });
}

export function scheduleExpiryChecks(){
  setInterval(() => {
    expireSweep();
    if (process.env.LICENSE_PURGE_EXPIRED === '1') purgeExpiredKeys();
  }, 60*1000);
}
