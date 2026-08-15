/* ============================================================
   抓台股「官方收盤價」→ 寫成 prices.json（GitHub Actions 執行）

   為什麼要這樣設計？
   - GitHub 的伺服器在美國，證交所本家 www.twse 常常「連不上」，
     只能退回 openapi 鏡像，而該鏡像會慢一個交易日 → 盤後價不準。
   - 解法：全市場用 openapi(上市)+TPEx(上櫃) 當「土台」；
     「你實際持有的股票(watchlist.json)」再用 Yahoo Finance 抓「當日」最新，
     覆蓋掉土台裡可能過期的值。Yahoo 美國連得到、且是當日收盤，最可靠。
   - updated 以「真正抓到的最新日期」為準，不再盲貼今天。

   隱私：土台是全市場；watchlist 只是「代號清單」（GitHub 看得到你追哪幾檔，
         但看不到你幾張、成本、損益——那些只在你手機）。
   ============================================================ */
const fs = require('fs');

async function getText(url, tries = 3){
  let err;
  for(let i = 0; i < tries; i++){
    try{
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 20000);
      const r = await fetch(url, { headers:{ 'User-Agent':'Mozilla/5.0 (stock-tracker)' }, signal:c.signal });
      clearTimeout(t);
      if(!r.ok) throw new Error('HTTP ' + r.status);
      return await r.text();
    }catch(e){ err = e; }
  }
  throw err;
}
const num = v => parseFloat(String(v ?? '').replace(/,/g,''));
function rocToISO(d){
  const s = String(d ?? '').trim().replace(/\//g,'');
  if(!/^\d{7}$/.test(s)) return null;
  return (Number(s.slice(0,3)) + 1911) + '-' + s.slice(3,5) + '-' + s.slice(5,7);
}
const tpeDate = ms => new Date(ms).toLocaleDateString('sv-SE', { timeZone:'Asia/Taipei' });

// ---- 全市場土台：上市 openapi（美國連得到，可能慢一天）----
async function twseOpenapi(){
  const j = JSON.parse(await getText('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL'));
  const out = {}; let date = null;
  for(const row of j){
    if(!date && row.Date) date = rocToISO(row.Date);
    const close = num(row.ClosingPrice);
    if(row.Code && isFinite(close) && close > 0) out[row.Code] = close;
  }
  return { prices: out, date };
}
// ---- 全市場土台：上櫃 TPEx openapi（通常最新）----
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
// ---- 持有股：Yahoo Finance（美國連得到、當日收盤）----
async function yahoo(sym){
  const j = JSON.parse(await getText('https://query1.finance.yahoo.com/v8/finance/chart/' + sym + '?interval=1d&range=1d'));
  const m = j?.chart?.result?.[0]?.meta;
  if(!m || !isFinite(m.regularMarketPrice) || m.regularMarketPrice <= 0) return null;
  return { price: m.regularMarketPrice, time: m.regularMarketTime ? m.regularMarketTime * 1000 : null };
}

(async () => {
  const prices = {}; const baseDates = [];

  // 1) 土台（全市場）
  try{ const t = await twseOpenapi(); Object.assign(prices, t.prices); if(t.date) baseDates.push(t.date);
    console.log('上市 openapi：', Object.keys(t.prices).length, '檔，日期', t.date);
  }catch(e){ console.error('上市 openapi 失敗：', e.message); }
  try{ const t = await tpex(); Object.assign(prices, t.prices); if(t.date) baseDates.push(t.date);
    console.log('上櫃 TPEx：', Object.keys(t.prices).length, '檔，日期', t.date);
  }catch(e){ console.error('上櫃 TPEx 失敗：', e.message); }

  if(Object.keys(prices).length < 100){ console.error('土台抓太少，中止。'); process.exit(1); }

  // 2) 持有股用 Yahoo 覆蓋成「當日最新」
  let watch = [];
  try{ watch = JSON.parse(fs.readFileSync('watchlist.json','utf8')); }catch(e){}
  let freshDate = null, freshN = 0;
  for(const code of watch){
    let r = null;
    try{ r = await yahoo(code + '.TW'); }catch(e){}
    if(!r){ try{ r = await yahoo(code + '.TWO'); }catch(e){} }   // 上櫃用 .TWO
    if(r){
      prices[code] = r.price; freshN++;
      if(r.time){ const d = tpeDate(r.time); if(!freshDate || d > freshDate) freshDate = d; }
      console.log('Yahoo 最新：', code, '=', r.price, r.time ? '('+tpeDate(r.time)+')' : '');
    }else{
      console.error('Yahoo 抓不到：', code, '（保留土台值）');
    }
  }

  // 3) updated：優先用 Yahoo 的當日日期；沒有才用土台最新日期；再沒有才台灣今天
  const updated = freshDate
    || baseDates.filter(Boolean).sort().pop()
    || new Date().toLocaleDateString('sv-SE', { timeZone:'Asia/Taipei' });

  fs.writeFileSync('prices.json', JSON.stringify({ updated, prices }));
  console.log('已寫入 prices.json：', Object.keys(prices).length, '檔，持有股新鮮', freshN, '檔，日期', updated);
})();
