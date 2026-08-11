/* ============================================================
   抓台股「官方收盤價」→ 寫成 prices.json
   在 GitHub Actions（伺服器端）執行，不受瀏覽器 CORS 限制。

   來源（重點：要拿「當天最新」且用「資料本身的日期」貼標籤）：
     上市 → 本家 www.twse STOCK_DAY_ALL（最新、含日期）
             萬一失敗，退回 openapi.twse（可能慢一個交易日，但有日期）
     上櫃 → 櫃買 TPEx openapi daily_close_quotes（最新、含日期）

   為什麼要用資料日期？
     證交所 openapi 鏡像常慢一個交易日；若盲目貼「今天」，會把昨天的
     收盤價標成今天 → 看起來「不準」。改用資料裡的 Date 就永遠正確。
   隱私：抓「全市場」收盤價，GitHub 不會知道你持有哪幾檔。
   ============================================================ */
const fs = require('fs');

async function getText(url){
  const r = await fetch(url, { headers:{ 'User-Agent':'Mozilla/5.0 (stock-tracker)' } });
  if(!r.ok) throw new Error(url + ' -> HTTP ' + r.status);
  return r.text();
}
const num = v => parseFloat(String(v ?? '').replace(/,/g,''));
// 民國日期 "1150811" → "2026-08-11"
function rocToISO(d){
  const s = String(d ?? '').trim().replace(/\//g,'');
  if(!/^\d{7}$/.test(s)) return null;
  return (Number(s.slice(0,3)) + 1911) + '-' + s.slice(3,5) + '-' + s.slice(5,7);
}

// 解析一行 CSV（欄位用 "," 包住）→ 陣列
function splitCsvLine(line){
  const t = line.trim();
  if(!t.startsWith('"')) return null;
  return t.replace(/^"/,'').replace(/"\s*$/,'').split(/"\s*,\s*"/);
}

// ---- 上市：本家 www.twse（最新、含日期）----
async function twseMain(){
  const txt = await getText('https://www.twse.com.tw/exchangeReport/STOCK_DAY_ALL?response=csv');
  const out = {}; let date = null;
  for(const line of txt.split('\n')){
    const f = splitCsvLine(line);
    // 欄位：日期,代號,名稱,股數,金額,開,高,低,收,漲跌,筆數
    if(!f || f.length < 9) continue;
    const iso = rocToISO(f[0]);
    if(!iso) continue;                // 跳過標題與說明列
    if(!date) date = iso;
    const code = String(f[1]).trim(), close = num(f[8]);
    if(code && isFinite(close) && close > 0) out[code] = close;
  }
  return { prices: out, date };
}

// ---- 上市備援：openapi.twse（可能慢一天，但有 Date）----
async function twseOpenapi(){
  const j = JSON.parse(await getText('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL'));
  const out = {}; let date = null;
  for(const row of j){
    if(!date && row.Date) date = rocToISO(row.Date);
    const code = row.Code, close = num(row.ClosingPrice);
    if(code && isFinite(close) && close > 0) out[code] = close;
  }
  return { prices: out, date };
}

// ---- 上櫃：TPEx openapi（最新、含 Date）----
async function tpex(){
  const j = JSON.parse(await getText('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes'));
  const out = {}; let date = null;
  for(const row of j){
    if(!date && row.Date) date = rocToISO(row.Date);
    const code = row.SecuritiesCompanyCode || row.Code || row.CompanyCode;
    const close = num(row.Close ?? row.ClosingPrice ?? row.LastPrice);
    if(code && isFinite(close) && close > 0) out[code] = close;
  }
  return { prices: out, date };
}

(async () => {
  const prices = {}; const dates = [];

  // 上市：先本家（最新），不行才退回 openapi
  try{
    let t = await twseMain();
    if(Object.keys(t.prices).length < 100){ throw new Error('本家筆數過少 ' + Object.keys(t.prices).length); }
    Object.assign(prices, t.prices); if(t.date) dates.push(t.date);
    console.log('上市 www.twse OK：', Object.keys(t.prices).length, '檔，日期', t.date);
  }catch(e){
    console.error('上市本家失敗，改用 openapi：', e.message);
    try{ const t = await twseOpenapi(); Object.assign(prices, t.prices); if(t.date) dates.push(t.date);
      console.log('上市 openapi OK：', Object.keys(t.prices).length, '檔，日期', t.date, '（可能慢一個交易日）');
    }catch(e2){ console.error('上市 openapi 也失敗：', e2.message); }
  }

  // 上櫃
  try{ const t = await tpex(); Object.assign(prices, t.prices); if(t.date) dates.push(t.date);
    console.log('上櫃 TPEx OK：', Object.keys(t.prices).length, '檔，日期', t.date);
  }catch(e){ console.error('上櫃 TPEx 失敗：', e.message); }

  // 安全閥：抓到太少就中止，不要用垃圾覆蓋掉上一份好資料
  const n = Object.keys(prices).length;
  if(n < 100){ console.error('只抓到', n, '筆，疑似來源異常，中止。'); process.exit(1); }

  // 以「資料本身的日期」為準（取最新的那個）；真的都沒有才退回台灣今天
  const updated = dates.filter(Boolean).sort().pop()
    || new Date().toLocaleDateString('sv-SE', { timeZone:'Asia/Taipei' });

  fs.writeFileSync('prices.json', JSON.stringify({ updated, prices }));
  console.log('已寫入 prices.json：', n, '檔，資料日期', updated);
})();
