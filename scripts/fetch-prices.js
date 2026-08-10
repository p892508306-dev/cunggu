/* ============================================================
   抓台股「官方收盤價」→ 寫成 prices.json
   在 GitHub Actions（伺服器端）執行，不受瀏覽器 CORS 限制。
   來源：
     上市 → 證交所 OpenAPI  STOCK_DAY_ALL
     上櫃 → 櫃買中心 OpenAPI daily_close_quotes
   隱私：這裡抓「全市場」收盤價，GitHub 不會知道你持有哪幾檔。
   ============================================================ */
const fs = require('fs');

async function getJSON(url){
  const r = await fetch(url, { headers:{'User-Agent':'stock-tracker'} });
  if(!r.ok) throw new Error(url + ' -> HTTP ' + r.status);
  return r.json();
}
const num = v => parseFloat(String(v ?? '').replace(/,/g,''));

async function getTWSE(){          // 上市
  const j = await getJSON('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL');
  const out = {};
  for(const row of j){
    const code = row.Code, close = num(row.ClosingPrice);
    if(code && isFinite(close) && close>0) out[code] = close;
  }
  return out;
}
async function getTPEx(){          // 上櫃
  const j = await getJSON('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes');
  const out = {};
  for(const row of j){
    const code = row.SecuritiesCompanyCode || row.Code || row.CompanyCode;
    const close = num(row.Close ?? row.ClosingPrice ?? row.LastPrice);
    if(code && isFinite(close) && close>0) out[code] = close;
  }
  return out;
}

(async () => {
  const prices = {};
  try{ Object.assign(prices, await getTPEx()); }catch(e){ console.error('TPEx 失敗：', e.message); }
  try{ Object.assign(prices, await getTWSE()); }catch(e){ console.error('TWSE 失敗：', e.message); }

  // 台灣時區當天日期 YYYY-MM-DD
  const updated = new Date().toLocaleDateString('sv-SE', { timeZone:'Asia/Taipei' });

  // 安全閥：抓到的太少就中止，不要用垃圾覆蓋掉上一份好資料
  const n = Object.keys(prices).length;
  if(n < 100) { console.error('只抓到', n, '筆，疑似來源異常，中止。'); process.exit(1); }

  fs.writeFileSync('prices.json', JSON.stringify({ updated, prices }));
  console.log('已寫入 prices.json：', n, '檔，日期', updated);
})();
