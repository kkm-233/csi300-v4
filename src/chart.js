const NS = 'http://www.w3.org/2000/svg';
const svgEl = (name, attrs = {}) => {
  const el = document.createElementNS(NS, name);
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, String(v)));
  return el;
};
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function extent(values) {
  const filtered = values.filter(Number.isFinite);
  return filtered.length ? [Math.min(...filtered), Math.max(...filtered)] : [0, 1];
}
function pathFrom(points, x, y, key) {
  return points.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)},${y(d[key]).toFixed(2)}`).join(' ');
}
function stepPath(points, x, y, key) {
  let out = '';
  points.forEach((d, i) => {
    if (i === 0) out += `M${x(i)},${y(d[key])}`;
    else out += `H${x(i)}V${y(d[key])}`;
  });
  return out;
}
function fmtDate(s) { return String(s).slice(0, 10); }

export function renderChart(svg, data, options) {
  const { selectedIndex = data.length - 1, onSelect, mode = 'returns' } = options;
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const box = svg.getBoundingClientRect();
  const W = Math.max(320, Math.round(box.width || 760));
  const H = Math.max(260, Math.round(box.height || 330));
  const m = { l: 42, r: 34, t: 16, b: 28 };
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const x = i => m.l + (data.length <= 1 ? iw / 2 : i * iw / (data.length - 1));
  let keys = mode === 'flow' ? ['flow4w'] : mode === 'position' ? ['benchmark', 'position'] : ['v4', 'benchmark'];
  const vals = keys.flatMap(k => data.map(d => Number(d[k])));
  let [yMin, yMax] = extent(vals);
  if (mode === 'position') { yMin = 0; yMax = 1.05; }
  if (mode === 'flow') { const q = Math.max(Math.abs(yMin), Math.abs(yMax), .01); yMin = -q; yMax = q; }
  if (mode === 'returns') { const pad = Math.max(.04, (yMax-yMin)*.12); yMin -= pad; yMax += pad; }
  const y = v => m.t + ih - (Number(v)-yMin)/(yMax-yMin || 1)*ih;
  for (let j=0;j<=4;j++) {
    const yy = m.t + ih*j/4;
    svg.append(svgEl('line',{x1:m.l,x2:W-m.r,y1:yy,y2:yy,class:'grid'}));
    const val = yMax - (yMax-yMin)*j/4;
    const t=svgEl('text',{x:m.l-7,y:yy+4,'text-anchor':'end'}); t.textContent = mode==='flow' ? `${(val*100).toFixed(0)}%` : mode==='position' ? `${Math.round(val*100)}%` : val.toFixed(2); svg.append(t);
  }
  const labels = Math.min(W < 560 ? 3 : 5, data.length);
  for (let j=0;j<labels;j++) {
    const i = Math.round(j*(data.length-1)/Math.max(1,labels-1));
    const t=svgEl('text',{x:x(i),y:H-7,'text-anchor': j===0?'start':j===labels-1?'end':'middle'}); t.textContent=fmtDate(data[i].date).slice(0,7); svg.append(t);
  }
  if (mode === 'returns') {
    const p1=svgEl('path',{d:pathFrom(data,x,y,'v4'),class:'v4-line'}); svg.append(p1);
    const p2=svgEl('path',{d:pathFrom(data,x,y,'benchmark'),class:'benchmark-line'}); svg.append(p2);
  } else if (mode === 'position') {
    const p=svgEl('path',{d:stepPath(data,x,y,'position'),class:'position-line'}); svg.append(p);
    const bm=svgEl('path',{d:pathFrom(data,x,y,'benchmark'),class:'benchmark-line'}); svg.append(bm);
  } else {
    const zero=y(0); svg.append(svgEl('line',{x1:m.l,x2:W-m.r,y1:zero,y2:zero,class:'axis'}));
    const barW=Math.max(3, iw/Math.max(1,data.length)*.58);
    data.forEach((d,i)=>{ const yy=y(d.flow4w||0); svg.append(svgEl('rect',{x:x(i)-barW/2,y:Math.min(yy,zero),width:barW,height:Math.abs(zero-yy),class:`flow-bar ${(d.flow4w||0)>=0?'pos':'neg'}`})); });
  }
  const si=clamp(selectedIndex,0,data.length-1), sx=x(si);
  svg.append(svgEl('line',{x1:sx,x2:sx,y1:m.t,y2:H-m.b,class:'marker'}));
  const primary = mode==='returns' ? data[si].v4 : mode==='position' ? data[si].position : data[si].flow4w;
  const cy=y(primary || 0); svg.append(svgEl('circle',{cx:sx,cy,r:5,fill:mode==='flow'?'var(--amber)':'var(--teal)',stroke:'#d9f2ef','stroke-width':1.5}));
  const hit=svgEl('rect',{x:m.l,y:m.t,width:iw,height:ih,class:'hit',tabindex:'0','aria-label':'策略图表，可点击或使用方向键选择日期'});
  const selectFromClientX=(clientX)=>{ const rect=svg.getBoundingClientRect(); const local=(clientX-rect.left)/rect.width*W; const idx=Math.round((local-m.l)/iw*(data.length-1)); onSelect?.(clamp(idx,0,data.length-1)); };
  hit.addEventListener('pointerdown',e=>selectFromClientX(e.clientX));
  hit.addEventListener('keydown',e=>{ if(e.key==='ArrowLeft'){e.preventDefault();onSelect?.(Math.max(0,si-1));} if(e.key==='ArrowRight'){e.preventDefault();onSelect?.(Math.min(data.length-1,si+1));}});
  svg.append(hit);
}
