<script>
  import { onDestroy } from 'svelte';
  import Chart from 'chart.js/auto';
  import { INTERACTIVE_CHART_LEGEND } from '../charts/terminal.js';
  import {
    currentCurrency,
    exchangeRates,
    currencyConfig,
    formatCurrencyCompact,
    getCurrencySymbol,
    fetchHistoricalRates,
    interpolateRate
  } from '../stores/currency.js';
  import { formatNumber, simplifyNumber } from '../utils/formatting.js';
  import { fromBaseUnit } from '../utils/blockchain.js';
  import { loadBondHistory } from './data.js';
  import { churnCsvRows, combineChurnHistories, isBondEvent, mergeBondTxMaps } from './bond-history.js';

  /** Bonded THOR addresses in view; several merge into one portfolio history. */
  export let addresses = [];
  /** Who the history covers, for the block header and download names. */
  export let scope = '';
  export let fileTag = 'portfolio';

  const PAGE_SIZE = 20;
  const ADD_COLOR = '#5588cc';
  const REMOVE_COLOR = '#cc4444';

  let includeHistorical = false;
  let history = [];
  let txMap = {};
  let hasHistorical = false;
  let loading = false;
  let loaded = false;
  let error = '';
  let requestId = 0;

  let canvas;
  let chart;
  /** currency → fetched rate points; replaced (not mutated) so the chart and table redraw. */
  let historicalRates = {};
  let page = 1;

  $: addressKey = [...addresses].sort().join(',');
  $: load(addressKey, includeHistorical);
  $: reversed = [...history].reverse();
  $: totalPages = Math.max(1, Math.ceil(reversed.length / PAGE_SIZE));
  $: if (page > totalPages) page = 1;
  $: paged = reversed.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  $: if (loaded && $currentCurrency !== 'USD') loadHistoricalRates($currentCurrency);
  $: if (canvas && history.length) drawChart(history, $currentCurrency, $exchangeRates, historicalRates);
  $: decimals = (currencyConfig[$currentCurrency] || {}).decimals || 0;

  async function load(key, historical) {
    const id = ++requestId;
    const list = key ? key.split(',') : [];
    if (!list.length) {
      history = [];
      loaded = false;
      return;
    }
    loading = true;
    error = '';
    const settled = await Promise.allSettled(list.map((address) => loadBondHistory(address, { includeHistorical: historical })));
    if (id !== requestId) return;
    const results = settled.filter((item) => item.status === 'fulfilled').map((item) => item.value);
    const failed = settled.flatMap((item, index) => (item.status === 'rejected' ? [`…${list[index].slice(-4)}: ${item.reason?.message || item.reason}`] : []));
    history = combineChurnHistories(results.map((result) => result.history));
    txMap = mergeBondTxMaps(results.map((result) => result.txMap));
    hasHistorical = results.some((result) => result.hasHistorical);
    historicalRates = {};
    error = failed.length ? `history unavailable for ${failed.join('; ')}` : '';
    loading = false;
    loaded = true;
  }

  // ---- currency conversion (same precedence as the classic Bond Tracker) ----

  async function loadHistoricalRates(currency) {
    if (currency === 'USD' || historicalRates[currency] || !history.length) return;
    const id = requestId;
    const points = await fetchHistoricalRates(currency, history[0].timestampSec, Math.floor(Date.now() / 1000));
    if (id !== requestId) return;
    historicalRates = { ...historicalRates, [currency]: points };
  }

  /** USD → selected currency at the churn's own date: stored rate, then fetched history, then today's rate. */
  function convertChurnValue(usdValue, entry, currency, rates, rateHistory) {
    if (currency === 'USD' || !rates?.USD) return usdValue;
    const isFiat = ['EUR', 'GBP', 'JPY'].includes(currency);

    if (entry.ratesJson) {
      if (isFiat && entry.ratesJson[currency] && entry.runePrice > 0) {
        return usdValue * (entry.ratesJson[currency] / entry.runePrice);
      }
      const assetUsd = entry.ratesJson[`${currency}_USD`];
      if (assetUsd) return usdValue / assetUsd;
      if (entry.ratesJson[currency]) return usdValue * (entry.ratesJson[currency] / entry.runePrice);
    }

    const points = rateHistory[currency];
    if (points?.length) {
      if (isFiat) {
        const rate = interpolateRate(points, entry.timestampSec, true);
        if (rate?.fiat && rate?.usd) return usdValue * (rate.fiat / rate.usd);
      } else {
        const assetUsdPrice = interpolateRate(points, entry.timestampSec, false);
        if (assetUsdPrice > 0) return usdValue / assetUsdPrice;
      }
    }

    return rates[currency] ? usdValue * (rates[currency] / rates.USD) : usdValue;
  }

  // ---- chart ----

  function drawChart(entries, currency, rates, rateHistory) {
    chart?.destroy();
    const config = currencyConfig[currency] || currencyConfig.USD;
    const sym = getCurrencySymbol(currency);
    const bondEvents = entries.map((entry) => (isBondEvent(entry.bondChange) ? entry.bondChange : 0));
    const pointColor = bondEvents.map((change) => (change > 0 ? ADD_COLOR : change < 0 ? REMOVE_COLOR : '#00cc66'));

    // Label the latest value at the end of each line.
    const lastPointLabel = {
      id: 'lastPointLabel',
      afterDatasetsDraw(instance) {
        const { ctx } = instance;
        instance.data.datasets.forEach((dataset, index) => {
          const point = instance.getDatasetMeta(index).data.at(-1);
          if (!point) return;
          const value = dataset.data.at(-1);
          const isRune = dataset.yAxisID === 'y';
          const text = isRune
            ? `${formatNumber(value, { maximumFractionDigits: 0 })} ᚱ`
            : sym + formatNumber(value, { maximumFractionDigits: config.decimals });
          ctx.save();
          ctx.font = "600 11px 'JetBrains Mono', monospace";
          ctx.fillStyle = isRune ? '#00cc66' : '#d4a017';
          ctx.textAlign = isRune ? 'left' : 'right';
          ctx.fillText(text, point.x + (isRune ? -ctx.measureText(text).width - 8 : 8), point.y - 8);
          ctx.restore();
        });
      }
    };
    const mono = (size, weight) => ({ family: "'JetBrains Mono', monospace", size, ...(weight ? { weight } : {}) });

    chart = new Chart(canvas, {
      type: 'line',
      plugins: [lastPointLabel],
      data: {
        labels: entries.map((entry) => entry.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })),
        datasets: [
          {
            label: 'RUNE STACK',
            data: entries.map((entry) => fromBaseUnit(entry.runeStack)),
            borderColor: '#00cc66',
            backgroundColor: 'rgba(0, 204, 102, 0.05)',
            fill: true,
            tension: 0.2,
            yAxisID: 'y',
            pointRadius: 2,
            pointHoverRadius: 5,
            pointBackgroundColor: pointColor,
            pointBorderColor: pointColor,
            pointBorderWidth: 0,
            borderWidth: 1.5,
            segment: {
              borderColor: (ctx) => {
                const change = bondEvents[ctx.p1DataIndex];
                return change > 0 ? ADD_COLOR : change < 0 ? REMOVE_COLOR : undefined;
              },
              borderWidth: (ctx) => (bondEvents[ctx.p1DataIndex] !== 0 ? 2.5 : undefined)
            }
          },
          {
            label: `${currency} VALUE`,
            data: entries.map((entry) => convertChurnValue(entry.usdValue, entry, currency, rates, rateHistory)),
            borderColor: '#d4a017',
            backgroundColor: 'rgba(212, 160, 23, 0.05)',
            fill: true,
            tension: 0.2,
            yAxisID: 'y1',
            pointRadius: 2,
            pointHoverRadius: 5,
            pointBackgroundColor: '#d4a017',
            borderWidth: 1.5
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: {
            grid: { color: 'rgba(255, 255, 255, 0.04)', lineWidth: 0.5 },
            ticks: { color: '#c8c8c8', font: mono(11) },
            border: { color: '#1a1a1a' }
          },
          y: {
            type: 'linear',
            position: 'left',
            grid: { color: 'rgba(255, 255, 255, 0.04)', lineWidth: 0.5 },
            border: { color: '#1a1a1a' },
            ticks: { color: '#00cc66', font: mono(11), callback: (value) => `${simplifyNumber(Number(value))} ᚱ` }
          },
          y1: {
            type: 'linear',
            position: 'right',
            grid: { drawOnChartArea: false },
            border: { color: '#1a1a1a' },
            ticks: { color: '#d4a017', font: mono(11), callback: (value) => formatCurrencyCompact(Number(value), currency) }
          }
        },
        plugins: {
          legend: {
            ...INTERACTIVE_CHART_LEGEND,
            labels: { color: '#e8e8e8', font: mono(11, 600), boxWidth: 12, boxHeight: 2, padding: 16 }
          },
          tooltip: {
            backgroundColor: '#1a1a1a',
            borderColor: '#333',
            borderWidth: 1,
            titleFont: mono(12, 700),
            bodyFont: mono(12, 500),
            titleColor: '#fff',
            bodyColor: '#f5f5f5',
            padding: 10,
            callbacks: {
              label: (context) => (context.dataset.yAxisID === 'y'
                ? ` ᚱ ${formatNumber(Number(context.raw), { maximumFractionDigits: 1 })}`
                : ` ${sym}${formatNumber(Number(context.raw), { maximumFractionDigits: config.decimals })}`),
              afterBody: (items) => {
                const change = items.length ? bondEvents[items[0].dataIndex] : 0;
                if (!change) return '';
                const amount = formatNumber(fromBaseUnit(Math.abs(change)), { maximumFractionDigits: 1 });
                return `\n ${change > 0 ? 'BOND ADD' : 'BOND REMOVE'}: ${change > 0 ? '+' : '-'}${amount} ᚱ`;
              }
            }
          }
        }
      }
    });
  }

  // ---- downloads ----

  function download(separator, extension, mimeType) {
    const rows = churnCsvRows(history);
    const headers = Object.keys(rows[0]);
    const content = [headers.join(separator), ...rows.map((row) => headers.map((key) => row[key]).join(separator))].join('\n');
    const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `bond-churns-${fileTag}.${extension}`;
    link.click();
    URL.revokeObjectURL(url);
  }

  /** Page numbers near the current page plus both ends, with gaps elided (classic pager). */
  function pageButtons(current, total) {
    return Array.from({ length: total }, (_, index) => index + 1)
      .map((number) => (total <= 7 || number === 1 || number === total || Math.abs(number - current) <= 1 ? number
        : (number === 2 && current > 3) || (number === total - 1 && current < total - 2) ? '…' : null))
      .filter((item) => item !== null);
  }

  onDestroy(() => {
    requestId += 1;
    chart?.destroy();
  });
</script>

<section class="block">
  <div class="block-head">
    <div class="block-title"><span class="title-marker">▌</span><h2>bond history</h2></div>
    <div class="block-actions">
      <span class="block-meta">[{scope}{loaded && history.length ? ` · last ${history.length} churns` : ''}]</span>
      {#if hasHistorical}
        <button
          class="range-btn"
          class:active={includeHistorical}
          aria-pressed={includeHistorical}
          title="Include bond history from nodes these addresses have since left"
          on:click={() => (includeHistorical = !includeHistorical)}
        >past nodes</button>
      {/if}
    </div>
  </div>

  {#if error}<p class="hint warn-text history-note">{error}</p>{/if}
  <div class="chart-box history-chart">
    {#if loading}
      <p class="loader chart-note">▓░░░░ loading bond history</p>
    {:else if loaded && !history.length && !error}
      <p class="hint chart-note">No bond history found.</p>
    {/if}
    <canvas bind:this={canvas} class:hidden={loading || !history.length}></canvas>
  </div>
</section>

<section class="block">
  <div class="block-head">
    <div class="block-title"><span class="title-marker">▌</span><h2>churn earnings</h2></div>
    <div class="block-actions">
      <span class="block-meta">[{reversed.length} churns]</span>
      {#if history.length}
        <button class="row-btn" on:click={() => download(',', 'csv', 'text/csv')}>.csv</button>
        <button class="row-btn" on:click={() => download('\t', 'xls', 'application/vnd.ms-excel')}>.xls</button>
      {/if}
    </div>
  </div>

  {#if loading && !history.length}
    <p class="loader">▓░░░░ loading churns</p>
  {:else if !history.length}
    <p class="hint">No churn earnings found.</p>
  {:else}
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>date</th>
            <th class="right">reward ᚱ</th>
            <th class="right">bond ±</th>
            <th class="right">{$currentCurrency}</th>
            <th class="right">apy</th>
            <th class="right">stack ᚱ</th>
          </tr>
        </thead>
        <tbody>
          {#each paged as churn (churn.height)}
            {@const event = isBondEvent(churn.bondChange)}
            {@const changeRune = fromBaseUnit(churn.bondChange)}
            {@const change = `${changeRune > 0 ? '+' : ''}${formatNumber(changeRune, { maximumFractionDigits: Math.abs(changeRune) < 10 ? 2 : 0 })}`}
            <tr>
              <td class="nowrap">{churn.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
              <td class="right" class:accent={churn.reward > 0}>{churn.reward > 0 ? '+' : ''}{formatNumber(fromBaseUnit(churn.reward), { maximumFractionDigits: 2 })}</td>
              <td class="right" class:bond-add={event && churn.bondChange > 0} class:bond-remove={event && churn.bondChange < 0} class:nil={!event}>
                {#if !event}--{:else if txMap[churn.height]?.length}<a href="https://thorchain.net/tx/{txMap[churn.height][0]}" target="_blank" rel="noopener noreferrer">{change}</a>{:else}{change}{/if}
              </td>
              <td class="right dim-cell">{getCurrencySymbol($currentCurrency)}{formatNumber(convertChurnValue(fromBaseUnit(churn.reward) * churn.runePrice, churn, $currentCurrency, $exchangeRates, historicalRates), { maximumFractionDigits: decimals })}</td>
              <td class="right" class:accent={churn.apy > 0.15}>{(churn.apy * 100).toFixed(1)}%</td>
              <td class="right">{formatNumber(fromBaseUnit(churn.runeStack), { maximumFractionDigits: 0 })}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    {#if totalPages > 1}
      <nav class="pager" aria-label="Churn pages">
        <button class="row-btn" disabled={page <= 1} on:click={() => (page -= 1)}>prev</button>
        {#each pageButtons(page, totalPages) as item}
          {#if item === '…'}<span class="pager-gap">…</span>
          {:else}<button class="row-btn" class:current={page === item} aria-current={page === item ? 'page' : undefined} on:click={() => (page = Number(item))}>{item}</button>{/if}
        {/each}
        <button class="row-btn" disabled={page >= totalPages} on:click={() => (page += 1)}>next</button>
      </nav>
    {/if}
  {/if}
</section>
