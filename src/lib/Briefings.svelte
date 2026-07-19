<script>
  const BASE_PATH = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
  const BRIEFINGS_ROOT = `${BASE_PATH}/briefings`;
  const TRON_SLUG = 'tron-performance-since-launch';
  const TRON_PATH = `${BRIEFINGS_ROOT}/${TRON_SLUG}`;
  const ASSET_ROOT = `${BASE_PATH}/assets/briefings/${TRON_SLUG}`;

  const briefing = {
    title: 'TRON performance on THORChain',
    description: 'Native TRX and TRON-USDT pool volume, liquidity fees, usage, and rankings since launch.',
    published: 'July 18, 2026',
    window: 'Oct 1, 2025 → Jul 18, 2026',
    readTime: '5 min read'
  };

  function getActiveSlug() {
    const pathname = BASE_PATH && window.location.pathname.startsWith(BASE_PATH)
      ? window.location.pathname.slice(BASE_PATH.length)
      : window.location.pathname;
    const segments = pathname.replace(/^\/+|\/+$/g, '').split('/');
    return segments[0] === 'briefings' ? segments.slice(1).join('/') : '';
  }

  let activeSlug = getActiveSlug();

  function navigate(event, slug = '') {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    event.preventDefault();
    const nextPath = slug ? `${BRIEFINGS_ROOT}/${slug}` : BRIEFINGS_ROOT;
    if (window.location.pathname !== nextPath) {
      history.pushState(null, '', nextPath);
    }
    activeSlug = slug;

    if (typeof gtag !== 'undefined') {
      gtag('event', 'page_view', {
        page_title: slug === TRON_SLUG ? briefing.title : 'Briefings',
        page_path: nextPath,
        page_location: window.location.href
      });
    }

    requestAnimationFrame(() => {
      document.querySelector('.content')?.scrollTo({ top: 0, behavior: 'auto' });
    });
  }

  $: pageTitle = activeSlug === TRON_SLUG
    ? `${briefing.title} - BOONE Tools`
    : activeSlug
      ? 'Briefing not found - BOONE Tools'
      : 'Briefings - BOONE Tools';
  $: pageDescription = activeSlug === TRON_SLUG
    ? briefing.description
    : 'Reports, research, and analysis from BooneTools.';
</script>

<svelte:head>
  <title>{pageTitle}</title>
  <meta name="description" content={pageDescription}>
</svelte:head>

{#if activeSlug === ''}
  <div class="briefings-page index-page">
    <header class="page-head">
      <div class="command-line"><span class="prompt">$</span> <span class="cmd">ls</span> <span class="arg">./briefings</span></div>
      <h1>BRIEFINGS<span class="cursor">_</span></h1>
      <p class="lede">Reports, research, and analysis from BooneTools.</p>
      <div class="rule"></div>
    </header>

    <section class="briefing-block" aria-labelledby="latest-briefings">
      <div class="block-head">
        <div class="block-title"><span class="marker">▌</span><h2 id="latest-briefings">latest</h2></div>
        <span class="block-meta">[1 entry]</span>
      </div>

      <a class="briefing-row" href={TRON_PATH} on:click={(event) => navigate(event, TRON_SLUG)}>
        <span class="row-index">01</span>
        <span class="row-copy">
          <strong>{briefing.title}</strong>
          <span>{briefing.description}</span>
        </span>
        <span class="row-meta">
          <span>{briefing.published}</span>
          <span>{briefing.readTime}</span>
        </span>
        <span class="row-arrow" aria-hidden="true">→</span>
      </a>
    </section>
  </div>
{:else if activeSlug === TRON_SLUG}
  <article class="briefings-page report-page">
    <nav class="breadcrumbs" aria-label="Breadcrumb">
      <a href={BRIEFINGS_ROOT} on:click={(event) => navigate(event)}>briefings</a>
      <span>/</span>
      <span>tron-performance-since-launch</span>
    </nav>

    <header class="report-head">
      <div class="head-top">
        <div class="command-line"><span class="prompt">$</span> <span class="cmd">read</span> <span class="arg">./briefings/{TRON_SLUG}.md</span></div>
        <span class="status"><span class="status-dot"></span> PUBLISHED</span>
      </div>
      <h1>TRON PERFORMANCE <span class="arrow">→</span> THORCHAIN<span class="cursor">_</span></h1>
      <p class="report-meta">{briefing.published} <span>│</span> {briefing.window} <span>│</span> {briefing.readTime}</p>
      <p class="lede">
        THORChain enabled native TRX and TRC-20 USDT swaps on October 1, 2025. Through July 18, 2026,
        the pools generated approximately <strong>$196.9 million in pool-level swap volume</strong> and
        <strong>$277,600 in liquidity fees</strong> across 1.86 million swap events. See the
        <a href="https://blog.thorchain.org/tron-integration-complete-native-trx-usdt-swaps-live-on-thorchain" target="_blank" rel="noreferrer">official launch announcement</a>.
      </p>
      <div class="rule"></div>
    </header>

    <section class="metric-grid" aria-label="Combined TRON performance summary">
      <div class="metric">
        <span class="metric-index">01</span>
        <strong>$196.90M</strong>
        <span>swap volume</span>
      </div>
      <div class="metric">
        <span class="metric-index">02</span>
        <strong>$277.60K</strong>
        <span>liquidity fees</span>
      </div>
      <div class="metric">
        <span class="metric-index">03</span>
        <strong>1.858M</strong>
        <span>swap events</span>
      </div>
      <div class="metric">
        <span class="metric-index">04</span>
        <strong>14.1 bps</strong>
        <span>fees ÷ volume</span>
      </div>
    </section>

    <section class="report-block" aria-labelledby="pool-summary">
      <div class="block-head">
        <div class="block-title"><span class="marker">▌</span><h2 id="pool-summary">pool summary</h2></div>
        <span class="block-meta">[{briefing.window}]</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>pool</th><th>swap volume</th><th>liquidity fees</th><th>swap events</th><th>fees ÷ volume</th></tr>
          </thead>
          <tbody>
            <tr><td>TRX</td><td>$39.73M</td><td>$63.21K</td><td>397.1K</td><td>15.9 bps</td></tr>
            <tr><td>USDT</td><td>$157.17M</td><td>$214.39K</td><td>1.461M</td><td>13.6 bps</td></tr>
            <tr class="total"><td>Combined</td><td>$196.90M</td><td>$277.60K</td><td>1.858M</td><td>14.1 bps</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="report-block" aria-labelledby="monthly-performance">
      <div class="block-head">
        <div class="block-title"><span class="marker">▌</span><h2 id="monthly-performance">monthly performance</h2></div>
        <span class="block-meta">[UTC]</span>
      </div>
      <figure>
        <figcaption>Swap volume</figcaption>
        <img src={`${ASSET_ROOT}/monthly-swap-volume.svg`} alt="Monthly TRX and USDT swap volume from October 2025 through July 18, 2026">
      </figure>
      <figure>
        <figcaption>Liquidity fees</figcaption>
        <img src={`${ASSET_ROOT}/monthly-liquidity-fees.svg`} alt="Monthly TRX and USDT liquidity fees from October 2025 through July 18, 2026">
      </figure>
    </section>

    <section class="report-block" aria-labelledby="key-findings">
      <div class="block-head">
        <div class="block-title"><span class="marker">▌</span><h2 id="key-findings">key findings</h2></div>
        <span class="block-meta">[5 observations]</span>
      </div>
      <ol class="findings">
        <li><span>01</span><p><strong>USDT is TRON's primary product on THORChain,</strong> contributing 79.8% of volume and 77.2% of fees.</p></li>
        <li><span>02</span><p><strong>TRON-USDT ranks ninth among all THORChain pools by fees earned since October 1.</strong> TRX ranks 15th with $63.2K.</p></li>
        <li><span>03</span><p>Combined monthly volume reached <strong>$49.0M in April</strong>. July 1–18 has already produced <strong>$40.5M of volume and $76.6K of fees</strong>.</p></li>
        <li><span>04</span><p>TRX generated slightly more fees per dollar, although February accounted for 48% of its cumulative fees, indicating a less consistent fee run rate.</p></li>
        <li><span>05</span><p>May and June are operationally distorted: THORChain halted following the May 15 exploit and restarted around June 22 after approximately five weeks offline. See the <a href="https://blog.thorchain.org/thorchain-quarterly-report-q2-2026" target="_blank" rel="noreferrer">THORChain Q2 report</a>.</p></li>
      </ol>
    </section>

    <section class="report-block" aria-labelledby="top-pools">
      <div class="block-head">
        <div class="block-title"><span class="marker">▌</span><h2 id="top-pools">top pools by fees earned</h2></div>
        <span class="block-meta">[top 10]</span>
      </div>
      <p class="block-lede">The ranking below uses the same October 1, 2025–July 18, 2026 window as the TRON analysis.</p>
      <figure>
        <img src={`${ASSET_ROOT}/top-pools-by-fees.svg`} alt="Top ten THORChain pools by liquidity fees earned since October 1, 2025">
      </figure>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>rank</th><th>pool</th><th>swap volume</th><th>liquidity fees</th><th>fees ÷ volume</th></tr>
          </thead>
          <tbody>
            <tr><td>1</td><td>BTC</td><td>$3.28B</td><td>$3.518M</td><td>10.72 bps</td></tr>
            <tr><td>2</td><td>ETH</td><td>$2.58B</td><td>$3.017M</td><td>11.68 bps</td></tr>
            <tr><td>3</td><td>Ethereum USDT</td><td>$757.41M</td><td>$866.76K</td><td>11.44 bps</td></tr>
            <tr><td>4</td><td>Ethereum USDC</td><td>$655.67M</td><td>$793.28K</td><td>12.10 bps</td></tr>
            <tr><td>5</td><td>BCH</td><td>$455.18M</td><td>$577.55K</td><td>12.69 bps</td></tr>
            <tr><td>6</td><td>LTC</td><td>$237.73M</td><td>$363.55K</td><td>15.29 bps</td></tr>
            <tr><td>7</td><td>Ethereum WBTC</td><td>$248.52M</td><td>$286.58K</td><td>11.53 bps</td></tr>
            <tr><td>8</td><td>AVAX</td><td>$165.32M</td><td>$256.90K</td><td>15.54 bps</td></tr>
            <tr class="highlight"><td>9</td><td>TRON USDT</td><td>$157.17M</td><td>$214.39K</td><td>13.64 bps</td></tr>
            <tr><td>10</td><td>XRP</td><td>$133.25M</td><td>$158.76K</td><td>11.91 bps</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="report-block methodology" aria-labelledby="methodology">
      <div class="block-head">
        <div class="block-title"><span class="marker">▌</span><h2 id="methodology">methodology</h2></div>
        <span class="block-meta">[Midgard daily histories]</span>
      </div>
      <p class="block-lede">
        The figures were calculated from Midgard's daily pool histories for
        <a href="https://gateway.liquify.com/chain/thorchain_midgard/v2/history/swaps?pool=TRON.TRX&interval=day&from=1759276800&to=1784419200" target="_blank" rel="noreferrer">TRX</a>,
        <a href="https://gateway.liquify.com/chain/thorchain_midgard/v2/history/swaps?pool=TRON.USDT-TR7NHQJEKQXGTCI8Q8ZY4PL8OTSZGJLJ6T&interval=day&from=1759276800&to=1784419200" target="_blank" rel="noreferrer">TRON-USDT</a>,
        and every pool in the <a href="https://gateway.liquify.com/chain/thorchain_midgard/v2/pools?period=365d" target="_blank" rel="noreferrer">Midgard pool universe</a>.
      </p>
      <ul>
        <li>Swap volume uses Midgard's USD value at the time of each swap.</li>
        <li>Liquidity fees are converted from RUNE using each daily interval's RUNE/USD price.</li>
        <li>Affiliate fees and chain gas costs are excluded.</li>
        <li>Combined TRX and USDT volume is pool turnover and may double-count swaps that traverse both TRON pools.</li>
      </ul>
    </section>

    <a class="back-link" href={BRIEFINGS_ROOT} on:click={(event) => navigate(event)}><span>[←]</span> all briefings</a>
  </article>
{:else}
  <div class="briefings-page not-found">
    <div class="command-line"><span class="prompt">$</span> <span class="cmd">read</span> <span class="arg">./briefings/{activeSlug}.md</span></div>
    <div class="not-found-message"><span>ERR</span> briefing not found</div>
    <a class="back-link" href={BRIEFINGS_ROOT} on:click={(event) => navigate(event)}><span>[←]</span> all briefings</a>
  </div>
{/if}

<style>
  .briefings-page {
    width: min(1080px, calc(100% - 48px));
    margin: 0 auto;
    padding: 28px 0 64px;
    color: #c8c8c8;
  }

  .index-page {
    max-width: 900px;
  }

  .page-head,
  .report-head {
    margin-bottom: 24px;
  }

  .command-line,
  .breadcrumbs,
  .report-meta,
  .status,
  .block-meta,
  .row-meta,
  .row-index,
  .row-arrow,
  .metric,
  table,
  figcaption,
  .findings > li > span,
  .back-link,
  .not-found-message {
    font-family: 'JetBrains Mono', monospace;
  }

  .command-line {
    font-size: 11px;
    font-weight: 600;
    color: #888;
  }

  .prompt,
  .arrow,
  .marker {
    color: #00cc66;
  }

  .prompt,
  .cmd {
    font-family: 'JetBrains Mono', monospace;
    font-weight: 700;
  }

  .cmd {
    color: #c8c8c8;
  }

  .arg {
    font-family: 'JetBrains Mono', monospace;
    color: #666;
  }

  h1 {
    margin: 14px 0 10px;
    color: #e8e8e8;
    font-family: 'JetBrains Mono', monospace;
    font-size: clamp(23px, 4vw, 30px);
    font-weight: 800;
    line-height: 1.15;
    letter-spacing: 0.06em;
  }

  .cursor {
    font-family: 'JetBrains Mono', monospace;
    color: #00cc66;
    animation: cursor-blink 1s steps(1) infinite;
  }

  @keyframes cursor-blink {
    0%, 49% { opacity: 1; }
    50%, 100% { opacity: 0; }
  }

  .lede {
    max-width: 800px;
    margin: 0;
    color: #888;
    font-size: 13px;
    line-height: 1.65;
  }

  .report-head .lede {
    color: #aaa;
    font-size: 14px;
  }

  .lede strong,
  .findings strong {
    color: #e8e8e8;
    font-weight: 600;
  }

  a {
    color: #00cc66;
    text-decoration-color: rgba(0, 204, 102, 0.45);
    text-underline-offset: 3px;
  }

  a:hover {
    color: #fff;
    text-decoration-color: #00cc66;
  }

  .rule {
    height: 1px;
    margin-top: 20px;
    background: linear-gradient(90deg, #00cc66 0%, #1a1a1a 14%, #1a1a1a 100%);
  }

  .briefing-block,
  .report-block {
    margin-top: 18px;
    border: 1px solid #1a1a1a;
    background: #0a0a0a;
  }

  .briefing-block,
  .report-block {
    padding: 20px;
  }

  .block-head,
  .head-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }

  .block-title {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .block-title h2 {
    margin: 0;
    color: #e8e8e8;
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    font-weight: 700;
    line-height: 1.2;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .marker {
    font-family: 'JetBrains Mono', monospace;
  }

  .block-meta {
    color: #444;
    font-size: 9px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .briefing-row {
    display: grid;
    grid-template-columns: 34px minmax(0, 1fr) auto 18px;
    align-items: center;
    gap: 16px;
    margin: 18px -20px -20px;
    padding: 18px 20px;
    border-top: 1px solid #1a1a1a;
    color: inherit;
    text-decoration: none;
    transition: background 0.15s ease;
  }

  .briefing-row:hover {
    background: #0d0d0d;
    color: inherit;
  }

  .row-index {
    color: #00cc66;
    font-size: 10px;
    font-weight: 700;
  }

  .row-copy {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .row-copy strong {
    color: #e8e8e8;
    font-family: 'JetBrains Mono', monospace;
    font-size: 14px;
    letter-spacing: 0.02em;
  }

  .row-copy > span {
    color: #666;
    font-size: 12px;
    line-height: 1.5;
  }

  .row-meta {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 5px;
    color: #555;
    font-size: 9px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .row-arrow {
    color: #444;
    transition: color 0.15s ease;
  }

  .briefing-row:hover .row-arrow {
    color: #00cc66;
  }

  .breadcrumbs {
    display: flex;
    gap: 8px;
    margin-bottom: 20px;
    color: #444;
    font-size: 10px;
  }

  .breadcrumbs a {
    color: #666;
  }

  .breadcrumbs span:last-child {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .status {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 3px 8px;
    border: 1px solid #1a1a1a;
    border-radius: 999px;
    color: #666;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.1em;
  }

  .status-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: #00cc66;
    box-shadow: 0 0 6px rgba(0, 204, 102, 0.4);
  }

  .report-meta {
    margin: 0 0 16px;
    color: #555;
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .report-meta span {
    margin: 0 6px;
    color: #2a2a2a;
  }

  .metric-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    border: 1px solid #1a1a1a;
    background: #0a0a0a;
  }

  .metric {
    position: relative;
    min-width: 0;
    padding: 18px;
    border-right: 1px solid #1a1a1a;
  }

  .metric:last-child {
    border-right: 0;
  }

  .metric-index {
    display: block;
    margin-bottom: 12px;
    color: #00cc66;
    font-size: 9px;
    font-weight: 700;
  }

  .metric strong {
    display: block;
    overflow: hidden;
    color: #e8e8e8;
    font-size: clamp(17px, 2vw, 23px);
    font-weight: 800;
    line-height: 1.1;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .metric > span:last-child {
    display: block;
    margin-top: 8px;
    color: #555;
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .report-block {
    margin-top: 20px;
  }

  .block-lede {
    margin: 14px 0 0;
    color: #888;
    font-size: 12px;
    line-height: 1.6;
  }

  .table-wrap {
    margin: 16px -20px -20px;
    overflow-x: auto;
  }

  table {
    width: 100%;
    min-width: 660px;
    border-collapse: collapse;
    color: #888;
    font-size: 11px;
  }

  th,
  td {
    padding: 11px 14px;
    border-bottom: 1px solid #111;
    text-align: right;
    white-space: nowrap;
  }

  th:first-child,
  td:first-child,
  th:nth-child(2),
  td:nth-child(2) {
    text-align: left;
  }

  th {
    color: #555;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  tbody tr:last-child td {
    border-bottom: 0;
  }

  tbody tr:hover {
    background: #0d0d0d;
  }

  tbody td:nth-last-child(2) {
    color: #00cc66;
    font-weight: 600;
  }

  tbody tr.total td,
  tbody tr.highlight td {
    color: #e8e8e8;
    font-weight: 700;
  }

  tbody tr.highlight {
    border-left: 2px solid #00cc66;
    background: rgba(0, 204, 102, 0.04);
  }

  figure {
    margin: 18px 0 0;
    border: 1px solid #151515;
    background: #080808;
  }

  figcaption {
    padding: 10px 12px;
    border-bottom: 1px solid #151515;
    color: #666;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  figure img {
    display: block;
    width: 100%;
    height: auto;
  }

  .findings {
    margin: 16px 0 -4px;
    padding: 0;
    list-style: none;
  }

  .findings li {
    display: grid;
    grid-template-columns: 32px 1fr;
    gap: 10px;
    padding: 11px 0;
    border-top: 1px dashed #1a1a1a;
  }

  .findings > li > span {
    color: #00cc66;
    font-size: 9px;
    font-weight: 700;
  }

  .findings p {
    margin: 0;
    color: #aaa;
    font-size: 13px;
    line-height: 1.6;
  }

  .methodology ul {
    margin: 14px 0 0;
    padding-left: 20px;
    color: #888;
    font-size: 12px;
    line-height: 1.65;
  }

  .methodology li + li {
    margin-top: 5px;
  }

  .methodology li::marker {
    color: #00cc66;
  }

  .back-link {
    display: inline-block;
    margin-top: 24px;
    color: #888;
    font-size: 10px;
    font-weight: 600;
    text-decoration: none;
  }

  .back-link span {
    color: #00cc66;
  }

  .not-found {
    max-width: 700px;
    padding-top: 48px;
  }

  .not-found-message {
    margin-top: 18px;
    padding: 16px;
    border: 1px solid rgba(220, 53, 69, 0.4);
    background: rgba(220, 53, 69, 0.06);
    color: #888;
    font-size: 12px;
  }

  .not-found-message span {
    margin-right: 10px;
    color: #dc3545;
    font-weight: 700;
  }

  /* Reports prioritize long-form readability over the shell's dim data density. */
  .report-page,
  .report-page .command-line,
  .report-page .arg,
  .report-page .breadcrumbs,
  .report-page .breadcrumbs a,
  .report-page .status,
  .report-page .report-meta,
  .report-page .report-meta span,
  .report-page .block-title h2,
  .report-page .block-meta,
  .report-page .metric strong,
  .report-page .metric > span:last-child,
  .report-page .block-lede,
  .report-page table,
  .report-page th,
  .report-page tbody tr.total td,
  .report-page tbody tr.highlight td,
  .report-page figcaption,
  .report-page .findings p,
  .report-page .methodology ul,
  .report-page .back-link,
  .report-page .lede,
  .report-page .lede strong,
  .report-page .findings strong {
    color: #e3e3e3;
  }

  .report-page h1 {
    color: #f3f3f3;
    font-size: clamp(28px, 4vw, 36px);
    line-height: 1.2;
  }

  .report-page .block-title h2,
  .report-page .metric strong,
  .report-page .lede strong,
  .report-page .findings strong,
  .report-page tbody tr.total td,
  .report-page tbody tr.highlight td {
    color: #f0f0f0;
  }

  .report-page .breadcrumbs,
  .report-page .breadcrumbs a,
  .report-page .status,
  .report-page .report-meta,
  .report-page .report-meta span,
  .report-page .block-meta,
  .report-page .metric > span:last-child,
  .report-page th,
  .report-page figcaption {
    color: #d2d2d2;
  }

  .report-page .command-line {
    font-size: 13px;
  }

  .report-page .breadcrumbs {
    font-size: 12px;
  }

  .report-page .status,
  .report-page .report-meta,
  .report-page .block-meta {
    font-size: 11px;
  }

  .report-page .report-meta {
    line-height: 1.7;
  }

  .report-page .lede {
    max-width: 920px;
    font-size: 17px;
    line-height: 1.75;
  }

  .report-page .block-title h2 {
    font-size: 15px;
  }

  .report-page .metric-index,
  .report-page .metric > span:last-child {
    font-size: 11px;
  }

  .report-page .metric strong {
    font-size: clamp(21px, 2.2vw, 27px);
  }

  .report-page .block-lede,
  .report-page .methodology ul {
    font-size: 15px;
    line-height: 1.75;
  }

  .report-page table {
    font-size: 14px;
  }

  .report-page th {
    font-size: 11px;
  }

  .report-page th,
  .report-page td {
    padding-top: 14px;
    padding-bottom: 14px;
  }

  .report-page figcaption {
    font-size: 12px;
  }

  .report-page figure {
    overflow-x: auto;
  }

  .report-page figure img {
    min-width: 760px;
  }

  .report-page .findings p {
    font-size: 16px;
    line-height: 1.75;
  }

  .report-page .back-link {
    font-size: 13px;
  }

  @media (max-width: 760px) {
    .briefings-page {
      width: min(100% - 28px, 1080px);
      padding-top: 22px;
    }

    .briefing-row {
      grid-template-columns: 26px minmax(0, 1fr) 14px;
      gap: 10px;
    }

    .row-meta {
      display: none;
    }

    .metric-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .metric:nth-child(2) {
      border-right: 0;
    }

    .metric:nth-child(-n + 2) {
      border-bottom: 1px solid #1a1a1a;
    }

    .report-block,
    .briefing-block {
      padding: 16px;
    }

    .table-wrap {
      margin: 16px -16px -16px;
    }

    .block-head,
    .head-top {
      align-items: flex-start;
    }

    .block-meta,
    .status {
      flex-shrink: 0;
    }
  }

  @media (max-width: 480px) {
    .head-top .status {
      display: none;
    }

    .report-meta {
      line-height: 1.7;
    }

    .block-meta {
      display: none;
    }

    .metric {
      padding: 14px;
    }

    .metric strong {
      font-size: 17px;
    }

    .report-page .lede {
      font-size: 16px;
    }

    .report-page .metric strong {
      font-size: 20px;
    }
  }
</style>
