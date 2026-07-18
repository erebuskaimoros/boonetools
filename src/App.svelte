<script>
  import { onMount } from 'svelte';
  import Footer from './lib/Footer.svelte';
  import Snow from './lib/Snow.svelte';
  import Banner from './lib/Banner.svelte';

  const BASE_PATH = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
  function stripBase(pathname) {
    return BASE_PATH && pathname.startsWith(BASE_PATH)
      ? pathname.slice(BASE_PATH.length) || '/'
      : pathname;
  }

  const HOLIDAY_MODE = new Date().getMonth() === 11; // Auto-enable in December
  const SHOW_BANNER = false; // Easy to toggle banner on/off
  const SHOW_LIMIT_ORDERS = import.meta.env.DEV;
  const SHOW_VOTE_TRACKER = true;

  // Check for desktop app iframe mode
  let isDesktopApp = false;

  let selectedApp = null;
  let loadedComponent = null;
  let isLoadingApp = false;

  const rapidSwapsApp = {
    name: "Rapid Swaps",
    component: () => import("./lib/RapidSwaps.svelte"),
    icon: "⚡",
    path: "rapid-swaps",
    description: "Track live rapid streams plus the largest and latest recorded rapid swaps"
  };

  const statusApp = {
    name: "Network Status",
    component: () => import("./lib/StatusDashboard.svelte"),
    icon: "●",
    path: "status",
    description: "Live THORChain chain availability, network changes, and governance activity"
  };

  const tcFeeDashApp = {
    name: "TC Fee Dash",
    component: () => import("./lib/TCFeeDash.svelte"),
    icon: "$",
    path: "tc-fee-dash",
    description: "Track TC fee capture against global exchange volume"
  };

  const bondTrackerApp = {
    name: "Bond Tracker",
    component: () => import("./lib/BondTrackerV2.svelte"),
    icon: "🔗",
    path: "bond-tracker",
    description: "Track your node bond, rewards, churn status, and performance"
  };

  const vaultExplorerApp = {
    name: "Vault Explorer",
    component: () => import("./lib/VaultExplorer.svelte"),
    icon: "🏛️",
    path: "vault-explorer",
    description: "Explore vault asset distribution across Asgard vaults"
  };

  const treasuryTrackerApp = {
    name: "Treasury Tracker",
    component: () => import("./lib/Treasury.svelte"),
    icon: "🏦",
    path: "treasury",
    description: "Track original and active treasury addresses across THORChain and external chains"
  };

  const limitOrdersApp = {
    name: "Limit Orders",
    component: () => import("./lib/LimitOrders.svelte"),
    icon: "📊",
    path: "limit-orders",
    description: "Browse and place THORChain limit orders with full wallet support"
  };

  const appLayerBaseLayerApp = {
    name: "App Layer to Base Layer",
    component: () => import("./lib/AppLayerBaseLayerDashboard.svelte"),
    icon: "/assets/coins/RUJI.svg",
    path: "app-layer-base-layer",
    description: "Track observed Rujira fee sharing into the THORChain Reserve"
  };

  const voteTrackerApp = {
    name: "Vote Tracker",
    component: () => import("./lib/NodeVotes.svelte"),
    icon: "🗳️",
    path: "vote-tracker",
    description: "Track node Mimir vote history by vote key and node operator"
  };

  const dynamicFeeApp = {
    name: "ADR26 Dynamic Fees",
    component: () => import("./lib/DynamicFeeDashboard.svelte"),
    icon: "$",
    path: "adr26-dynamic-fees",
    description: "Track ADR26 dynamic L1 fee floors by thorname, pair, epoch, and controller signal"
  };

  const apps = [
    statusApp,
    rapidSwapsApp,
    tcFeeDashApp,
    bondTrackerApp,
    vaultExplorerApp,
    treasuryTrackerApp,
    dynamicFeeApp,
    ...(SHOW_LIMIT_ORDERS ? [limitOrdersApp] : []),
    ...(SHOW_VOTE_TRACKER ? [voteTrackerApp] : []),
    appLayerBaseLayerApp
  ];
  const hiddenApps = [];

  // The site has no homepage: unknown paths and `/` land on the status page.
  const defaultApp = statusApp;

  function getAvailableApp(path) {
    return [...apps, ...hiddenApps].find(a => a.path === path) || null;
  }

  function getAppParams(app) {
    const urlParams = new URLSearchParams(window.location.search);
    const params = new URLSearchParams();

    // Always preserve the desktop app flag
    if (isDesktopApp) {
      params.set('source', 'desktop-app');
    }

    if (app.name === "Bond Tracker") {
      const bondAddress = urlParams.get("bond_address");
      const nodeAddress = urlParams.get("node_address");
      if (bondAddress) params.set("bond_address", bondAddress);
      if (nodeAddress) params.set("node_address", nodeAddress);
    }

    return params.toString() ? `?${params.toString()}` : "";
  }

  async function loadComponent(app) {
    loadedComponent = null;
    isLoadingApp = true;
    try {
      const module = await app.component();
      loadedComponent = module.default;
    } catch (error) {
      console.error('Error loading component:', error);
    }
    isLoadingApp = false;
  }

  function trackAppView(app) {
    if (typeof gtag === 'undefined') return;
    gtag('event', 'page_view', {
      page_title: app.name,
      page_path: window.location.pathname,
      page_location: window.location.href
    });
    gtag('event', 'app_usage', {
      app_name: app.name,
      app_path: app.path
    });
    gtag('event', 'open_app', {
      app_name: app.name,
      app_path: app.path
    });
  }

  async function selectApp(app, { replace = false } = {}) {
    if (app.externalUrl) {
      if (typeof gtag !== 'undefined') {
        gtag('event', 'open_app', {
          app_name: app.name,
          app_path: app.path
        });
      }

      if (app.externalTarget === '_self') {
        window.location.assign(app.externalUrl);
      } else {
        window.open(app.externalUrl, app.externalTarget || '_blank');
      }
      return;
    }

    selectedApp = app;
    navOpen = false;
    const newUrl = `${BASE_PATH}/${app.path}${getAppParams(app)}`;
    if (replace) {
      history.replaceState(null, '', newUrl);
    } else {
      history.pushState(null, '', newUrl);
    }
    await loadComponent(app);
    trackAppView(app);
  }

  async function handlePopState() {
    // Re-check desktop app mode on navigation
    checkDesktopAppMode();
    navOpen = false;

    const path = stripBase(window.location.pathname).slice(1).split('/')[0];
    const app = getAvailableApp(path) || defaultApp;
    selectedApp = app;
    await loadComponent(app);
    trackAppView(app);
  }

  function checkDesktopAppMode() {
    const urlParams = new URLSearchParams(window.location.search);
    isDesktopApp = urlParams.get('source') === 'desktop-app';
  }

  onMount(() => {
    checkDesktopAppMode();

    // Route based on URL path; `/` and unknown paths default to status
    const path = stripBase(window.location.pathname).slice(1).split('/')[0];
    const app = getAvailableApp(path);
    selectApp(app || defaultApp, { replace: true });

    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  });

  // Mobile dropdown nav
  let navOpen = false;

  // Collapsible sidebar (persisted)
  const NAV_COLLAPSED_KEY = 'boonetools-nav-collapsed';
  let navCollapsed = localStorage.getItem(NAV_COLLAPSED_KEY) === '1';

  function toggleCollapsed() {
    navCollapsed = !navCollapsed;
    localStorage.setItem(NAV_COLLAPSED_KEY, navCollapsed ? '1' : '0');
  }

  function padIndex(i) {
    return String(i + 1).padStart(2, '0');
  }

  $: if (selectedApp) {
    document.title = `${selectedApp.name} - BOONE Tools`;
  } else {
    document.title = "BOONE Tools";
  }
</script>

<svelte:head>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous">
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700;800&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    body {
      background-color: #080808;
      margin: 0;
      padding: 0;
      min-height: 100vh;
    }
  </style>
</svelte:head>

<main class:desktop-app={isDesktopApp} class:collapsed={navCollapsed}>
  {#if HOLIDAY_MODE}
    <Snow />
  {/if}

  <!-- Desktop sidebar -->
  <aside class="sidebar" class:collapsed={navCollapsed}>
    <div class="side-head">
      {#if !navCollapsed}
        <button class="brand" on:click={() => selectApp(defaultApp)} aria-label="Go to status page">
          <span class="brand-prompt">$</span>
          <span class="brand-name">boone.tools</span>
          <span class="cursor">_</span>
        </button>
      {/if}
      <button
        class="bracket-btn"
        on:click={toggleCollapsed}
        title={navCollapsed ? 'expand nav' : 'collapse nav'}
        aria-label={navCollapsed ? 'Expand navigation' : 'Collapse navigation'}
      ><span class="bk">[</span>{navCollapsed ? '»' : '«'}<span class="bk">]</span></button>
    </div>

    <div class="side-label">
      {#if navCollapsed}
        <span class="ls-prompt">$</span>
      {:else}
        <span class="ls-line"><span class="ls-prompt">$</span> ls ./tools</span>
        <span class="side-label-count">[{apps.length}]</span>
      {/if}
    </div>

    <nav class="side-nav">
      {#each apps as app, i}
        {@const isActive = selectedApp && selectedApp.path === app.path}
        <button
          class="side-item"
          class:active={isActive}
          on:click={() => selectApp(app)}
          title={navCollapsed ? app.name : app.description}
        >
          {#if navCollapsed}
            <span class="item-index">{padIndex(i)}</span>
          {:else}
            <span class="item-prompt">{isActive ? '$' : '>'}</span>
            <span class="item-name">{app.path}</span>
          {/if}
        </button>
      {/each}
    </nav>

    <div class="side-status">
      <span class="status-dot"></span>
      {#if !navCollapsed}
        <span class="status-text">THORCHAIN ONLINE</span>
        <span class="status-ver">v2.0</span>
      {/if}
    </div>
  </aside>

  <!-- Mobile / desktop-app top bar -->
  <header class="topbar">
    <button class="brand" on:click={() => selectApp(defaultApp)} aria-label="Go to status page">
      <span class="brand-prompt">$</span>
      <span class="brand-name">boone.tools</span>
      <span class="cursor">_</span>
    </button>
    <div class="topbar-right">
      {#if selectedApp}
        <span class="topbar-app">> {selectedApp.path}</span>
      {/if}
      <button
        class="bracket-btn"
        on:click={() => navOpen = !navOpen}
        aria-expanded={navOpen}
        aria-label="Toggle navigation menu"
      ><span class="bk">[</span>≡<span class="bk">]</span> nav</button>
    </div>
  </header>

  {#if navOpen}
    <button class="nav-backdrop" on:click={() => navOpen = false} aria-label="Close navigation menu"></button>
    <div class="nav-drop">
      {#each apps as app}
        {@const isActive = selectedApp && selectedApp.path === app.path}
        <button
          class="drop-item"
          class:active={isActive}
          on:click={() => selectApp(app)}
        >
          <span class="item-prompt">{isActive ? '$' : '>'}</span>
          <span class="item-name">{app.path}</span>
        </button>
      {/each}
      <div class="drop-status">
        <span class="status-dot"></span>
        <span class="status-text">THORCHAIN ONLINE</span>
        <span class="status-ver">v2.0</span>
      </div>
    </div>
  {/if}

  {#if SHOW_BANNER}
    <Banner />
  {/if}

  <div class="content">
    {#if selectedApp && loadedComponent}
      <svelte:component this={loadedComponent} />
    {:else if isLoadingApp && selectedApp}
      <div class="app-loading">
        <span class="brand-prompt">$</span> loading {selectedApp.path}<span class="cursor">_</span>
      </div>
    {/if}
  </div>

  {#if !isDesktopApp}
  <Footer />
  {/if}
</main>

<style>
  :global(*) {
    font-family: 'DM Sans', -apple-system, sans-serif;
    box-sizing: border-box;
  }

  :root {
    --background-color: #080808;
    --text-color: #c8c8c8;
    --text-muted: #666;
    --sidebar-width: 232px;
    --sidebar-width-collapsed: 56px;
    --topbar-height: 40px;
    --footer-height: 41px;
  }

  main {
    text-align: left;
    background-color: var(--background-color);
    min-height: 100vh;
    height: 100vh;
    height: 100dvh;
    color: var(--text-color);
    position: relative;
    overflow: hidden;
  }

  /* ---- SHARED TERMINAL BITS ---- */

  .brand {
    display: flex;
    align-items: baseline;
    gap: 6px;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    font-family: 'JetBrains Mono', monospace;
  }

  .brand-prompt {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    font-weight: 700;
    color: #00cc66;
  }

  .brand-name {
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    font-weight: 700;
    color: #e8e8e8;
    letter-spacing: 0.08em;
  }

  .cursor {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    font-weight: 700;
    color: #00cc66;
    animation: cursor-blink 1s steps(1) infinite;
  }

  @keyframes cursor-blink {
    0%, 49% { opacity: 1; }
    50%, 100% { opacity: 0; }
  }

  .bracket-btn {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    font-weight: 600;
    color: #888;
    background: transparent;
    border: 1px solid #1a1a1a;
    padding: 4px 8px;
    cursor: pointer;
    transition: border-color 0.15s ease, color 0.15s ease;
    white-space: nowrap;
  }

  .bracket-btn:hover {
    border-color: #00cc66;
    color: #00cc66;
  }

  .bracket-btn .bk {
    color: #444;
  }

  .status-dot {
    display: inline-block;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: #00cc66;
    box-shadow: 0 0 6px rgba(0, 204, 102, 0.4);
    flex-shrink: 0;
    animation: pulse-dot 2s infinite;
  }

  @keyframes pulse-dot {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  .item-index {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    font-weight: 600;
    color: #333;
    min-width: 18px;
    flex-shrink: 0;
  }

  .item-prompt {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    font-weight: 700;
    color: #444;
    width: 12px;
    flex-shrink: 0;
    transition: color 0.15s ease;
  }

  .item-name {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    flex: 0 1 auto;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    text-align: left;
  }

  .status-text {
    font-family: 'JetBrains Mono', monospace;
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.12em;
    color: #444;
    flex: 1;
  }

  .status-ver {
    font-family: 'JetBrains Mono', monospace;
    font-size: 9px;
    color: #333;
  }

  /* ---- DESKTOP SIDEBAR ---- */

  .sidebar {
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    width: var(--sidebar-width);
    background: #0a0a0a;
    border-right: 1px solid #1a1a1a;
    display: flex;
    flex-direction: column;
    z-index: 500;
  }

  .sidebar.collapsed {
    width: var(--sidebar-width-collapsed);
  }

  .side-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 44px;
    padding: 0 12px 0 14px;
    border-bottom: 1px solid #141414;
    flex-shrink: 0;
  }

  .sidebar.collapsed .side-head {
    justify-content: center;
    padding: 0;
  }

  .side-label {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding: 14px 14px 8px 12px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: #666;
    flex-shrink: 0;
  }

  .sidebar.collapsed .side-label {
    justify-content: center;
    padding: 14px 0 8px;
  }

  .ls-line {
    font-family: 'JetBrains Mono', monospace;
  }

  .ls-prompt {
    font-family: 'JetBrains Mono', monospace;
    font-weight: 700;
    color: #00cc66;
  }

  .side-label-count {
    color: #333;
  }

  .side-nav {
    flex: 1;
    overflow-y: auto;
    padding: 2px 0 8px;
  }

  .side-item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 9px 14px 9px 12px;
    background: transparent;
    border: none;
    border-left: 2px solid transparent;
    color: #888;
    cursor: pointer;
    text-align: left;
    transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
  }

  .side-item:hover {
    background: #0d0d0d;
    color: #c8c8c8;
  }

  .side-item:hover .item-prompt {
    color: #00cc66;
  }

  .side-item.active {
    border-left-color: #00cc66;
    background: rgba(0, 204, 102, 0.07);
    color: #00cc66;
  }

  .side-item.active .item-index {
    color: rgba(0, 204, 102, 0.55);
  }

  .side-item.active .item-prompt {
    color: #00cc66;
  }

  .sidebar.collapsed .side-item {
    justify-content: center;
    padding: 9px 0;
    gap: 0;
  }

  .sidebar.collapsed .item-index {
    min-width: 0;
    text-align: center;
  }

  .sidebar.collapsed .side-item:hover .item-index {
    color: #c8c8c8;
  }

  .sidebar.collapsed .side-item.active .item-index {
    color: #00cc66;
  }

  .side-status {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 14px;
    border-top: 1px solid #141414;
    flex-shrink: 0;
  }

  .sidebar.collapsed .side-status {
    justify-content: center;
    padding: 12px 0;
  }

  /* ---- MOBILE / DESKTOP-APP TOP BAR ---- */

  .topbar {
    display: none;
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    height: var(--topbar-height);
    background: #0a0a0a;
    border-bottom: 1px solid #1a1a1a;
    z-index: 620;
    padding: 0 12px;
    align-items: center;
    justify-content: space-between;
  }

  .topbar-right {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
  }

  .topbar-app {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: #555;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .nav-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.65);
    border: none;
    padding: 0;
    z-index: 600;
    cursor: default;
  }

  .nav-drop {
    position: fixed;
    top: var(--topbar-height);
    left: 0;
    right: 0;
    z-index: 610;
    background: #0a0a0a;
    border-bottom: 1px solid #1a1a1a;
    max-height: calc(100vh - var(--topbar-height));
    overflow-y: auto;
  }

  .drop-item {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 13px 16px 13px 14px;
    background: transparent;
    border: none;
    border-left: 2px solid transparent;
    border-bottom: 1px solid #111;
    color: #888;
    cursor: pointer;
    text-align: left;
    transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
  }

  .drop-item .item-name,
  .drop-item .item-prompt {
    font-size: 12px;
  }

  .drop-item:hover {
    background: #0d0d0d;
    color: #c8c8c8;
  }

  .drop-item:hover .item-prompt {
    color: #00cc66;
  }

  .drop-item.active {
    border-left-color: #00cc66;
    background: rgba(0, 204, 102, 0.07);
    color: #00cc66;
  }

  .drop-item.active .item-prompt {
    color: #00cc66;
  }

  .drop-status {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
  }

  /* ---- CONTENT ---- */

  .content {
    margin-left: var(--sidebar-width);
    height: calc(100vh - var(--footer-height));
    height: calc(100dvh - var(--footer-height));
    overflow-y: auto;
    overscroll-behavior-y: contain;
    scrollbar-color: #242424 #080808;
    scrollbar-width: thin;
    position: relative;
    z-index: 1;
  }

  .content::-webkit-scrollbar {
    width: 8px;
  }

  .content::-webkit-scrollbar-track {
    background: #080808;
  }

  .content::-webkit-scrollbar-thumb {
    background: #242424;
    border: 2px solid #080808;
  }

  main.collapsed .content {
    margin-left: var(--sidebar-width-collapsed);
  }

  .app-loading {
    max-width: 650px;
    margin: 48px auto 0;
    padding: 0 16px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    font-weight: 600;
    color: #666;
  }

  /* ---- DESKTOP-APP IFRAME MODE: no sidebar, compact top bar ---- */

  main.desktop-app .sidebar {
    display: none;
  }

  main.desktop-app .topbar {
    display: flex;
  }

  main.desktop-app .content {
    margin-left: 0;
    height: 100vh;
    height: 100dvh;
    padding-top: var(--topbar-height);
  }

  /* ---- MOBILE: dropdown nav instead of sidebar ---- */

  @media (max-width: 768px) {
    .sidebar {
      display: none;
    }

    .topbar {
      display: flex;
    }

    .content {
      margin-left: 0;
      padding-top: var(--topbar-height);
    }

    main.collapsed .content {
      margin-left: 0;
    }
  }

  @media (max-width: 600px) {
    :root {
      --footer-height: 32px;
    }
  }
</style>
