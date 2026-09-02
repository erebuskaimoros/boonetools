<script>
  export let briefing;
  export let briefingsRoot;
  export let navigate;

  const SOURCE_URL = 'https://x.com/BooneW/status/2094724612860813417';
  const TRACKER_URL = 'https://boone.tools/pol-tracker';
</script>

<article class="briefings-page report-page">
  <nav class="breadcrumbs" aria-label="Breadcrumb">
    <a href={briefingsRoot} on:click={(event) => navigate(event)}>briefings</a>
    <span>/</span>
    <span>{briefing.slug}</span>
  </nav>

  <header class="report-head">
    <div class="head-top">
      <div class="command-line"><span class="prompt">$</span> <span class="cmd">read</span> <span class="arg">./briefings/{briefing.slug}.md</span></div>
      <span class="status"><span class="status-dot"></span> PUBLISHED</span>
    </div>

    <p class="eyebrow">THE NEW LIQUIDITY BLACK HOLE</p>
    <h1>THORCHAIN'S NEW <span class="accent">POL</span><span class="cursor">_</span></h1>
    <p class="report-meta">{briefing.published} <span>│</span> {briefing.window} <span>│</span> {briefing.readTime}</p>
    <p class="lede">
      THORChain can now turn a node-voted share of system income into liquidity the protocol owns forever:
      permanent pool depth that earns fees, improves swap execution, and compounds into more revenue and more liquidity.
    </p>
    <div class="rule"></div>
  </header>

  <section class="signal-grid" aria-label="System Income POL summary">
    <div class="signal">
      <span class="signal-index">01</span>
      <strong>~20%</strong>
      <span>current allocation</span>
      <small>subject to node votes</small>
    </div>
    <div class="signal">
      <span class="signal-index">02</span>
      <strong>3 days</strong>
      <span>selection window</span>
      <small>fees earned ÷ pool depth</small>
    </div>
    <div class="signal">
      <span class="signal-index">03</span>
      <strong>1:1</strong>
      <span>RUNE : asset</span>
      <small>rebalanced by arbitrage</small>
    </div>
  </section>

  <section class="report-block" aria-labelledby="background">
    <div class="block-head">
      <div class="block-title"><span class="marker">▌</span><h2 id="background">background</h2></div>
      <span class="block-meta">[own instead of rent]</span>
    </div>
    <div class="prose">
      <p>
        Since the ThorFi collapse, Base Layer liquidity providers have received little in rewards. With less incentive
        to deposit third-party capital, pool growth stalled. That matters because deeper Base Layer pools improve swap
        execution and make it easier for THORChain to support new pools and routes.
      </p>
      <p>
        The traditional answer is to pay users yield in exchange for their deposits—to rent liquidity. System Income
        Protocol Owned Liquidity changes the question: what if the protocol used that same income to build capital it
        owns in common and never has to return?
      </p>
    </div>
  </section>

  <section class="report-block" aria-labelledby="how-it-works">
    <div class="block-head">
      <div class="block-title"><span class="marker">▌</span><h2 id="how-it-works">how it works</h2></div>
      <span class="block-meta">[continuous allocation]</span>
    </div>

    <div class="flow" aria-label="System income to protocol owned liquidity flow">
      <div class="flow-node"><span>01</span><strong>System income</strong><small>primarily swap fees</small></div>
      <span class="flow-arrow" aria-hidden="true">→</span>
      <div class="flow-node"><span>02</span><strong>POL share</strong><small>set by node votes</small></div>
      <span class="flow-arrow" aria-hidden="true">→</span>
      <div class="flow-node active"><span>03</span><strong>Selected pool</strong><small>best fees ÷ depth</small></div>
      <span class="flow-arrow" aria-hidden="true">→</span>
      <div class="flow-node"><span>04</span><strong>Owned depth</strong><small>RUNE + external asset</small></div>
    </div>

    <ol class="steps">
      <li><span>01</span><p>Every block, the voted POL share of system income is deposited into one eligible pool.</p></li>
      <li><span>02</span><p>The pool is chosen by the fees it earned relative to its depth over the preceding three-day window.</p></li>
      <li><span>03</span><p>Eligibility is limited to L1 gas-asset pools and certain stablecoin pools without synth exposure.</p></li>
      <li><span>04</span><p>POL enters as RUNE; arbitrage activity rebalances the pool toward equal RUNE and external-asset value.</p></li>
      <li><span>05</span><p>A new snapshot is taken every three days, and the allocation can rotate to a different pool.</p></li>
    </ol>

    <div class="notice"><span>INF</span><p>The approximately 20% allocation described here is a current consensus setting, not a fixed protocol constant.</p></div>
  </section>

  <section class="report-block" aria-labelledby="why-it-matters">
    <div class="block-head">
      <div class="block-title"><span class="marker">▌</span><h2 id="why-it-matters">why it benefits the protocol</h2></div>
      <span class="block-meta">[6 effects]</span>
    </div>

    <div class="benefit-grid">
      <article>
        <span>01 / ASSET</span>
        <h3>Owned, not owed</h3>
        <p>Third-party LP capital is a liability to depositors. POL belongs to the protocol, so a future exploit would not create the same obligation to make an outside LP whole.</p>
      </article>
      <article>
        <span>02 / PRODUCTIVE</span>
        <h3>Capital that earns</h3>
        <p>The liquidity earns a share of pool fees. At publication, the capital deposited into the TRON.USDT pool was earning at an annualized rate of roughly 164%.</p>
      </article>
      <article>
        <span>03 / PERMANENT</span>
        <h3>Reliable pool depth</h3>
        <p>Unlike rented liquidity, POL cannot be withdrawn by a third party. THORChain can plan around durable, permissionless liquidity for cross-chain swaps.</p>
      </article>
      <article>
        <span>04 / RUNE</span>
        <h3>A quasi-burn</h3>
        <p>Roughly half the pool position is RUNE that is locked into permanent liquidity rather than held for discretionary sale, subject to the movement imposed by <code>x·y=k</code> pool math.</p>
      </article>
      <article>
        <span>05 / TREASURY</span>
        <h3>Blue-chip accumulation</h3>
        <p>The other half is held in the external assets most demanded by swappers. Over time, POL can become a yield-bearing, crypto-native treasury.</p>
      </article>
      <article>
        <span>06 / EXECUTION</span>
        <h3>A compounding flywheel</h3>
        <p>Deeper pools improve execution, which can attract more volume and revenue. A portion of that revenue returns to POL and adds still more depth.</p>
      </article>
    </div>
  </section>

  <section class="report-block" aria-labelledby="flywheel">
    <div class="block-head">
      <div class="block-title"><span class="marker">▌</span><h2 id="flywheel">the flywheel</h2></div>
      <span class="block-meta">[compounding]</span>
    </div>
    <div class="flywheel" aria-label="Protocol owned liquidity compounding loop">
      <span>deeper pools</span><b>→</b><span>better execution</span><b>→</b><span>more volume</span><b>→</b><span>more income</span><b>→</b><span>more POL</span>
    </div>
    <div class="prose">
      <p>
        This loop can help THORChain open new pools without continually drawing down the Treasury. As the protocol-owned
        position grows, it could also give the Treasury room to withdraw legacy capital for other uses while the POL
        position continues serving swaps and earning fees.
      </p>
    </div>
  </section>

  <section class="source-block" aria-labelledby="follow-progress">
    <div>
      <span class="source-label">LIVE MONITOR</span>
      <h2 id="follow-progress">Follow System Income POL</h2>
      <p>Track the allocation, pool positions, fee yield, asset inventory, and compounding progress on BooneTools.</p>
    </div>
    <a class="tracker-link" href={TRACKER_URL}>[→] open POL tracker</a>
  </section>

  <p class="source-note">
    Adapted from the <a href={SOURCE_URL} target="_blank" rel="noreferrer">original X article</a>. Figures and protocol settings are point-in-time observations as of publication.
  </p>

  <a class="back-link" href={briefingsRoot} on:click={(event) => navigate(event)}><span>[←]</span> all briefings</a>
</article>

<style>
  .briefings-page {
    width: min(1080px, calc(100% - 48px));
    margin: 0 auto;
    padding: 28px 0 64px;
    color: var(--term-text-body, #e8e8e8);
  }

  .breadcrumbs,
  .command-line,
  .status,
  .eyebrow,
  .report-meta,
  .block-meta,
  .signal,
  .flow,
  .steps > li > span,
  .benefit-grid article > span,
  .notice,
  .flywheel,
  .source-label,
  .tracker-link,
  .source-note,
  .back-link {
    font-family: 'JetBrains Mono', monospace;
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

  .breadcrumbs {
    display: flex;
    gap: 8px;
    margin-bottom: 20px;
    color: var(--term-text-5, #a0a0a0);
    font-size: 12px;
  }

  .breadcrumbs a {
    color: var(--term-text-3, #c8c8c8);
  }

  .breadcrumbs span:last-child {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .report-head {
    margin-bottom: 24px;
  }

  .head-top,
  .block-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }

  .command-line {
    color: var(--term-text-body, #e8e8e8);
    font-size: 13px;
    font-weight: 600;
  }

  .prompt,
  .accent,
  .marker {
    color: #00cc66;
  }

  .prompt,
  .cmd {
    font-weight: 700;
  }

  .arg {
    color: var(--term-text-3, #c8c8c8);
  }

  .status {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 3px 8px;
    border: 1px solid #1a1a1a;
    border-radius: 999px;
    color: var(--term-text-body, #e8e8e8);
    font-size: 11px;
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

  .eyebrow {
    margin: 28px 0 0;
    color: #d4a017;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.16em;
  }

  h1 {
    margin: 9px 0 10px;
    color: #f3f3f3;
    font-family: 'JetBrains Mono', monospace;
    font-size: clamp(28px, 4vw, 36px);
    font-weight: 800;
    line-height: 1.2;
    letter-spacing: 0.06em;
  }

  .cursor {
    color: #00cc66;
    animation: cursor-blink 1s steps(1) infinite;
  }

  @keyframes cursor-blink {
    0%, 49% { opacity: 1; }
    50%, 100% { opacity: 0; }
  }

  .report-meta {
    margin: 0 0 16px;
    color: var(--term-text-body, #e8e8e8);
    font-size: 11px;
    font-weight: 600;
    line-height: 1.7;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .report-meta span {
    margin: 0 6px;
    color: var(--term-text-4, #bcbcbc);
  }

  .lede {
    max-width: 920px;
    margin: 0;
    color: #e3e3e3;
    font-size: 17px;
    line-height: 1.75;
  }

  .rule {
    height: 1px;
    margin-top: 20px;
    background: linear-gradient(90deg, #00cc66 0%, #1a1a1a 14%, #1a1a1a 100%);
  }

  .signal-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    border: 1px solid #1a1a1a;
    background: #0a0a0a;
  }

  .signal {
    min-width: 0;
    padding: 18px;
    border-right: 1px solid #1a1a1a;
  }

  .signal:last-child {
    border-right: 0;
  }

  .signal-index {
    display: block;
    margin-bottom: 12px;
    color: #00cc66;
    font-size: 10px;
    font-weight: 700;
  }

  .signal strong {
    display: block;
    color: #f0f0f0;
    font-size: clamp(22px, 2.4vw, 28px);
    line-height: 1.1;
  }

  .signal > span:nth-of-type(2) {
    display: block;
    margin-top: 8px;
    color: #e8e8e8;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.09em;
    text-transform: uppercase;
  }

  .signal small {
    display: block;
    margin-top: 5px;
    color: var(--term-text-4, #bcbcbc);
    font-size: 10px;
    line-height: 1.45;
  }

  .report-block {
    margin-top: 20px;
    padding: 20px;
    border: 1px solid #1a1a1a;
    background: #0a0a0a;
  }

  .block-title {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .block-title h2,
  .source-block h2 {
    margin: 0;
    color: #f0f0f0;
    font-family: 'JetBrains Mono', monospace;
    font-size: 15px;
    font-weight: 700;
    line-height: 1.2;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .block-meta {
    color: var(--term-text-body, #e8e8e8);
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .prose {
    margin-top: 16px;
  }

  .prose p,
  .steps p,
  .benefit-grid p,
  .source-block p {
    color: #e3e3e3;
    font-size: 15px;
    line-height: 1.75;
  }

  .prose p {
    margin: 0;
  }

  .prose p + p {
    margin-top: 14px;
  }

  .flow {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr) auto minmax(0, 1fr) auto minmax(0, 1fr);
    align-items: stretch;
    gap: 8px;
    margin-top: 18px;
  }

  .flow-node {
    min-width: 0;
    padding: 14px;
    border: 1px solid #202020;
    background: #080808;
  }

  .flow-node.active {
    border-color: rgba(0, 204, 102, 0.4);
    background: rgba(0, 204, 102, 0.05);
  }

  .flow-node span,
  .flow-node strong,
  .flow-node small {
    display: block;
  }

  .flow-node span {
    margin-bottom: 16px;
    color: #00cc66;
    font-size: 9px;
    font-weight: 700;
  }

  .flow-node strong {
    color: #f0f0f0;
    font-size: 11px;
    line-height: 1.35;
    text-transform: uppercase;
  }

  .flow-node small {
    margin-top: 5px;
    color: var(--term-text-4, #bcbcbc);
    font-size: 9px;
    line-height: 1.45;
  }

  .flow-arrow {
    align-self: center;
    color: #00cc66;
  }

  .steps {
    margin: 20px 0 0;
    padding: 0;
    list-style: none;
  }

  .steps li {
    display: grid;
    grid-template-columns: 34px 1fr;
    gap: 10px;
    padding: 11px 0;
    border-top: 1px dashed #1a1a1a;
  }

  .steps > li > span {
    padding-top: 4px;
    color: #00cc66;
    font-size: 10px;
    font-weight: 700;
  }

  .steps p {
    margin: 0;
  }

  .notice {
    display: flex;
    gap: 12px;
    margin-top: 16px;
    padding: 12px 14px;
    border: 1px solid rgba(85, 136, 204, 0.35);
    background: rgba(85, 136, 204, 0.05);
  }

  .notice > span {
    color: #6f9bd2;
    font-size: 11px;
    font-weight: 800;
  }

  .notice p {
    margin: 0;
    color: #d8d8d8;
    font-size: 12px;
    line-height: 1.6;
  }

  .benefit-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1px;
    margin: 18px -20px -20px;
    background: #1a1a1a;
    border-top: 1px solid #1a1a1a;
  }

  .benefit-grid article {
    padding: 20px;
    background: #0a0a0a;
  }

  .benefit-grid article:hover {
    background: #0d0d0d;
  }

  .benefit-grid article > span {
    color: #00cc66;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.12em;
  }

  .benefit-grid h3 {
    margin: 10px 0 7px;
    color: #f0f0f0;
    font-family: 'JetBrains Mono', monospace;
    font-size: 14px;
    letter-spacing: 0.03em;
  }

  .benefit-grid p {
    margin: 0;
    font-size: 14px;
    line-height: 1.7;
  }

  code {
    padding: 1px 5px;
    border: 1px solid #1a1a1a;
    background: #111;
    color: #00cc66;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.9em;
  }

  .flywheel {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-top: 18px;
    padding: 16px;
    overflow-x: auto;
    border: 1px solid #202020;
    background: #080808;
    color: #e8e8e8;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .flywheel b {
    color: #00cc66;
  }

  .source-block {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    margin-top: 20px;
    padding: 20px;
    border: 1px solid rgba(0, 204, 102, 0.4);
    background: linear-gradient(90deg, rgba(0, 204, 102, 0.07), #0a0a0a 62%);
  }

  .source-label {
    display: block;
    margin-bottom: 8px;
    color: #00cc66;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.15em;
  }

  .source-block p {
    margin: 8px 0 0;
    font-size: 14px;
  }

  .tracker-link {
    flex-shrink: 0;
    padding: 9px 12px;
    border: 1px solid #1a1a1a;
    color: #e8e8e8;
    font-size: 11px;
    font-weight: 700;
    text-decoration: none;
  }

  .tracker-link:hover {
    border-color: #00cc66;
    color: #00cc66;
  }

  .source-note {
    margin: 18px 0 0;
    color: var(--term-text-4, #bcbcbc);
    font-size: 10px;
    line-height: 1.65;
  }

  .back-link {
    display: inline-block;
    margin-top: 24px;
    color: var(--term-text-4, #bcbcbc);
    font-size: 13px;
    font-weight: 600;
    text-decoration: none;
  }

  .back-link span {
    color: #00cc66;
  }

  @media (max-width: 760px) {
    .briefings-page {
      width: min(100% - 28px, 1080px);
      padding-top: 22px;
    }

    .head-top,
    .block-head,
    .source-block {
      align-items: flex-start;
    }

    .signal-grid,
    .benefit-grid {
      grid-template-columns: 1fr;
    }

    .signal {
      border-right: 0;
      border-bottom: 1px solid #1a1a1a;
    }

    .signal:last-child {
      border-bottom: 0;
    }

    .flow {
      grid-template-columns: 1fr;
    }

    .flow-arrow {
      justify-self: center;
      transform: rotate(90deg);
    }

    .report-block {
      padding: 16px;
    }

    .benefit-grid {
      margin: 18px -16px -16px;
    }

    .source-block {
      flex-direction: column;
    }
  }

  @media (max-width: 480px) {
    .head-top .status,
    .block-meta {
      display: none;
    }

    .lede {
      font-size: 16px;
    }

    .source-block {
      padding: 16px;
    }
  }
</style>
