<script>
  import { onMount, afterUpdate } from 'svelte';
  import { fade, fly, crossfade } from 'svelte/transition';
  import { quintOut, cubicInOut } from 'svelte/easing';
  import logo from "../public/assets/runetools-logo.svg";
  import laserLogo from "../public/assets/runetools-laser-logo.svg";
  import santaLogo from "../public/assets/runetools-logos/runetools-logo-santa.png";
  import Footer from './lib/Footer.svelte';
  import Snow from './lib/Snow.svelte';
  import TerminalText from './lib/TerminalText.svelte';
  import LoadingBar from './lib/components/LoadingBar.svelte';
  import { writable } from 'svelte/store';
  import Banner from './lib/Banner.svelte';
  
  const BASE_PATH = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');

  function stripBase(pathname) {
    return BASE_PATH && pathname.startsWith(BASE_PATH)
      ? pathname.slice(BASE_PATH.length) || '/'
      : pathname;
  }

  // Add store for starred apps
  const STARRED_APPS_KEY = 'runetools-starred-apps';
  const starredApps = writable(new Set(JSON.parse(localStorage.getItem(STARRED_APPS_KEY) || '[]')));
  
  // Subscribe to changes and update localStorage
  starredApps.subscribe(value => {
    localStorage.setItem(STARRED_APPS_KEY, JSON.stringify(Array.from(value)));
  });

  const HOLIDAY_MODE = new Date().getMonth() === 11; // Auto-enable in December
  const SHOW_BANNER = false; // Easy to toggle banner on/off
  const SHOW_LIMIT_ORDERS = import.meta.env.DEV;

  // Check for desktop app iframe mode
  let isDesktopApp = false;
  
  let selectedApp = null;
  let addressParam = writable('');
  let votingSearchTerm = writable('');
  let loadedComponent = null;
  let isLoadingApp = false;

  const rapidSwapsApp = {
    name: "Rapid Swaps",
    component: () => import("./lib/RapidSwaps.svelte"),
    icon: "⚡",
    path: "rapid-swaps",
    description: "Track live rapid streams plus the largest and latest recorded rapid swaps"
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

  const limitOrdersApp = {
    name: "Limit Orders",
    component: () => import("./lib/LimitOrders.svelte"),
    icon: "📊",
    path: "limit-orders",
    description: "Browse and place THORChain limit orders with full wallet support"
  };

  const apps = [
    rapidSwapsApp,
    bondTrackerApp,
    vaultExplorerApp,
    ...(SHOW_LIMIT_ORDERS ? [limitOrdersApp] : [])
  ];
  const hiddenApps = [];

  function getAvailableApp(path) {
    return [...apps, ...hiddenApps].find(a => a.path === path) || null;
  }

  function normalizeHomeUrl() {
    return isDesktopApp ? `${BASE_PATH}/?source=desktop-app` : `${BASE_PATH}/`;
  }

  function redirectUnavailableApp(path) {
    if (!path) return;
    if (path === 'limit-orders' && !SHOW_LIMIT_ORDERS) {
      history.replaceState(null, '', normalizeHomeUrl());
    }
  }

  const [send, receive] = crossfade({
    duration: 400,
    fallback(node, params) {
      const style = getComputedStyle(node);
      const transform = style.transform === 'none' ? '' : style.transform;

      return {
        duration: 400,
        easing: cubicInOut,
        css: t => `
          transform: ${transform} scale(${t});
          opacity: ${t}
        `
      };
    }
  });

  let hoveredApp = null;
  let displayedDescription = "Welcome to BOONE Tools";
  let descriptionTimer;
  let isTyping = true;

  function handleMouseEnter(app) {
    if (!isMobile) {
      hoveredApp = app;
      clearTimeout(descriptionTimer);
      isTyping = true;
      displayedDescription = app.description;
    }
  }

  function handleMouseLeave() {
    if (!isMobile) {
      clearTimeout(descriptionTimer);
      descriptionTimer = setTimeout(() => {
        isTyping = true;
        displayedDescription = "Welcome to BOONE Tools";
      }, 3000);
    }
  }

  async function selectApp(app) {
    if (app.externalUrl) {
      window.open(app.externalUrl, '_blank');
    } else {
      // Clear old component and show loading state immediately
      loadedComponent = null;
      isLoadingApp = true;
      selectedApp = app;
      const newUrl = `${BASE_PATH}/${app.path}${getAppParams(app)}`;
      history.pushState(null, '', newUrl);
      menuOpen = false;

      try {
        const module = await app.component();
        loadedComponent = module.default;
        isLoadingApp = false;

        // Track page view when app changes
        if (typeof gtag !== 'undefined') {
          gtag('event', 'page_view', {
            page_title: app.name,
            page_path: newUrl,
            page_location: window.location.href
          });
          // Track app usage
          gtag('event', 'app_usage', {
            app_name: app.name,
            app_path: app.path
          });
          // Increment open_app event with app details
          gtag('event', 'open_app', {
            app_name: app.name,
            app_path: app.path
          });
        }
      } catch (error) {
        console.error('Error loading component:', error);
        isLoadingApp = false;
      }

      // Update addressParam if it's the SwapperClout component
      if (app.name === "Swapper Clout") {
        const urlParams = new URLSearchParams(window.location.search);
        const address = urlParams.get('address');
        addressParam.set(address || '');
      }
    }
  }

  function getAppParams(app) {
    const urlParams = new URLSearchParams(window.location.search);
    const params = new URLSearchParams();
    
    // Always preserve the desktop app flag
    if (isDesktopApp) {
      params.set('source', 'desktop-app');
    }
    
    // Add app-specific parameters
    if (app.name === "Bond Tracker") {
      const bondAddress = urlParams.get("bond_address");
      const nodeAddress = urlParams.get("node_address");
      if (bondAddress) params.set("bond_address", bondAddress);
      if (nodeAddress) params.set("node_address", nodeAddress);
    } else if (app.name === "Node Operator") {
      const nodeAddress = urlParams.get("node_address");
      if (nodeAddress) params.set("node_address", nodeAddress);
    } else if (app.name === "Rune Pool") {
      const address = urlParams.get("address");
      if (address) params.set("address", address);
    } else if (app.name === "Swapper Clout") {
      const address = urlParams.get("address");
      if (address) params.set("address", address);
    } else if (app.name === "LP Checker") {
      const pool = urlParams.get("pool");
      const address = urlParams.get("address");
      if (pool) params.set("pool", pool);
      if (address) params.set("address", address);
    } else if (app.name === "Affiliates") {
      const thorname = urlParams.get("thorname");
      if (thorname) params.set("thorname", thorname);
    } else if (app.name === "Voting") {
      const key = urlParams.get("key");
      if (key) params.set("key", key);
    }
    
    return params.toString() ? `?${params.toString()}` : "";
  }

  async function handlePopState() {
    // Re-check desktop app mode on navigation
    checkDesktopAppMode();

    const path = stripBase(window.location.pathname).slice(1).split('/')[0];
    const app = getAvailableApp(path);

    // Clear old component and show loading state immediately
    if (app) {
      loadedComponent = null;
      isLoadingApp = true;
    }
    selectedApp = app || null;

    if (!app) {
      redirectUnavailableApp(path);
    }

    if (app) {
      try {
        const module = await app.component();
        loadedComponent = module.default;
        isLoadingApp = false;

        // Track page view on browser navigation
        if (typeof gtag !== 'undefined') {
          gtag('event', 'page_view', {
            page_title: app ? app.name : 'Home',
            page_path: window.location.pathname,
            page_location: window.location.href
          });
          // Track open_app event
          gtag('event', 'open_app', {
            app_name: app.name,
            app_path: app.path
          });
        }
      } catch (error) {
        console.error('Error loading component:', error);
        isLoadingApp = false;
      }

      const urlParams = new URLSearchParams(window.location.search);
      if (app.name === "Swapper Clout") {
        const address = urlParams.get('address') || path.split('/')[1];
        addressParam.set(address || '');
      } else if (app.name === "Bond Tracker") {
        const bondAddress = urlParams.get('bond_address');
        const nodeAddress = urlParams.get('node_address');
        // Handle Bond Tracker params if needed
      } else if (app.name === "Node Operator") {
        const nodeAddress = urlParams.get('node_address');
        // Handle Node Operator params if needed
      } else if (app.name === "Rune Pool") {
        const address = urlParams.get('address');
        // Handle Rune Pool params if needed
      } else if (app.name === "LP Checker") {
        const pool = urlParams.get('pool');
        const address = urlParams.get('address');
        // Handle LP Checker params if needed
      } else if (app.name === "Affiliates") {
        const thorname = urlParams.get('thorname');
        if (thorname) {
          addressParam.set(thorname);
        }
      } else if (app.name === "Voting") {
        const key = urlParams.get('key');
        if (key) {
          // You might need to create a store or prop to pass this to the Voting component
          votingSearchTerm.set(key);
        }
      }
    }
  }

  function checkDesktopAppMode() {
    const urlParams = new URLSearchParams(window.location.search);
    isDesktopApp = urlParams.get('source') === 'desktop-app';
  }

  onMount(() => {
    checkDesktopAppMode();

    // Route based on URL path, or show home screen
    const path = stripBase(window.location.pathname).slice(1).split('/')[0];
    const app = getAvailableApp(path);
    if (app) {
      selectApp(app);
    } else {
      redirectUnavailableApp(path);
    }

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
    };
  });

  afterUpdate(() => {
    if (selectedApp && selectedApp.name === "Swapper Clout") {
      const address = stripBase(window.location.pathname).split('/')[2];
      if (address) {
        addressParam.set(address);
      }
    }
  });

  let menuOpen = false;

  const houseIcon = `
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
      <polyline points="9 22 9 12 15 12 15 22"></polyline>
    </svg>
  `;

  const hamburgerIcon = `
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <line x1="3" y1="12" x2="21" y2="12"></line>
      <line x1="3" y1="6" x2="21" y2="6"></line>
      <line x1="3" y1="18" x2="21" y2="18"></line>
    </svg>
  `;

  const backIcon = `
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="m12 19-7-7 7-7"></path>
      <path d="M19 12H5"></path>
    </svg>
  `;

  function toggleMenu() {
    menuOpen = !menuOpen;
  }

  function goHome() {
    selectedApp = null;
    const homeUrl = normalizeHomeUrl();
    history.pushState(null, '', homeUrl);
    menuOpen = false;

    // Track home page view
    if (typeof gtag !== 'undefined') {
      gtag('event', 'page_view', {
        page_title: 'Home',
        page_path: homeUrl,
        page_location: window.location.href
      });
    }
  }

  let typingTimeout;
  function handleDescriptionChange() {
    isTyping = true;
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      isTyping = false;
    }, 100); // Small delay to trigger re-render
  }

  $: {
    displayedDescription; // This will trigger the handleDescriptionChange when displayedDescription changes
    handleDescriptionChange();
  }

  let isMobile = typeof window !== 'undefined' && window.innerWidth <= 768;

  function checkMobile() {
    isMobile = window.innerWidth <= 768;
  }

  function handleAppClick(app) {
    selectApp(app);
  }

  function handleResize() {
    checkMobile();
  }

  function calculateOptimalLayout(totalItems, containerWidth) {
    const minItemWidth = 120;
    const gap = 24;
    const maxColumns = Math.floor((containerWidth - 40) / (minItemWidth + gap));
    
    // Try different numbers of columns to find one that gives us balanced rows
    for (let cols = maxColumns; cols >= 3; cols--) {
      const rows = Math.ceil(totalItems / cols);
      const lastRowItems = totalItems % cols;
      
      // If the last row has 3 or more items, or if it's perfectly divided
      if (lastRowItems === 0 || lastRowItems >= 3) {
        return cols;
      }
    }
    
    // If we couldn't find a perfect fit, default to 3 columns
    return 3;
  }

  let containerWidth;
  let optimalColumns = 3;

  $: if (containerWidth) {
    optimalColumns = calculateOptimalLayout(apps.length, containerWidth);
  }

  // Group apps into rows based on optimal columns
  function groupIntoRows(apps, columns) {
    const rows = [];
    for (let i = 0; i < apps.length; i += columns) {
      rows.push(apps.slice(i, Math.min(i + columns, apps.length)));
    }
    return rows;
  }

  // Add star icon SVG
  const starOutlineIcon = `
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
    </svg>
  `;

  const starFilledIcon = `
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="#FFD700" stroke="#FFD700" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
    </svg>
  `;

  // Add function to toggle star status
  function toggleStar(app, event) {
    event.stopPropagation(); // Prevent app selection when clicking star
    starredApps.update(starred => {
      const newStarred = new Set(starred);
      if (newStarred.has(app.path)) {
        newStarred.delete(app.path);
      } else {
        newStarred.add(app.path);
      }
      return newStarred;
    });
  }

  // Sort apps with starred items first
  $: sortedApps = [...apps].sort((a, b) => {
    const aStarred = $starredApps.has(a.path);
    const bStarred = $starredApps.has(b.path);
    if (aStarred && !bStarred) return -1;
    if (!aStarred && bStarred) return 1;
    return 0;
  });

  // Update the grouping function to use sortedApps
  $: appRows = groupIntoRows(sortedApps, optimalColumns);

  $: if (selectedApp) {
    document.title = `${selectedApp.name} - BOONE Tools`;
  } else {
    document.title = "BOONE Tools";
  }
</script>

<svelte:head>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
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

<main class:mobile={isMobile} class:desktop-app={isDesktopApp}>
  {#if HOLIDAY_MODE}
    <Snow />
  {/if}
  <header>
    <div class="header-content">
      {#if !isDesktopApp}
      <div class="logo-container">
        <button class="logo-wrapper" on:click={goHome} aria-label="Go to home page">
          <span class="logo-text">BOONE.TOOLS</span>
        </button>
      </div>
      {:else}
      <div class="logo-container desktop-mode">
        {#if selectedApp}
          <button 
            class="nav-button back-button" 
            on:click={goHome}
            title="Back to Home"
          >
            {@html backIcon}
          </button>
        {/if}
      </div>
      {/if}
      <div class="title-container">
        <h2 class="rune-tools-title">{selectedApp ? selectedApp.name : ''}</h2>
      </div>
    </div>
  </header>
  
  {#if SHOW_BANNER}
    <Banner />
  {/if}

<div class="content">
    <div class="scrollable-container">
        {#if selectedApp && loadedComponent}
          <svelte:component this={loadedComponent} />
        {:else if !selectedApp}
          <div class="terminal-home">
            <div class="terminal-hero">
              <div class="hero-sigil">ᚱ</div>
              <h1 class="hero-title">BOONE<span class="hero-dot">.</span>TOOLS</h1>
              <div class="hero-sub">THORCHAIN TERMINAL</div>
            </div>

            <div class="terminal-nav">
              <div class="nav-header">
                <span class="nav-label">SELECT DASHBOARD</span>
                <span class="nav-hint">{apps.length} available</span>
              </div>
              {#each apps as app, i}
                <button class="nav-row" on:click={() => selectApp(app)}>
                  <span class="nav-index">{i + 1}</span>
                  <span class="nav-icon">{app.icon}</span>
                  <div class="nav-info">
                    <span class="nav-name">{app.name}</span>
                    <span class="nav-desc">{app.description}</span>
                  </div>
                  <span class="nav-arrow">→</span>
                </button>
              {/each}
            </div>

            <div class="terminal-status">
              <span class="status-item"><span class="status-dot"></span> THORCHAIN ONLINE</span>
              <span class="status-sep">|</span>
              <span class="status-item">v2.0</span>
            </div>
          </div>
        {/if}
    </div>
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
  }

  main {
    text-align: left;
    margin: 0 auto;
    max-width: 100%;
    background-color: var(--background-color);
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    color: var(--text-color);
    padding-top: calc(36px + var(--banner-height, 0px));
    position: relative;
  }

  /* Desktop mode styling for logo container */
  .logo-container.desktop-mode {
    /* Keep the same width but remove content */
    flex: 0 0 auto;
    width: 33.33%;
  }

  header {
    background: #0a0a0a;
    padding: 0 16px;
    height: 36px;
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 1000;
    border-bottom: 1px solid #1a1a1a;
    display: flex;
    align-items: center;
  }

  .header-content {
    display: flex;
    justify-content: space-between;
    align-items: center;
    width: 100%;
    gap: 16px;
  }

  .logo-container {
    flex: 0 0 auto;
    text-align: left;
  }

  .logo-wrapper {
    position: relative;
    display: inline-block;
    cursor: pointer;
    transform: scale(1.05);
    background: none;
    border: none;
    padding: 0;
  }

  .logo {
    height: 2rem;
    width: auto;
    max-width: 100%;
  }

  .logo-text {
    font-family: 'JetBrains Mono', monospace;
    font-weight: 700;
    font-size: 12px;
    color: #888;
    letter-spacing: 0.08em;
  }

  .original-logo {
    position: relative;
    z-index: 2;
  }

  .laser-logo {
    position: absolute;
    top: 0;
    left: 0;
    z-index: 1;
    opacity: 0;
  }

  .title-container {
    flex: 0 0 auto;
  }

  .rune-tools-title {
    font-family: 'JetBrains Mono', monospace;
    color: #555;
    font-size: 11px;
    font-weight: 500;
    margin: 0;
    line-height: 1;
    letter-spacing: 0.06em;
  }

  nav {
    flex: 0 0 auto;
    width: 33.33%;
    text-align: right;
  }

  .content {
    flex: 1;
    padding-top: 0;
    position: relative;
    z-index: 1;
    padding-bottom: 40px;
  }

  .scrollable-container {
    padding-top: 0;
  }

  .description-container {
    color: var(--text-color);
    padding: 0.5rem;
    margin-bottom: 0.5rem;
    height: 80px;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    background-color: transparent;
    border-radius: 8px;
    font-size: 1.5rem;
    position: relative;
  }

  .description-container :global(p) {
    margin: 0;
    text-align: center;
    font-size: 1.5rem;
    line-height: 1.3;
  }
  
  .description-container :global(.terminal) {
    font-family: 'Exo', 'Courier New', monospace;
    font-size: 1.7rem;
    color: var(--text-color);
  }
  
  .description-container :global(.scrambling) {
    color: #00ff88;
    font-weight: bold;
  }

  .app-grid-container {
    width: 100%;
    max-width: 1400px;
    margin: 0 auto;
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .app-row {
    display: flex;
    justify-content: center;
    gap: 1.5rem;
  }

  .app-button {
    width: 120px;
    height: 120px;
    padding: 0.75rem;
    background-color: var(--surface-color);
    border: none;
    border-radius: 22px;
    color: var(--text-color);
    cursor: pointer;
    transition: all 0.2s ease;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    position: relative;
  }

  .app-button:hover {
    transform: scale(1.05) translateY(-3px);
    background-color: #3a3a3a; /* Lighter color on hover */
    box-shadow: 0 8px 15px rgba(0, 0, 0, 0.2);
  }

  /* Special gold border for desktop app */
  .app-button.gold-border {
    border: 2px solid #ffd700;
    background: linear-gradient(145deg, #2c2c2c 0%, #3a3a3a 100%);
    position: relative;
    overflow: hidden;
  }

  .app-button.gold-border::before {
    content: '';
    position: absolute;
    top: 0;
    left: -100%;
    width: 100%;
    height: 100%;
    background: linear-gradient(90deg, transparent, rgba(255, 215, 0, 0.1), transparent);
    animation: shimmer 3s infinite;
  }

  .app-button.gold-border:hover {
    border-color: #ffed4e;
    box-shadow: 0 8px 15px rgba(255, 215, 0, 0.3), 0 0 20px rgba(255, 215, 0, 0.2);
    background: linear-gradient(145deg, #3a3a3a 0%, #4a4a4a 100%);
  }

  @keyframes shimmer {
    0% { left: -100%; }
    100% { left: 100%; }
  }

  /* Add active state for click feedback */
  .app-button:active {
    transform: scale(1.02) translateY(-1px);
    box-shadow: 0 6px 12px rgba(0, 0, 0, 0.15);
  }

  .star-icon {
    position: absolute;
    top: 8px;
    right: 8px;
    transition: opacity 0.2s ease;
    z-index: 2;
    opacity: 0;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
  }

  /* Show star on hover for desktop */
  .app-button:hover .star-icon {
    opacity: 0.8;
  }

  /* Always show star for mobile */
  :global(.mobile) .star-icon {
    opacity: 0.5;
  }

  .star-icon.starred {
    opacity: 1 !important; /* Use !important to ensure starred icons are always visible */
  }

  .app-icon {
    font-size: 2.5rem;
    margin-bottom: 0.5rem;
  }

  /* Add this style for image icons */
  .app-icon img {
    width: 2.5rem;
    height: 2.5rem;
    object-fit: contain;
  }

  .app-name {
    font-size: 0.85rem;
    font-weight: 500;
    text-align: center;
    width: 100%;
    white-space: normal;
    line-height: 1.2;
  }

  .menu-button, .back-button {
    background: none;
    border: none;
    cursor: pointer;
    padding: 0.5rem;
    color: var(--text-color);
    transition: color 0.3s ease;
  }

  .menu-button:hover, .back-button:hover {
    color: var(--primary-color);
  }

  .back-button {
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 8px;
    transition: all 0.3s ease;
  }

  .back-button:hover {
    background-color: rgba(255, 255, 255, 0.1);
    transform: translateX(-2px);
  }

  .menu-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background-color: rgba(0, 0, 0, 0.5);
    display: flex;
    justify-content: flex-end;
    z-index: 2000;
  }

  .menu-content {
    background-color: var(--surface-color);
    width: 300px;
    height: 100%;
    padding: 2rem;
    overflow-y: auto;
  }

  .menu-item {
    display: flex;
    align-items: center;
    padding: 1rem;
    width: 100%;
    background: none;
    border: none;
    color: var(--text-color);
    cursor: pointer;
    transition: background-color 0.3s ease;
  }

  .menu-item:hover {
    background-color: rgba(255, 255, 255, 0.1);
  }

  .menu-item .app-icon {
    margin-right: 1rem;
    font-size: 1.5rem;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
  }

  .menu-icon-img {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  .menu-item .app-name {
    font-size: 1rem;
  }

  @media (max-width: 1200px) {
    .app-grid-container {
      max-width: 1000px;
    }
  }

  @media (max-width: 900px) {
    .app-grid-container {
      max-width: 800px;
    }
  }

  @media (max-width: 600px) {
    .app-row {
      gap: 1rem;
    }

    .app-button {
      width: 100px;
      height: 100px;
    }
  }

  .app-loading-skeleton {
    padding: 1rem;
    max-width: 650px;
    margin: 0 auto;
  }

  .skeleton-logo-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    margin-bottom: 2rem;
    gap: 1rem;
  }

  .skeleton-logo {
    height: 3rem;
    width: auto;
    opacity: 0.8;
    animation: logoPulse 2s ease-in-out infinite;
  }

  .skeleton-logo-bar {
    width: 120px;
  }

  @keyframes logoPulse {
    0%, 100% {
      opacity: 0.6;
      transform: scale(1);
    }
    50% {
      opacity: 1;
      transform: scale(1.02);
    }
  }

  .skeleton-content {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 1rem;
  }

  .skeleton-card {
    background: linear-gradient(145deg, #2c2c2c 0%, #3a3a3a 100%);
    border-radius: 12px;
    padding: 16px;
    height: 120px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 12px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.15);
  }

  @media (max-width: 600px) {
    .skeleton-content {
      grid-template-columns: 1fr;
    }
  }

  .holiday-logo {
    height: 2rem;
    width: auto;
    max-width: 100%;
    transform: scale(1.1);
  }

  .logo-wrapper:hover .holiday-logo {
    transform: scale(1.1);
  }

  :global(:root) {
    --banner-height: 24px; /* Height of banner */
  }

  @media (max-width: 600px) {
    :global(:root) {
      --banner-height: 22px;
    }
  }

  /* Add mobile class when isMobile is true */
  main.mobile {
    /* existing styles */
  }

  /* ---- TERMINAL HOME ---- */
  .terminal-home {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: calc(100vh - 120px);
    padding: 2rem 1rem;
    gap: 40px;
  }

  .terminal-hero {
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }

  .hero-sigil {
    font-size: 48px;
    color: #00cc66;
    line-height: 1;
    margin-bottom: 8px;
    text-shadow: 0 0 30px rgba(0, 204, 102, 0.3);
    animation: sigil-glow 3s ease-in-out infinite alternate;
  }

  @keyframes sigil-glow {
    from { text-shadow: 0 0 20px rgba(0, 204, 102, 0.2); }
    to { text-shadow: 0 0 40px rgba(0, 204, 102, 0.4), 0 0 80px rgba(0, 204, 102, 0.1); }
  }

  .hero-title {
    font-family: 'JetBrains Mono', monospace;
    font-size: 32px;
    font-weight: 800;
    color: #e0e0e0;
    letter-spacing: 0.15em;
    margin: 0;
    line-height: 1;
  }

  .hero-dot {
    color: #00cc66;
  }

  .hero-sub {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.3em;
    color: #444;
    margin-top: 4px;
  }

  .terminal-nav {
    width: 100%;
    max-width: 520px;
  }

  .nav-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding: 0 0 10px 0;
    border-bottom: 1px solid #1a1a1a;
    margin-bottom: 2px;
  }

  .nav-label {
    font-family: 'JetBrains Mono', monospace;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.12em;
    color: #666;
  }

  .nav-hint {
    font-family: 'JetBrains Mono', monospace;
    font-size: 9px;
    color: #333;
  }

  .nav-row {
    display: flex;
    align-items: center;
    gap: 14px;
    width: 100%;
    padding: 16px 16px;
    background: transparent;
    border: none;
    border-bottom: 1px solid #111;
    color: #c8c8c8;
    cursor: pointer;
    transition: all 0.15s ease;
    text-align: left;
    font-family: inherit;
  }

  .nav-row:hover {
    background: #0d0d0d;
    border-bottom-color: #1a1a1a;
  }

  .nav-row:hover .nav-name {
    color: #00cc66;
  }

  .nav-row:hover .nav-arrow {
    color: #00cc66;
    transform: translateX(4px);
  }

  .nav-index {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    font-weight: 600;
    color: #333;
    min-width: 16px;
  }

  .nav-icon {
    font-size: 20px;
    min-width: 24px;
    text-align: center;
  }

  .nav-info {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }

  .nav-name {
    font-family: 'JetBrains Mono', monospace;
    font-size: 14px;
    font-weight: 600;
    color: #ccc;
    transition: color 0.15s;
  }

  .nav-desc {
    font-family: 'DM Sans', sans-serif;
    font-size: 12px;
    color: #555;
    line-height: 1.3;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .nav-arrow {
    font-family: 'JetBrains Mono', monospace;
    font-size: 16px;
    color: #222;
    transition: all 0.15s;
    flex-shrink: 0;
  }

  .terminal-status {
    display: flex;
    align-items: center;
    gap: 8px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    color: #333;
  }

  .status-dot {
    display: inline-block;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: #00cc66;
    box-shadow: 0 0 6px rgba(0, 204, 102, 0.4);
    margin-right: 4px;
    vertical-align: middle;
    animation: pulse-dot 2s infinite;
  }

  @keyframes pulse-dot {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  .status-sep {
    color: #1a1a1a;
  }

  @media (max-width: 600px) {
    .hero-title {
      font-size: 24px;
    }

    .hero-sigil {
      font-size: 36px;
    }

    .terminal-nav {
      max-width: 100%;
    }

    .nav-desc {
      display: none;
    }

    .nav-row {
      padding: 14px 12px;
    }
  }
</style>
