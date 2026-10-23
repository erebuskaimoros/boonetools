<script>
  import { searchTools } from './search.js';
  export let apps = [];
  export let activePath = '';
  export let query = '';
  export let compact = false;
  export let mobile = false;
  export let onSelect = (app) => {};
  export let onExpandSearch = () => {};
  export let onClose = () => {};
  let input, list;
  $: results = compact ? apps : searchTools(apps, query);
  $: searching = !compact && query.trim().length > 0;
  const id = () => mobile ? 'mobile-tool-results' : 'sidebar-tool-results';

  export function focusSearch() { input?.focus(); input?.select(); }
  function clear() { query = ''; input?.focus(); }
  function inputKey(event) {
    if (event.isComposing) return;
    if (event.key === 'Enter' && searching && results.length) {
      event.preventDefault();
      onSelect(results[0]);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const buttons = list?.querySelectorAll('button');
      buttons?.[event.key === 'ArrowDown' ? 0 : buttons.length - 1]?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (query) clear(); else onClose();
    }
  }
  function resultKey(event, index) {
    const buttons = list?.querySelectorAll('button');
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = index + (event.key === 'ArrowDown' ? 1 : -1);
      if (next < 0 || next >= results.length) input?.focus();
      else buttons?.[next]?.focus();
    } else if (event.key === 'Escape' && !compact) {
      event.preventDefault();
      clear();
    }
  }
</script>

<div class="tool-navigation" class:compact class:mobile>
  {#if compact}
    <button class="expand-search" on:click={onExpandSearch} aria-label="Search pages" title="Search pages (Ctrl/Cmd+K)">[/]</button>
  {:else}
    <div class="search-box">
      <span class="search-prompt" aria-hidden="true">/</span>
      <input bind:this={input} bind:value={query} type="search" aria-label="Search pages"
        aria-controls={id()} placeholder="Find a page…" maxlength="96" autocomplete="off" spellcheck={false}
        on:keydown={inputKey} />
      {#if query}<button class="clear-search" on:click={clear} aria-label="Clear page search">×</button>{/if}
    </div>
    {#if searching}
      <div class="search-note" role="status" aria-live="polite">
        {results.length} {results.length === 1 ? 'page' : 'pages'} found
      </div>
    {/if}
  {/if}
  <nav bind:this={list} id={id()} aria-label="Tools" class="tool-list">
    {#each results as app (app.path)}
      {@const isActive = activePath === app.path}
      <button class="tool-item" class:active={isActive} on:click={() => onSelect(app)}
        on:keydown={event => resultKey(event, results.indexOf(app))}
        aria-current={isActive ? 'page' : undefined} title={compact ? app.name : app.description}>
        {#if compact}
          <span class="item-index">{String(apps.indexOf(app) + 1).padStart(2, '0')}</span>
        {:else}
          <span class="item-prompt" aria-hidden="true">{isActive ? '$' : '>'}</span>
          <span class="item-copy"><span class="item-name">{app.path}</span>
            {#if searching}<span class="item-description">{app.description}</span>{/if}
          </span>
        {/if}
      </button>
    {/each}
    {#if searching && !results.length}
      <p class="empty">No pages match “{query}”. Try a page name or a topic like fees, bonds, or pools.</p>
    {/if}
  </nav>
</div>

<style>
  .tool-navigation { display: flex; flex-direction: column; min-height: 0; flex: 1; }
  .search-box { display: flex; align-items: center; gap: 6px; margin: 4px 12px 0; border: 1px solid var(--term-border); background: var(--term-bg); min-height: 34px; padding-left: 9px; }
  .search-box:focus-within { border-color: var(--term-accent); }
  .search-prompt { font: 12px var(--term-font-mono); color: var(--term-accent); }
  input { width: 100%; min-width: 0; padding: 8px 0; border: 0; outline: 0; border-radius: 0; background: transparent; color: var(--term-text); font: 12px var(--term-font-mono); }
  input::placeholder { color: var(--term-text-5); opacity: 1; }
  input::-webkit-search-cancel-button { display: none; }
  .clear-search, .expand-search { border: 0; border-radius: 0; background: transparent; color: var(--term-text-3); cursor: pointer; font: 14px var(--term-font-mono); min-height: 32px; padding: 4px 10px; }
  .expand-search { width: 100%; font-size: 12px; margin-bottom: 4px; }
  .clear-search:hover, .expand-search:hover { color: var(--term-accent); }
  .search-note { padding: 6px 13px 8px; font: 11px var(--term-font-mono); color: var(--term-text-5); }
  .tool-list { flex: 1; min-height: 0; overflow-y: auto; padding: 2px 0 8px; }
  .tool-item { display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 14px 9px 12px; background: transparent; border: 0; border-left: 2px solid transparent; color: var(--term-text-2); cursor: pointer; text-align: left; }
  .tool-item:hover { background: var(--term-surface-hover); color: var(--term-text); }
  .tool-item.active { border-left-color: var(--term-accent); background: var(--term-accent-soft); color: var(--term-accent); }
  button:focus-visible { outline: 1px solid var(--term-accent); outline-offset: -2px; background: var(--term-surface-hover); }
  .item-prompt { width: 12px; flex-shrink: 0; color: var(--term-text-5); font: 700 12px var(--term-font-mono); }
  .tool-item:hover .item-prompt, .tool-item.active .item-prompt { color: var(--term-accent); }
  .item-copy { min-width: 0; }
  .item-name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 600 12px/var(--term-leading-compact) var(--term-font-mono); letter-spacing: 0.02em; }
  .item-description { display: block; margin-top: 5px; color: var(--term-text-4); font: 11px/1.5 var(--term-font-mono); }
  .item-index { font: 600 11px var(--term-font-mono); color: var(--term-text-6); }
  .compact .tool-item { justify-content: center; padding: 9px 0; gap: 0; }
  .compact .active .item-index { color: var(--term-accent); }
  .empty { margin: 8px 14px; color: var(--term-text-3); font: 12px/1.6 var(--term-font-mono); overflow-wrap: anywhere; }
  .mobile { flex: none; }
  .mobile .search-box { margin-top: 12px; }
  .mobile input { font-size: 16px; }
  .mobile .clear-search { min-width: 44px; min-height: 44px; }
  .mobile .tool-item { gap: 12px; padding: 13px 16px 13px 14px; border-bottom: 1px solid var(--term-border-faint); }
  .mobile .item-name, .mobile .item-prompt { font-size: 13px; }
</style>
