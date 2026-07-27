<script>
  const BASE_PATH = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
  const BRIEFINGS_ROOT = `${BASE_PATH}/briefings`;
  const TRON_SLUG = 'tron-performance-since-launch';
  const SS_SLUG = 'ss-dynamic-fee-impact';
  const ASSET_ROOT = `${BASE_PATH}/assets/briefings/${TRON_SLUG}`;
  const SS_ASSET_ROOT = `${BASE_PATH}/assets/briefings/${SS_SLUG}`;

  const briefing = {
    slug: TRON_SLUG,
    title: 'TRON performance on THORChain',
    description: 'Native TRX and TRON-USDT pool volume, liquidity fees, usage, and rankings since launch.',
    published: 'July 18, 2026',
    window: 'Oct 1, 2025 → Jul 18, 2026',
    readTime: '5 min read'
  };

  const ssBriefing = {
    slug: SS_SLUG,
    title: 'SS dynamic-fee impact',
    description: 'ShapeShift affiliate volume, liquidity fees, fee yield, and rolling trends before and after ADR-026 activation.',
    published: 'July 27, 2026',
    window: 'Jan 27, 2026 → Jul 26, 2026',
    readTime: '10 min read'
  };

  const briefings = [ssBriefing, briefing];

  function briefingPath(slug) {
    return `${BRIEFINGS_ROOT}/${slug}`;
  }

  function briefingNumber(index) {
    return String(briefings.length - index).padStart(2, '0');
  }

  function getActiveSlug() {
    const pathname = BASE_PATH && window.location.pathname.startsWith(BASE_PATH)
      ? window.location.pathname.slice(BASE_PATH.length)
      : window.location.pathname;
    const segments = pathname.replace(/^\/+|\/+$/g, '').split('/');
    return segments[0] === 'briefings' ? segments.slice(1).join('/') : '';
  }

  let activeSlug = getActiveSlug();
  $: activeBriefing = briefings.find((entry) => entry.slug === activeSlug) || null;

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
        page_title: briefings.find((entry) => entry.slug === slug)?.title || 'Briefings',
        page_path: nextPath,
        page_location: window.location.href
      });
    }

    requestAnimationFrame(() => {
      document.querySelector('.content')?.scrollTo({ top: 0, behavior: 'auto' });
    });
  }

  $: pageTitle = activeBriefing
    ? `${activeBriefing.title} - BOONE Tools`
    : activeSlug
      ? 'Briefing not found - BOONE Tools'
      : 'Briefings - BOONE Tools';
  $: pageDescription = activeBriefing
    ? activeBriefing.description
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
        <span class="block-meta">[{briefings.length} entries]</span>
      </div>

      <div class="briefing-list">
        {#each briefings as item, index (item.slug)}
          <a class="briefing-row" href={briefingPath(item.slug)} on:click={(event) => navigate(event, item.slug)}>
            <span class="row-index">{briefingNumber(index)}</span>
            <span class="row-copy">
              <strong>{item.title}</strong>
              <span>{item.description}</span>
            </span>
            <span class="row-meta">
              <span>{item.published}</span>
              <span>{item.readTime}</span>
            </span>
            <span class="row-arrow" aria-hidden="true">→</span>
          </a>
        {/each}
      </div>
    </section>
  </div>
{:else if activeSlug === SS_SLUG}
  <article class="briefings-page report-page">
    <nav class="breadcrumbs" aria-label="Breadcrumb">
      <a href={BRIEFINGS_ROOT} on:click={(event) => navigate(event)}>briefings</a>
      <span>/</span>
      <span>{SS_SLUG}</span>
    </nav>

    <header class="report-head">
      <div class="head-top">
        <div class="command-line"><span class="prompt">$</span> <span class="cmd">read</span> <span class="arg">./briefings/{SS_SLUG}.md</span></div>
        <span class="status"><span class="status-dot"></span> PUBLISHED</span>
      </div>
      <h1>SS DYNAMIC FEES <span class="arrow">→</span> IMPACT<span class="cursor">_</span></h1>
      <p class="report-meta">{ssBriefing.published} <span>│</span> {ssBriefing.window} <span>│</span> {ssBriefing.readTime}</p>
      <p class="lede">
        The first 23 complete days after SS entered the ADR-026 dynamic-fee program show a large reduction in
        THORChain liquidity fees per dollar of ShapeShift volume. After the requested curation, volume has not
        increased enough to offset that reduction. See the
        <a href="https://dev.thorchain.org/architecture/adr-026-dynamic-l1-min-fee-per-thorname.html" target="_blank" rel="noreferrer">ADR-026 specification</a>
        and the <a href="https://blog.thorchain.org/adr026-dynamic-fee-model" target="_blank" rel="noreferrer">official explainer</a>.
      </p>
      <div class="rule"></div>
    </header>

    <section class="metric-grid" aria-label="Curated equal-window impact summary">
      <div class="metric">
        <span class="metric-index">01</span>
        <strong>-53.3%</strong>
        <span>curated volume</span>
      </div>
      <div class="metric">
        <span class="metric-index">02</span>
        <strong>-84.1%</strong>
        <span>curated fees</span>
      </div>
      <div class="metric">
        <span class="metric-index">03</span>
        <strong>-65.9%</strong>
        <span>curated fee yield</span>
      </div>
      <div class="metric">
        <span class="metric-index">04</span>
        <strong>23 days</strong>
        <span>complete post window</span>
      </div>
    </section>

    <section class="report-block" aria-labelledby="ss-equal-window">
      <div class="block-head">
        <div class="block-title"><span class="marker">▌</span><h2 id="ss-equal-window">equal-window impact</h2></div>
        <span class="block-meta">[23 eligible days pre / post]</span>
      </div>
      <p class="block-lede">July 3 is omitted as the activation and cold-start day. The pre period is the last 23 eligible days before activation; the post period is July 4–26.</p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>view</th><th>metric</th><th>pre</th><th>post</th><th>change</th></tr>
          </thead>
          <tbody>
            <tr><td>Uncurated</td><td>Executed-leg volume</td><td>$897,444</td><td>$1,406,662</td><td>+56.7%</td></tr>
            <tr><td>Uncurated</td><td>Liquidity fees</td><td>$873.20</td><td>$643.22</td><td>-26.3%</td></tr>
            <tr><td>Uncurated</td><td>Fees / volume</td><td>9.730 bps</td><td>4.573 bps</td><td>-53.0%</td></tr>
            <tr class="highlight"><td>Curated</td><td>Executed-leg volume</td><td>$897,444</td><td>$419,085</td><td>-53.3%</td></tr>
            <tr class="highlight"><td>Curated</td><td>Liquidity fees</td><td>$873.20</td><td>$138.85</td><td>-84.1%</td></tr>
            <tr class="highlight"><td>Curated</td><td>Fees / volume</td><td>9.730 bps</td><td>3.313 bps</td><td>-65.9%</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="report-block" aria-labelledby="ss-uncurated-trends">
      <div class="block-head">
        <div class="block-title"><span class="marker">▌</span><h2 id="ss-uncurated-trends">uncurated affiliate trends</h2></div>
        <span class="block-meta">[all indexed SS flow]</span>
      </div>
      <p class="block-lede">Green bars show executed-leg volume, amber bars show historical USD liquidity fees, blue shows fees / volume, cyan is the trailing 30-day average volume, and dashed purple is the trailing 90-day average.</p>
      <figure>
        <figcaption>Uncurated // six months // 30D + 90D</figcaption>
        <img src={`${SS_ASSET_ROOT}/affiliate-trend-uncurated-6m.svg`} alt="Uncurated six-month SS volume, fees, fee yield, and trailing 30-day and 90-day average volume">
      </figure>
      <figure>
        <figcaption>Uncurated // one month // 30D + 90D</figcaption>
        <img src={`${SS_ASSET_ROOT}/affiliate-trend-uncurated-1m.svg`} alt="Uncurated one-month SS volume, fees, fee yield, and trailing 30-day and 90-day average volume">
      </figure>
    </section>

    <section class="report-block" aria-labelledby="ss-curation">
      <div class="block-head">
        <div class="block-title"><span class="marker">▌</span><h2 id="ss-curation">curation applied</h2></div>
        <span class="block-meta">[37 days + 2 addresses]</span>
      </div>
      <p class="block-lede">
        Full halt days are removed from eligible-day and rolling-average denominators. The whole action is removed
        when the inbound sender matches either requested address. Address labels are requester-supplied assumptions;
        the analysis verifies the indexed actions and sensitivity to removal, not provenance.
      </p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>exclusion</th><th>dates</th><th>routes</th><th>volume removed</th><th>fees removed</th></tr>
          </thead>
          <tbody>
            <tr><td>Full network halt</td><td>May 16–Jun 21</td><td>0</td><td>$0</td><td>$0</td></tr>
            <tr><td><code>0xa6d623…bdaa</code> · hacked funds</td><td>Apr 24</td><td>16</td><td>$60,964,148</td><td>$60,736.66</td></tr>
            <tr><td><code>thor1wqg9…s780</code> · TC OG selling</td><td>Jul 6–7</td><td>3</td><td>$987,578</td><td>$504.37</td></tr>
            <tr class="total"><td>Union</td><td>—</td><td>19</td><td>$61,951,726</td><td>$61,241.04</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="report-block" aria-labelledby="ss-curated-trends">
      <div class="block-head">
        <div class="block-title"><span class="marker">▌</span><h2 id="ss-curated-trends">curated affiliate trends</h2></div>
        <span class="block-meta">[halt + address exclusions]</span>
      </div>
      <p class="block-lede">The chart keeps the halt span on the calendar axis but omits those full days from curated calculations. Rolling averages use fixed 30- and 90-calendar-day spans and do not reach farther back for additional active observations.</p>
      <figure>
        <figcaption>Curated // six months // 30D + 90D</figcaption>
        <img src={`${SS_ASSET_ROOT}/affiliate-trend-curated-6m.svg`} alt="Curated six-month SS volume, fees, fee yield, and trailing 30-day and 90-day average volume">
      </figure>
      <figure>
        <figcaption>Curated // one month // 30D + 90D</figcaption>
        <img src={`${SS_ASSET_ROOT}/affiliate-trend-curated-1m.svg`} alt="Curated one-month SS volume, fees, fee yield, and trailing 30-day and 90-day average volume">
      </figure>
    </section>

    <section class="report-block" aria-labelledby="ss-monthly">
      <div class="block-head">
        <div class="block-title"><span class="marker">▌</span><h2 id="ss-monthly">monthly observations</h2></div>
        <span class="block-meta">[Jan 27–Jul 26 UTC]</span>
      </div>
      <p class="block-lede">January and July are partial months. May and June include the network-halt period; curated eligible-day counts are 15 and 9 respectively.</p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>month</th><th>raw volume</th><th>raw fees</th><th>raw yield</th><th>curated volume</th><th>curated fees</th><th>curated yield</th></tr>
          </thead>
          <tbody>
            <tr><td>2026-01*</td><td>$710,406</td><td>$719.41</td><td>10.127 bps</td><td>$710,406</td><td>$719.41</td><td>10.127 bps</td></tr>
            <tr><td>2026-02</td><td>$1,207,836</td><td>$1,178.58</td><td>9.758 bps</td><td>$1,207,836</td><td>$1,178.58</td><td>9.758 bps</td></tr>
            <tr><td>2026-03</td><td>$568,246</td><td>$578.87</td><td>10.187 bps</td><td>$568,246</td><td>$578.87</td><td>10.187 bps</td></tr>
            <tr><td>2026-04</td><td>$73,278,715</td><td>$73,567.99</td><td>10.039 bps</td><td>$12,314,567</td><td>$12,831.32</td><td>10.420 bps</td></tr>
            <tr><td>2026-05</td><td>$237,645</td><td>$255.26</td><td>10.741 bps</td><td>$237,645</td><td>$255.26</td><td>10.741 bps</td></tr>
            <tr><td>2026-06</td><td>$695,119</td><td>$652.98</td><td>9.394 bps</td><td>$695,119</td><td>$652.98</td><td>9.394 bps</td></tr>
            <tr><td>2026-07*</td><td>$1,413,795</td><td>$650.19</td><td>4.599 bps</td><td>$426,218</td><td>$145.82</td><td>3.421 bps</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="report-block" aria-labelledby="ss-findings">
      <div class="block-head">
        <div class="block-title"><span class="marker">▌</span><h2 id="ss-findings">key findings</h2></div>
        <span class="block-meta">[5 observations]</span>
      </div>
      <ol class="findings">
        <li><span>01</span><p><strong>The apparent uncurated volume gain is not robust.</strong> Three July 6–7 TC OG selling routes contributed $987,578, or 70.2% of raw post-window volume.</p></li>
        <li><span>02</span><p><strong>Fee generation fell much faster than curated volume.</strong> In equal windows, volume declined 53.3%, fees declined 84.1%, and fee yield declined 65.9%.</p></li>
        <li><span>03</span><p><strong>Endpoint-route mix does not explain away the compression.</strong> Across 11 matched routes, observed post fees were $88.33 versus $278.35 at each route's pre-period yield, a 68.3% shortfall.</p></li>
        <li><span>04</span><p><strong>The July 23 rolling-average cliff is an expiry artifact.</strong> The April 24 hacked-address burst leaves the 90-day lookback on that date; it is not a delayed ADR-026 response.</p></li>
        <li><span>05</span><p><strong>The evidence is associative, not causal.</strong> The post sample is short, follows a five-week halt, and does not control swap size, streaming quantity, natural slip, cold starts, or route mix.</p></li>
      </ol>
    </section>

    <section class="report-block methodology" aria-labelledby="ss-methodology">
      <div class="block-head">
        <div class="block-title"><span class="marker">▌</span><h2 id="ss-methodology">methodology</h2></div>
        <span class="block-meta">[Midgard actions + historical RUNE/USD]</span>
      </div>
      <p class="block-lede">
        The analysis paginates successful <a href="https://gateway.liquify.com/chain/thorchain_midgard/v2/actions?type=swap&affiliate=ss&limit=50&fromTimestamp=1761696000&timestamp=1785110400" target="_blank" rel="noreferrer">Midgard SS swap actions</a>,
        joins the <a href="https://gateway.liquify.com/chain/thorchain_midgard/v2/history/rune?interval=day&from=1761696000&to=1785110400" target="_blank" rel="noreferrer">historical RUNE/USD series</a>,
        and uses BooneTools' <a href="https://boone.tools/functions/v1/node-votes/vote?key=DYNAMICFEE-WHITELIST-SS" target="_blank" rel="noreferrer">on-chain Mimir vote history</a>
        for the July 3 01:43 UTC activation cutoff.
      </p>
      <ul>
        <li>Volume is executed-leg USD: route input notional is counted once per distinct executed pool leg.</li>
        <li>Fees are whole-route THORChain liquidity fees in RUNE converted with that UTC day's historical RUNE/USD price.</li>
        <li>Fees / volume is aggregate historical fee USD divided by aggregate executed-leg USD; daily or swap ratios are not averaged.</li>
        <li>Streaming routes are assigned to their inbound action timestamp, so the daily series is an action-level approximation rather than a sub-swap replay.</li>
        <li>Removing the TC OG selling observations cannot undo their effect on the subsequent on-chain ETH.USDC controller state.</li>
      </ul>
    </section>

    <section class="report-block" aria-labelledby="ss-bottom-line">
      <div class="block-head">
        <div class="block-title"><span class="marker">▌</span><h2 id="ss-bottom-line">bottom line</h2></div>
        <span class="block-meta">[as of Jul 26]</span>
      </div>
      <p class="block-lede">
        SS flow is paying substantially less protocol liquidity fee per dollar after ADR-026, but the first 23 complete
        days show no evidence that curated volume increased enough to compensate. The current read is directionally
        negative for fee generation, inconclusive-to-negative for volume, and too early for a causal verdict. The next
        useful checkpoint is one full 90-day post-activation window using the same exclusions.
      </p>
    </section>

    <a class="back-link" href={BRIEFINGS_ROOT} on:click={(event) => navigate(event)}><span>[←]</span> all briefings</a>
  </article>
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

  .briefing-list {
    margin: 18px -20px -20px;
  }

  .briefing-row {
    display: grid;
    grid-template-columns: 34px minmax(0, 1fr) auto 18px;
    align-items: center;
    gap: 16px;
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

  .report-page code {
    padding: 1px 5px;
    border: 1px solid #1a1a1a;
    background: #111;
    color: #00cc66;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.9em;
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
