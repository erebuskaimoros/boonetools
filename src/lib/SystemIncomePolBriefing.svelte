<script>
  export let briefing;
  export let briefingsRoot;
  export let navigate;

  const SOURCE_URL = 'https://x.com/BooneW/status/2094724612860813417';
  const TRACKER_URL = 'https://boone.tools/pol-tracker';
</script>

<article class="briefings-page">
  <nav class="breadcrumbs" aria-label="Breadcrumb">
    <a href={briefingsRoot} on:click={(event) => navigate(event)}>briefings</a>
    <span>/</span>
    <span>{briefing.slug}</span>
  </nav>

  <header>
    <h1>THORChain's New POL</h1>
    <p class="subtitle">The new Liquidity Black Hole</p>
    <p class="report-meta">boone · {briefing.published}</p>
  </header>

  <div class="article-body">
    <h2>Background</h2>

    <p>
      Ever since the ThorFi collapse there has been essentially no rewards going to Base Layer liquidity pool LPs and
      thus no incentive for liquidity to be added to them and they have not grown. Growing Base Layer swap liquidity
      is important for TC because it improves swap execution and allows TC to open new pools/swap routes. Traditionally
      TC, as most other DEXs, did this by paying users yield in return for them depositing their capital into its pools
      - renting liquidity if you will. But what if, rather than paying people to borrow their capital, the protocol paid
      itself and owned the capital forever?
    </p>

    <p>
      TC has historically paid ~20% of its revenue to Liquidity Providers (LPs). With the introduction of the System
      Income Protocol Owned Liquidity (POL) feature, it will instead deposit that same 20%* directly into its pools
      itself - owned in common by the protocol.
    </p>

    <h2>How it Works</h2>

    <p>
      Every block, 20%* of the system income (swap fees mostly) gets deposited into the eligible pool that had the
      highest fees earned / depth of the pool over a previous three day window. Every three days a new snapshot is
      taken and new pool chosen. Only L1 gas (main) assets and certain stablecoin pools are eligible to receive POL,
      and only if they have no synths in the pool. The POL is deposited as RUNE, but is immediately rebalanced to 1:1
      RUNE:Asset by arbs.
    </p>

    <p>
      You may have noticed that I put an asterisk next to the 20% above. This is because it’s not a fixed value,
      but rather subject to votes by TC’s Node Operators (NOs). There seems to be consensus around 20% for now though.
    </p>

    <h2>Why it Benefits the Protocol</h2>

    <p>
      Owning liquidity instead of renting it has several nice properties for the protocol. First, POL is an asset
      to the protocol while third party LP is a liability. This matters should TC ever suffer another exploit
      - no user needs to be made whole should POL be lost.
    </p>

    <p>
      Second, this is productive capital that earns yield for the protocol. Since turning the feature on, the
      capital deposited into the TRON.USDT pool has been earning at a rate of ~164% APR.
    </p>

    <p>
      Third, this capital is permanent and permissionless. Unlike third party capital, which can be withdrawn at any
      moment, this capital will be locked in the protocol forever. TC can depend and plan on it. And perhaps most
      importantly, this capital is permissionless and thus ensures that there will be liquidity with which TC can
      serve its permissionless cross-chain swaps.
    </p>

    <p>
      Fourth, it functions as a quasi-burn of the RUNE token. Half of the liquidity in the pools will always be RUNE
      - which will never be sold*. This is compounding buy pressure on RUNE.
    </p>

    <p>*Subject to k=xy pool math though.</p>

    <p>
      Fifth, the other half of the liquidity will be in the assets most in demand from TC swappers. In other words,
      TC will be building a treasury of blue chip crypto assets. As time goes on and POL compounds, TC might even
      come to look like a crypto ETF in a sense. These assets won’t just be sitting there, they’ll be earning yield
      as well.
    </p>

    <p>
      Lastly, and probably most importantly, it improves TC swap execution which in turn will generate more volume
      and revenue for TC. And then 20% of that revenue goes back into POL and keeps snowballing. It will also enable
      TC to continue to open new pools without draining money from the Treasury, and one day could even enable the
      Treasury to withdraw it's capital to be put to other uses.
    </p>

    <p>Track its progress here: <a href={TRACKER_URL}>boone.tools/pol-tracker</a></p>
  </div>

  <footer>
    <a href={SOURCE_URL} target="_blank" rel="noreferrer">Original article on X</a>
    <a href={briefingsRoot} on:click={(event) => navigate(event)}>← all briefings</a>
  </footer>
</article>

<style>
  .briefings-page {
    width: min(760px, calc(100% - 48px));
    margin: 0 auto;
    padding: 28px 0 64px;
    color: var(--term-text-body, #e8e8e8);
    font-family: 'DM Sans', -apple-system, sans-serif;
  }

  .breadcrumbs {
    display: flex;
    gap: 8px;
    margin-bottom: 32px;
    color: var(--term-text-3, #c8c8c8);
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
  }

  .breadcrumbs span:last-child {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  a {
    color: var(--term-accent, #00cc66);
    text-underline-offset: 3px;
    overflow-wrap: anywhere;
  }

  a:hover {
    color: var(--term-text, #f5f5f5);
  }

  h1 {
    margin: 0 0 12px;
    color: var(--term-text, #f5f5f5);
    font-size: clamp(28px, 4vw, 36px);
    line-height: 1.2;
    font-weight: 700;
  }

  .subtitle {
    margin: 0 0 14px;
    font-size: 20px;
    line-height: 1.5;
  }

  .report-meta {
    margin: 0;
    color: var(--term-text-3, #c8c8c8);
    font-size: 14px;
    line-height: 1.6;
  }

  .article-body h2 {
    margin: 32px 0 16px;
    color: var(--term-text, #f5f5f5);
    font-size: 23px;
    line-height: 1.35;
    font-weight: 700;
  }

  .article-body p {
    margin: 0 0 22px;
    font-size: 17px;
    line-height: 1.75;
  }

  footer {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 16px;
    margin-top: 32px;
    padding-top: 20px;
    border-top: 1px solid var(--term-border, #1a1a1a);
    font-size: 13px;
    line-height: 1.6;
  }

  @media (max-width: 600px) {
    .briefings-page {
      width: calc(100% - 32px);
      padding-top: 22px;
    }

    .article-body p {
      font-size: 16px;
    }

    .article-body h2 {
      font-size: 21px;
    }
  }
</style>
