import { renderChart } from './chart.js';
const SNAPSHOT_URL = './public/data/v4-snapshot.json';
const CACHE_KEY = 'csi300-v4-snapshot-v1';
const app = document.querySelector('#app');
const fmtPct = (v, digits=2) => v == null ? '—' : `${(Number(v)*100).toFixed(digits)}%`;
const fmtNum = (v, digits=2) => v == null ? '—' : Number(v).toFixed(digits);
const fmtPosition = v => `${Math.round(Number(v)*100)}%`;
const stateText = { hold:'基准持有', warning:'下行预警', defense:'风险防御' };
const entryText = { strong:'强势建仓', standard:'标准建仓', test:'防御试仓', wait:'等待' };

async function loadSnapshot(){
  try {
    const res=await fetch(`${SNAPSHOT_URL}?t=${Date.now()}`,{cache:'no-store'});
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const data=await res.json(); localStorage.setItem(CACHE_KEY,JSON.stringify(data)); return data;
  } catch(err) {
    const cached=localStorage.getItem(CACHE_KEY); if(cached){ const d=JSON.parse(cached); d.status={...d.status,quality:'offline',message:'离线缓存'}; return d; }
    throw err;
  }
}
function queryState(){ const p=new URLSearchParams(location.search); return { view:['returns','position','flow'].includes(p.get('view'))?p.get('view'):'returns', range:['1y','3y','all'].includes(p.get('range'))?p.get('range'):'1y', date:p.get('date') }; }
function setQuery(next){ const p=new URLSearchParams(location.search); Object.entries(next).forEach(([k,v])=>v?p.set(k,v):p.delete(k)); history.replaceState(null,'',`${location.pathname}?${p.toString()}`); }
function rangeData(series,range){ if(range==='all') return series; const end=new Date(series.at(-1).date); const years=range==='1y'?1:3; const cut=new Date(end); cut.setFullYear(end.getFullYear()-years); return series.filter(d=>new Date(d.date)>=cut); }
function reasons(data){ const s=data.current.signals, r=[]; if(s.pe5yPercentile>=.8)r.push(['高估值',`PE五年分位 ${fmtPct(s.pe5yPercentile,1)}，高于风险阈值。`]); if(s.price4w<0)r.push(['趋势偏弱',`指数近4周 ${fmtPct(s.price4w,2)}，价格尚未确认资金流。`]); if(s.positiveFundBreadth<.6)r.push(['流入广度不足',`同步净申购ETF数量占比仅 ${fmtPct(s.positiveFundBreadth,0)}。`]); if(!r.length)r.push(['状态未反转','暂无足够证据改变正式周度状态。']); return r.slice(0,3); }
function metricRow(label,value,sub,color='teal'){ return `<li><span class="signal-name">${label}</span><strong class="signal-value ${color}">${value}</strong><span class="signal-sub">${sub}</span></li>`; }
function render(data){
  const ui=queryState(), cur=data.current, rs=reasons(data), quality=data.status.quality||'good';
  const series=rangeData(data.chartSeries,ui.range); let selected=series.length-1; if(ui.date){ const idx=series.findIndex(d=>d.date===ui.date); if(idx>=0)selected=idx; }
  app.innerHTML=`
    <header class="topbar"><div class="brand">沪深300 · V4 策略控制台</div><div class="status-cluster"><span class="desktop-only">最新交易日 ${data.status.dataDate}</span><span class="data-status ${quality==='good'?'':quality==='offline'?'error':'stale'}"><i class="dot"></i>${quality==='good'?'数据正常':quality==='offline'?'离线缓存':'数据延迟'}</span><span class="desktop-only">每日09:00更新</span></div></header>
    <div class="mobile-substatus">截至前一交易日 ${data.status.dataDate} · 北京时间每日09:00更新 · 正式仓位按周确认</div>
    <main>
      <section class="situation" aria-label="当前策略决策">
        <section class="current"><p class="eyebrow">当前策略状态</p><div class="allocation-row"><div class="allocation">${fmtPosition(cur.targetPosition)}</div><div class="state-name">${stateText[cur.state]}</div></div><p class="subcopy">现有账户目标仓位。风险状态切换后按每周最多20个百分点分批执行。</p></section>
        <section class="rail-section"><p class="eyebrow">V4三档仓位 / 状态轨道</p><div class="rail"><div class="rail-line"><i class="rail-dot"></i></div><div class="rail-item"><strong class="teal">100</strong><span>基准持有<br>积极进攻</span></div><div class="rail-item"><strong class="amber">50</strong><span>下行预警<br>谨慎观望</span></div><div class="rail-item active"><strong>10</strong><span>风险防御<br>严格防守</span></div></div></section>
        <section class="new-money"><p class="eyebrow">新资金决策</p><div class="entry-decision">${entryText[cur.entryGrade]}</div><p class="subcopy">新账户不复制已有账户仓位，等待资金与价格形成可验证的建仓条件。</p><details class="disclosure mobile-reasons"><summary>查看${rs.length}项原因</summary>${rs.map(x=>`<p><b>${x[0]}</b>：${x[1]}</p>`).join('')}</details></section>
        <section class="reasons-section"><p class="eyebrow">为什么是${entryText[cur.entryGrade]}（核心原因）</p><ol class="reasons">${rs.map((x,i)=>`<li><span class="reason-index">${i+1}</span><span><b>${x[0]}</b>：${x[1]}</span></li>`).join('')}</ol><details class="disclosure"><summary>查看详细逻辑</summary><p>${data.methodology.summary}</p></details></section>
      </section>
      <section class="workspace">
        <article class="viewport"><div class="viewport-head"><h2>策略净值与仓位状态</h2><div class="controls"><div class="segmented" aria-label="时间范围">${[['1y','1年'],['3y','3年'],['all','全部']].map(([k,l])=>`<button data-range="${k}" aria-pressed="${ui.range===k}">${l}</button>`).join('')}</div></div></div>
          <div class="view-tabs" role="tablist">${[['returns','收益对比'],['position','仓位与状态'],['flow','资金流']].map(([k,l])=>`<button role="tab" data-view="${k}" aria-selected="${ui.view===k}">${l}</button>`).join('')}</div>
          <div class="chart-shell"><div class="chart-frame"><div class="chart-legend" id="legend"></div><svg id="main-chart" class="chart" role="img" aria-label="V4策略、沪深300基准、仓位及资金流趋势"></svg><div class="state-band" aria-label="状态轨道"><span class="warning" style="flex:26">下行预警 50%</span><span class="hold" style="flex:48">基准持有 100%</span><span class="defense" style="flex:26">风险防御 10%</span></div></div><aside id="inspector" class="inspector"></aside></div>
        </article>
        <aside class="diagnostics"><h2>关键信号（T-1截面）</h2><ul class="signal-list">
          ${metricRow('ETF 4周净流入',fmtPct(cur.signals.flow4w,2),`1周 ${fmtPct(cur.signals.flow1w,2)} · 规模加权流入覆盖 ${fmtPct(cur.signals.positiveAumBreadth,0)}`,'teal')}
          ${metricRow('PE 五年分位（TTM）',fmtPct(cur.signals.pe5yPercentile,1),`滚动PE ${fmtNum(cur.signals.pe,2)} · 高于80%进入高估值警戒`,'amber')}
          ${metricRow('4周价格变化',fmtPct(cur.signals.price4w,2),`相对20周均线 ${fmtPct(cur.signals.priceVsMa20,2)}`,'blue')}
          ${metricRow('13周均线斜率',cur.signals.ma13Slope==null?'向下':fmtPct(cur.signals.ma13Slope,2),`趋势方向：${cur.signals.ma13Direction==='down'?'向下':'向上'} · 正式状态按周五确认`,'violet')}
        </ul></aside>
      </section>
      <section class="bottom-grid"><article class="ledger"><h2>最近状态切换记录</h2><div class="table-wrap"><table><thead><tr><th>生效日期</th><th>状态</th><th>目标仓位</th><th>触发条件摘要</th></tr></thead><tbody>${data.recentTransitions.map(t=>`<tr><td>${t.date}</td><td class="${t.state==='defense'?'coral':t.state==='warning'?'amber':'teal'}">${stateText[t.state]}</td><td>${fmtPosition(t.position)}</td><td>${t.reason}</td></tr>`).join('')}</tbody></table></div></article>
        <article class="performance"><h2>绩效对比</h2><div class="metric-grid"><div><div class="header">策略 / 基准</div><div class="value">V4</div></div><div><div class="header">年化收益</div><div class="value teal">${fmtPct(data.performance.v4.cagr,2)}</div></div><div><div class="header">最大回撤</div><div class="value teal">${fmtPct(data.performance.v4.maxDrawdown,2)}</div></div><div><div class="header">夏普</div><div class="value">${fmtNum(data.performance.v4.sharpe,2)}</div></div><div><div class="header">策略 / 基准</div><div class="value">满仓持有</div></div><div><div class="header">年化收益</div><div class="value blue">${fmtPct(data.performance.benchmark.cagr,2)}</div></div><div><div class="header">最大回撤</div><div class="value blue">${fmtPct(data.performance.benchmark.maxDrawdown,2)}</div></div><div><div class="header">夏普</div><div class="value">${fmtNum(data.performance.benchmark.sharpe,2)}</div></div></div><p class="subcopy">回测基期 ${data.performance.period}；策略曲线为研究回测端点，日更任务刷新最新行情与正式信号。</p></article></section>
      <section class="method"><details><summary>方法与数据口径</summary><p>${data.methodology.details}</p></details><span>数据模式：${data.status.mode==='live'?'自动更新':'研究快照'} · 最近任务 ${data.status.generatedAt}</span></section>
    </main>
    <footer class="footer"><span>数据源：中证指数、上海证券交易所、深圳证券交易所；自动任务北京时间09:00运行。</span><strong>策略信号，不构成投资建议；份额流入不等同主力买入。</strong></footer>`;
  const legend=document.querySelector('#legend');
  legend.innerHTML=ui.view==='returns'?`<span class="legend-key teal"><i class="swatch"></i>V4策略净值</span><span class="legend-key blue"><i class="swatch dashed"></i>沪深300满仓净值</span>`:ui.view==='position'?`<span class="legend-key coral"><i class="swatch"></i>V4目标仓位</span><span class="legend-key blue"><i class="swatch dashed"></i>沪深300净值</span>`:`<span class="legend-key teal"><i class="swatch"></i>4周ETF净流入率</span>`;
  const updateInspector=idx=>{ selected=idx; const d=series[idx]; setQuery({date:d.date}); const el=document.querySelector('#inspector'); el.innerHTML=`<div class="inspect-date">已选日期 ${d.date}${d.quality==='annual'?' · 年度回测点':''}</div><div class="inspect-metric"><span>V4策略净值</span><strong class="teal">${fmtNum(d.v4,3)}</strong></div><div class="inspect-metric"><span>沪深300满仓净值</span><strong class="blue">${fmtNum(d.benchmark,3)}</strong></div><div class="inspect-metric"><span>目标仓位</span><strong class="coral">${fmtPosition(d.position)}</strong></div>`; renderChart(document.querySelector('#main-chart'),series,{selectedIndex:selected,onSelect:updateInspector,mode:ui.view}); };
  updateInspector(selected);
  document.querySelectorAll('[data-range]').forEach(b=>b.addEventListener('click',()=>{setQuery({range:b.dataset.range,date:null});render(data);}));
  document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>{setQuery({view:b.dataset.view,date:null});render(data);}));
  let ro=new ResizeObserver(()=>renderChart(document.querySelector('#main-chart'),series,{selectedIndex:selected,onSelect:updateInspector,mode:ui.view})); ro.observe(document.querySelector('.chart-frame'));
}

app.innerHTML='<div class="loading">正在载入V4策略快照…</div>';
loadSnapshot().then(render).catch(err=>{app.innerHTML=`<div class="error-box"><h1>数据载入失败</h1><p>${err.message}</p><p>请检查 public/data/v4-snapshot.json 或网络连接。</p></div>`;});
if('serviceWorker' in navigator) navigator.serviceWorker.register('./service-worker.js').catch(()=>{});
