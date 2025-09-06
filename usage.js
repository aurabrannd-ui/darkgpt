import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.LICENSE_DATA_PATH || './data';
const USAGE_FILE = path.join(DATA_DIR, 'usage.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(USAGE_FILE)) fs.writeFileSync(USAGE_FILE, JSON.stringify({ models:{}, totalUSD:0, byUser:{} }, null, 2));

// أسعار تقديرية. عدّلها إن أردت.
const PRICES = {
  'deepseek/deepseek-chat': { in: 0.27, out: 1.1 },
  'openai/gpt-4o':         { in: 5.0,  out: 15.0 },
  'openai/gpt-4o-mini':    { in: 0.15, out: 0.6 },
  'anthropic/claude-3-5-sonnet': { in: 3.0, out: 15.0 },
  'anthropic/claude-3-haiku':    { in: 0.25, out: 1.25 },
};

function readU(){ return JSON.parse(fs.readFileSync(USAGE_FILE,'utf8')); }
function writeU(u){ fs.writeFileSync(USAGE_FILE, JSON.stringify(u,null,2)); }

export function trackUsage(userId, model, usage){
  try{
    if (!usage) return;
    const { prompt_tokens=0, completion_tokens=0 } = usage;
    const price = PRICES[model] || { in: 0.5, out: 0.5 };
    const usd = (prompt_tokens/1000)*price.in + (completion_tokens/1000)*price.out;

    const u = readU();
    u.totalUSD = (u.totalUSD||0) + usd;
    if (!u.models[model]) u.models[model] = { usd:0, prompt_tokens:0, completion_tokens:0, calls:0 };
    u.models[model].usd += usd;
    u.models[model].prompt_tokens += prompt_tokens;
    u.models[model].completion_tokens += completion_tokens;
    u.models[model].calls += 1;

    if (!u.byUser[userId]) u.byUser[userId] = { usd:0, messages:0 };
    u.byUser[userId].usd += usd;
    u.byUser[userId].messages += 1;

    writeU(u);
  } catch {}
}

export function getUsageSummary(){
  const u = readU();
  return {
    consumedUSD: +(Number(u.totalUSD||0)).toFixed(4),
    models: u.models || {},
    byUser: u.byUser || {}
  };
}
