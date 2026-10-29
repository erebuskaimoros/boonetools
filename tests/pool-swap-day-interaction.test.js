import assert from 'node:assert/strict';
import test from 'node:test';
import { init, use } from 'echarts/core';
import { BarChart, LineChart } from 'echarts/charts';
import { DataZoomInsideComponent, GridComponent, ToolboxComponent, TooltipComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import { createTimeSeriesController } from '../src/lib/charts/controller.js';
import { buildPoolAnalysisOption } from '../src/lib/pool-analysis/charts.js';
import { fetchPoolAnalysisSwaps } from '../src/lib/pool-analysis/api.js';
import { financialDayPollDelay } from '../src/lib/financials/day-poll.js';
import { financialDayStatus } from '../src/lib/financials/day-status.js';
use([BarChart,LineChart,DataZoomInsideComponent,GridComponent,ToolboxComponent,TooltipComponent,SVGRenderer]);

test('pool daily chart selects the clicked date but not a zoom drag or outside click',()=>{
  const points=Array.from({length:5},(_,i)=>({day:`2026-10-${25+i}`,volumeUsd:100+i,feesUsd:i,cumulativeFeesUsd:10+i}));
  const chart=init(null,null,{renderer:'svg',ssr:true,width:1100,height:490});
  const selected=[];
  const controller=createTimeSeriesController(chart,{points,options:{selectWithZoom:true}},
    {buildOption:buildPoolAnalysisOption,width:()=>1100,onSelect:day=>selected.push(day)});
  try {
    const trigger=(name,x,y=80)=>chart.getZr().trigger(name,{offsetX:x,offsetY:y,event:{preventDefault(){},stopPropagation(){}}});
    const x=chart.convertToPixel({xAxisIndex:0},2);
    trigger('mousedown',x);trigger('mouseup',x);trigger('click',x);
    assert.deepEqual(selected,['2026-10-27']);
    trigger('mousedown',x);trigger('mousemove',x+35);trigger('mouseup',x+35);trigger('click',x+35);
    trigger('mousedown',0,0);trigger('mouseup',0,0);trigger('click',0,0);
    assert.deepEqual(selected,['2026-10-27']);
  } finally {controller.destroy();}
});

test('pool detail request carries the full pool ID, local day and timezone with cancellation',async t=>{
  const abort=new AbortController();let query,request;
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    query=new URL(url,'https://test.invalid');request=options;
    return {ok:true,headers:new Headers(),json:async()=>({swaps:[]})};
  });
  await fetchPoolAnalysisSwaps('ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48','2026-11-01',
    {timeZone:'America/New_York',signal:abort.signal});
  assert.equal(query.pathname,'/functions/v1/pool-analysis-swaps');
  assert.equal(query.searchParams.get('asset'),'ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48');
  assert.equal(query.searchParams.get('day'),'2026-11-01');
  assert.equal(query.searchParams.get('timeZone'),'America/New_York');
  assert.equal(request.signal,abort.signal);
});

test('pre-tracking pool dates stop polling; gaps and pending candidates poll slowly without triggering scans',()=>{
  assert.equal(financialDayPollDelay({availability:'before-tracking',partial:true}),null);
  const detail={swapRankingBasis:'pool-liquidity-fees-usd',swapSource:'finalized-block-ledger',refreshing:true};
  assert.equal(financialDayPollDelay(detail),60000);
  const status=financialDayStatus({...detail,pendingSwaps:2,unpricedSwaps:1,settlement:{status:'pending'}});
  assert.match(status.warning,/awaiting completion or verification/);
  assert.match(status.warning,/missing fee or price/);
  assert.match(status.settlement,/day is not rescanned/);
});
