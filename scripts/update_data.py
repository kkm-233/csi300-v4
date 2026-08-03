#!/usr/bin/env python3
"""Update CSI300 V4 dashboard data.

The job is designed for GitHub Actions at 09:00 Asia/Shanghai (01:00 UTC).
It keeps the existing research snapshot if a remote source fails, and writes a
status message instead of fabricating market data.
"""
from __future__ import annotations
import json, math, os, sys, time
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

ROOT=Path(__file__).resolve().parents[1]
SNAPSHOT=ROOT/'public/data/v4-snapshot.json'
CONFIG=ROOT/'config/v4.json'
CACHE=ROOT/'data-cache'
CACHE.mkdir(exist_ok=True)
TZ=ZoneInfo('Asia/Shanghai')

def read_json(path): return json.loads(Path(path).read_text(encoding='utf-8'))
def write_json(path,obj): Path(path).write_text(json.dumps(obj,ensure_ascii=False,indent=2,allow_nan=False)+'\n',encoding='utf-8')
def finite(v, default=None):
    try:
        x=float(v); return x if math.isfinite(x) else default
    except Exception: return default

def import_akshare():
    try: import akshare as ak; return ak
    except ImportError as e: raise RuntimeError('akshare is required for live refresh; run pip install -r requirements.txt') from e

def csi300_history(ak, start='20210701'):
    end=datetime.now(TZ).strftime('%Y%m%d')
    d=ak.stock_zh_index_hist_csindex(symbol='000300',start_date=start,end_date=end)
    d=d.rename(columns={'日期':'date','收盘':'close','滚动市盈率':'pe'})[['date','close','pe']]
    d['date']=pd.to_datetime(d.date); d=d.dropna(subset=['date','close']).sort_values('date').drop_duplicates('date')
    return d

def total_return_history(ak, start='20190101'):
    end=datetime.now(TZ).strftime('%Y%m%d')
    d=ak.stock_zh_index_hist_csindex(symbol='H00300',start_date=start,end_date=end)
    d=d.rename(columns={'日期':'date','收盘':'close'})[['date','close']]
    d['date']=pd.to_datetime(d.date); return d.dropna().sort_values('date').drop_duplicates('date')

def filter_universe(df,cfg):
    if df.empty: return df
    name_col=next(c for c in df.columns if '简称' in c or '名称' in c)
    code_col=next(c for c in df.columns if '代码' in c)
    names=df[name_col].astype(str)
    base=names.str.contains('沪深300|300ETF',regex=True)
    for kw in cfg['exclude_name_keywords']: base &= ~names.str.contains(kw,regex=False)
    out=df.loc[base].copy(); out['code']=out[code_col].astype(str).str.zfill(6); out['name']=out[name_col].astype(str)
    return out

def get_sse_scale(ak,date):
    try:
        d=ak.fund_etf_scale_sse(date=pd.Timestamp(date).strftime('%Y%m%d'))
        d=d.rename(columns={'基金代码':'code','基金简称':'name','基金份额':'shares'})
        d['code']=d.code.astype(str).str.zfill(6); d['shares']=pd.to_numeric(d.shares,errors='coerce')
        return d[['code','name','shares']]
    except Exception:
        return pd.DataFrame(columns=['code','name','shares'])

def get_szse_scale_latest(ak):
    d=ak.fund_etf_scale_szse().rename(columns={'基金代码':'code','基金简称':'name','基金份额':'shares','净值':'nav'})
    d['code']=d.code.astype(str).str.zfill(6); d['shares']=pd.to_numeric(d.shares,errors='coerce'); d['nav']=pd.to_numeric(d.get('nav'),errors='coerce')
    return d[['code','name','shares','nav']]

def get_szse_range(ak,start,end):
    d=ak.fund_scale_daily_szse(start_date=pd.Timestamp(start).strftime('%Y%m%d'),end_date=pd.Timestamp(end).strftime('%Y%m%d'),symbol='ETF')
    d=d.rename(columns={'日期':'date','基金代码':'code','基金简称':'name','基金份额':'shares'})
    d['date']=pd.to_datetime(d.date);d['code']=d.code.astype(str).str.zfill(6);d['shares']=pd.to_numeric(d.shares,errors='coerce')
    return d[['date','code','name','shares']]

def nav_history(ak,code,start,end):
    d=ak.fund_etf_fund_info_em(fund=code,start_date=pd.Timestamp(start).strftime('%Y%m%d'),end_date=pd.Timestamp(end).strftime('%Y%m%d'))
    d=d.rename(columns={'净值日期':'date','单位净值':'nav'})[['date','nav']]
    d['date']=pd.to_datetime(d.date);d['nav']=pd.to_numeric(d.nav,errors='coerce');return d.dropna()

def weekly_share_panel(ak, idx, cfg):
    # Cache only the rolling window needed by the flow percentile. First live run
    # bootstraps ~110 Fridays; later runs append the newest completed week.
    cache=CACHE/'weekly_shares.csv'
    lookback=cfg['flow_lookback_weeks']+8
    weekly=idx.set_index('date').resample('W-FRI').last().dropna(subset=['close']).tail(lookback)
    dates=list(weekly.index)
    existing=pd.read_csv(cache,parse_dates=['date']) if cache.exists() else pd.DataFrame(columns=['date','code','name','shares'])
    have=set(pd.to_datetime(existing.date).dt.strftime('%Y-%m-%d')) if len(existing) else set()
    rows=[]
    for dt in dates:
        key=dt.strftime('%Y-%m-%d')
        if key in have: continue
        actual=idx.loc[idx.date<=dt,'date'].max()
        sse=get_sse_scale(ak,actual)
        if len(sse): sse['date']=actual; rows.append(sse[['date','code','name','shares']])
        time.sleep(0.08)
    # Shenzhen can be fetched in six-month chunks.
    missing_start=(dates[0]-pd.Timedelta(days=8)).normalize(); missing_end=dates[-1].normalize()
    chunks=[]; cur=missing_start
    while cur<=missing_end:
        end=min(cur+pd.DateOffset(months=5,days=20),missing_end)
        try: chunks.append(get_szse_range(ak,cur,end))
        except Exception: pass
        cur=end+pd.Timedelta(days=1)
    if chunks:
        sz=pd.concat(chunks,ignore_index=True).sort_values('date')
        picks=[]
        for dt in dates:
            q=sz[sz.date<=dt]
            if q.empty: continue
            a=q.date.max(); picks.append(q[q.date==a])
        if picks: rows.append(pd.concat(picks,ignore_index=True))
    allp=pd.concat([existing,*rows],ignore_index=True) if rows else existing
    allp['date']=pd.to_datetime(allp.date); allp=allp.sort_values(['date','code']).drop_duplicates(['date','code'],keep='last')
    allp.to_csv(cache,index=False)
    return allp

def compute_flows(ak,panel,idx,cfg):
    latest_sse=get_sse_scale(ak,idx.date.max()); latest_sz=get_szse_scale_latest(ak)
    universe=pd.concat([latest_sse.assign(nav=np.nan),latest_sz],ignore_index=True)
    universe=filter_universe(universe,cfg).drop_duplicates('code')
    codes=set(universe.code)
    p=panel[panel.code.isin(codes)].copy()
    if p.empty: raise RuntimeError('No CSI300 ETF share records matched the eligible universe')
    start=p.date.min()-pd.Timedelta(days=10); end=p.date.max()+pd.Timedelta(days=2)
    navs=[]
    for code in sorted(codes):
        try:
            n=nav_history(ak,code,start,end); n['code']=code; navs.append(n)
        except Exception: pass
        time.sleep(0.04)
    if navs:
        n=pd.concat(navs,ignore_index=True).sort_values(['code','date'])
        p=p.sort_values(['code','date'])
        p=pd.merge_asof(p,n,on='date',by='code',direction='backward',tolerance=pd.Timedelta(days=10))
    else: p['nav']=1.0
    p['nav']=p.nav.fillna(1.0);p['aum']=p.shares*p.nav
    p['prev_shares']=p.groupby('code').shares.shift();p['prev_aum']=p.groupby('code').aum.shift();p['flow']=(p.shares-p.prev_shares)*p.nav
    g=[]
    for dt,q in p.groupby('date'):
        valid=q.dropna(subset=['prev_shares','prev_aum'])
        prev=valid.prev_aum.sum(); flow=valid.flow.sum();
        g.append({'date':dt,'flow_amount':flow,'flow1w':flow/prev if prev else np.nan,'positiveFundBreadth':float((valid.shares>valid.prev_shares).mean()) if len(valid) else np.nan,'negativeFundBreadth':float((valid.shares<valid.prev_shares).mean()) if len(valid) else np.nan,'positiveAumBreadth':float(valid.loc[valid.shares>valid.prev_shares,'prev_aum'].sum()/prev) if prev else np.nan,'negativeAumBreadth':float(valid.loc[valid.shares<valid.prev_shares,'prev_aum'].sum()/prev) if prev else np.nan,'aum':q.aum.sum()})
    w=pd.DataFrame(g).sort_values('date').set_index('date')
    w['flow4wAmount']=w.flow_amount.rolling(4).sum(); w['flow4w']=w.flow4wAmount/w.aum.shift(4)
    def pct(s): return s.rolling(cfg['flow_lookback_weeks'],min_periods=max(52,cfg['flow_lookback_weeks']//2)).apply(lambda a: pd.Series(a).rank(pct=True).iloc[-1],raw=False)
    w['flow1Pct']=pct(w.flow1w);w['flow4Pct']=pct(w.flow4w)
    return w

def decide_state(snapshot,idx,flows,cfg):
    widx=idx.set_index('date').resample('W-FRI').last().dropna(subset=['close'])
    widx['price4w']=widx.close.pct_change(4);widx['ma13']=widx.close.rolling(cfg['trend_ma_weeks']).mean();widx['ma13Slope']=widx.ma13.pct_change(4);widx['ma20']=widx.close.rolling(20).mean()
    merged=widx.join(flows,how='inner').dropna(subset=['flow1w','flow4w'])
    if merged.empty: raise RuntimeError('Weekly index/share history does not overlap')
    # Five-year PE percentile uses daily observations available at T-1.
    daily=idx.dropna(subset=['pe']).set_index('date');latest_date=idx.date.max();pe_window=daily.loc[:latest_date].tail(252*5);pe=float(pe_window.pe.iloc[-1]);pe_pct=float((pe_window.pe<=pe).mean())
    # Formal state only changes on a new completed weekly observation.
    last=merged.iloc[-1]; last_date=merged.index[-1]
    engine=snapshot.get('engineState',{}); state=engine.get('state','hold'); signal_date=pd.Timestamp(engine.get('formalSignalDate','1900-01-01'))
    extreme=cfg['extreme_percentile']; breadth=cfg['breadth_threshold']
    buy=(((last.flow1Pct>=extreme) or (last.flow4Pct>=extreme)) and last.flow1w>0 and last.positiveFundBreadth>=breadth)
    sell=(((last.flow1Pct<=1-extreme) or (last.flow4Pct<=1-extreme)) and last.flow1w<0 and last.negativeFundBreadth>=breadth)
    warning_until=pd.Timestamp(engine['warningUntil']) if engine.get('warningUntil') else None
    repair_until=pd.Timestamp(engine['repairArmedUntil']) if engine.get('repairArmedUntil') else None
    price_weak=last.price4w<0 or last.close<last.ma13
    reason='状态未变化'
    if last_date>signal_date:
        if sell and pe_pct>=cfg['high_valuation_percentile'] and price_weak:
            state='warning';warning_until=last_date+pd.Timedelta(weeks=cfg['warning_weeks']);reason='高估值极端赎回触发下行预警'
        if state=='warning':
            confirm=(last.close<last.ma13 and last.ma13Slope<=0 and last.price4w<0)
            if confirm or (sell and last_date>signal_date): state='defense';reason='价格趋势确认恶化，进入风险防御'
            elif warning_until and last_date>warning_until: state='hold';reason='下行预警到期但趋势未确认恶化'
        buy_failure=(buy and state=='warning' and last.close<last.ma13 and last.ma13Slope<=0 and last.price4w<0)
        if buy_failure: state='defense';reason='大额申购后价格继续破位，触发申购失败防御'
        if state=='defense' and buy and pe_pct<=cfg['recovery_valuation_percentile']:
            repair_until=last_date+pd.Timedelta(weeks=cfg['repair_window_weeks']);reason='高质量申购启动修复观察窗口'
        if state=='defense' and repair_until and last_date<=repair_until and last.close>=last.ma13 and last.ma13Slope>0 and last.price4w>=0:
            state='hold';repair_until=None;reason='资金与13周趋势共同确认修复，恢复基准持有'
        signal_date=last_date
    target={'hold':cfg['hold_position'],'warning':cfg['warning_position'],'defense':cfg['defense_position']}[state]
    # New-account entry grade is intentionally stricter than existing-account target.
    risk_cap=(pe_pct>=.80 and last.price4w<0 and last.positiveFundBreadth<.60)
    strong=state=='hold' and last.close>=last.ma13 and last.ma13Slope>0 and last.price4w>=0 and not risk_cap
    standard=state=='hold' and ((last.close>=last.ma13) or pe_pct<=.50) and last.price4w>=0
    test=state=='defense' and buy and pe_pct<=cfg['test_valuation_percentile'] and last.positiveAumBreadth>=breadth and last.price4w>=-.01
    grade='strong' if strong else 'standard' if standard else 'test' if test else 'wait'
    return {
      'dataDate':idx.date.max().strftime('%Y-%m-%d'),'state':state,'target':target,'entryGrade':grade,'reason':reason,
      'engine':{'formalSignalDate':signal_date.strftime('%Y-%m-%d'),'state':state,'targetPosition':target,'warningUntil':warning_until.strftime('%Y-%m-%d') if warning_until is not None else None,'repairArmedUntil':repair_until.strftime('%Y-%m-%d') if repair_until is not None else None},
      'signals':{'flow1w':finite(last.flow1w),'flow4w':finite(last.flow4w),'flow1wPercentile':finite(last.flow1Pct),'flow4wPercentile':finite(last.flow4Pct),'positiveFundBreadth':finite(last.positiveFundBreadth),'positiveAumBreadth':finite(last.positiveAumBreadth),'pe':pe,'pe5yPercentile':pe_pct,'price4w':finite(last.price4w),'priceVsMa20':finite(last.close/last.ma20-1),'ma13Slope':finite(last.ma13Slope),'ma13Direction':'down' if last.ma13Slope<0 else 'up'}
    }

def main():
    snapshot=read_json(SNAPSHOT);cfg=read_json(CONFIG);now=datetime.now(TZ)
    try:
        ak=import_akshare();idx=csi300_history(ak); panel=weekly_share_panel(ak,idx,cfg);flows=compute_flows(ak,panel,idx,cfg);decision=decide_state(snapshot,idx,flows,cfg)
        old_state=snapshot['current']['state'];snapshot['current']={'state':decision['state'],'targetPosition':decision['target'],'entryGrade':decision['entryGrade'],'signals':decision['signals']};snapshot['engineState']=decision['engine']
        if decision['state']!=old_state:
            snapshot['recentTransitions'].insert(0,{'date':decision['engine']['formalSignalDate'],'state':decision['state'],'position':decision['target'],'reason':decision['reason']});snapshot['recentTransitions']=snapshot['recentTransitions'][:8]
        snapshot['status']={'mode':'live','quality':'good','dataDate':decision['dataDate'],'generatedAt':now.strftime('%Y-%m-%d %H:%M CST'),'message':'自动更新成功'}
        write_json(SNAPSHOT,snapshot);print(f"updated {decision['dataDate']} state={decision['state']} target={decision['target']:.0%}")
    except Exception as e:
        # Do not manufacture new values. Keep last successful snapshot and make the failure visible.
        snapshot['status']['quality']='stale';snapshot['status']['generatedAt']=now.strftime('%Y-%m-%d %H:%M CST');snapshot['status']['message']=f'自动更新失败，保留上一成功快照: {type(e).__name__}: {e}'
        write_json(SNAPSHOT,snapshot);print(snapshot['status']['message'],file=sys.stderr);sys.exit(2)
if __name__=='__main__': main()
