<script>
  import { createEventDispatcher, onMount } from 'svelte';
  import { resolveVoteKeyReference } from './key-reference.js';

  export let target;
  export let catalog = {};
  /** @type {import('./adr-preference.js').AdrPreference | null} */
  export let preference = null;
  const dispatch = createEventDispatcher();
  let dialog;
  let position = '';

  $: reference = resolveVoteKeyReference(target.key, catalog);

  function place() {
    if (!dialog) return;
    const anchor = target.trigger?.getBoundingClientRect();
    const margin = 16;
    const width = Math.min(480, window.innerWidth - margin * 2);
    // Measure at the final width: wrapping can change the height substantially.
    dialog.style.width = `${width}px`;
    const height = Math.min(dialog.scrollHeight + 2, window.innerHeight - margin * 2);
    const left = Math.max(margin, Math.min(anchor?.left ?? margin, window.innerWidth - width - margin));
    const top = window.innerWidth < 600 ? (window.innerHeight - height) / 2
      : Math.max(margin, Math.min((anchor?.bottom ?? margin) + 8, window.innerHeight - height - margin));
    position = `left:${left}px;top:${top}px;width:${width}px`;
  }

  function close() { dialog?.close(); }
  function keepFocus(event) {
    if (event.key !== 'Tab') return;
    const controls = [...dialog.querySelectorAll('button, a[href]')];
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }
  function backdrop(event) {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
  }

  onMount(() => {
    dialog.showModal();
    place();
    return () => {
      if (dialog?.open) dialog.close();
      // Native dialog restores focus on close; preserve it if the panel unmounts.
      if (target.trigger?.isConnected) target.trigger.focus({ preventScroll: true });
    };
  });
</script>

<svelte:window on:resize={place} />

<dialog bind:this={dialog} style={position} aria-labelledby="vote-reference-title" on:close={() => dispatch('close')} on:pointerdown={backdrop} on:keydown={keepFocus}>
  <header>
    <span>{reference.kind === 'adr' ? 'ADR REFERENCE' : reference.kind === 'upgrade' ? 'UPGRADE REFERENCE' : 'MIMIR REFERENCE'}</span>
    <button type="button" aria-label="Close vote key information" on:click={close}>[×] close</button>
  </header>
  <div class="body">
    <code class="key">{target.key}</code>
    <h2 id="vote-reference-title">{reference.title}</h2>
    {#if reference.status !== 'reviewed'}
      <span class="warning">{reference.status === 'unrecognized' ? 'UNRECOGNIZED IN REVIEWED CODE' : reference.status === 'generated' ? 'AI SUMMARY · NOT HUMAN REVIEWED' : 'NOT YET REVIEWED'}</span>
    {/if}
    <p>{reference.summary}</p>
    {#if reference.values}
      <h3>Value meaning</h3>
      <p>{reference.values}</p>
    {/if}
    {#if reference.note}<p class="note">{reference.note}</p>{/if}
    {#if reference.update_pending}<p class="note">An updated source check is pending. Showing the saved explanation and its source revision.</p>{/if}
    {#if preference && preference.variants.length > 1}
      <section aria-label="ADR key spelling comparison">
        <h3>Key spellings · active validators</h3>
        {#if !preference.complete}
          <p class="note">Current vote data is incomplete. No preferred spelling is selected.</p>
        {:else if preference.state === 'tied'}
          <p class="note">The lead is tied. No preferred spelling is selected.</p>
        {:else if preference.state === 'no-votes'}
          <p class="note">No current active-validator votes on these keys.</p>
        {/if}
        <ul>
          {#each preference.variants as variant}
            <li class:preferred={preference.preferred === variant.key}>
              <code>{variant.key}</code>
              <span>{preference.complete ? variant.count : '—'}{preference.preferred === variant.key ? ' · most voted' : ''}</span>
            </li>
          {/each}
        </ul>
        <p class="note">Each validator counts once per exact key, across vote values. This identifies the most-used spelling; votes and consensus remain separate.</p>
      </section>
    {/if}
    {#each reference.sources as link}
      <a href={link.url} target="_blank" rel="noopener noreferrer">{link.label} ↗</a>
    {/each}
    <footer>{reference.status === 'generated' ? 'Generated' : 'Reviewed'} {reference.review.date}{reference.kind !== 'adr' ? ` · THORNode ${reference.review.version}` : ''}</footer>
  </div>
</dialog>

<style>
  dialog {
    position: fixed;
    margin: 0;
    padding: 0;
    box-sizing: border-box;
    width: 480px;
    max-width: calc(100vw - 32px);
    max-height: calc(100dvh - 32px);
    overflow: auto;
    border: 1px solid var(--term-border-strong, #2a2a2a);
    border-top: 2px solid var(--accent, #00cc66);
    background: var(--term-surface, #0a0a0a);
    color: var(--term-text, #f5f5f5);
    font: 14px/1.6 'DM Sans', sans-serif;
  }
  dialog::backdrop { background: rgba(0, 0, 0, .4); }
  header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-bottom: 1px solid #1a1a1a; }
  header span, h3, footer { font: 600 10px/1.5 'JetBrains Mono', monospace; letter-spacing: .06em; }
  header span { color: var(--accent, #00cc66); }
  button { background: transparent; border: 1px solid #2a2a2a; padding: 5px 8px; color: #d8d8d8; font: 11px 'JetBrains Mono', monospace; cursor: pointer; }
  button:hover, button:focus-visible { outline: 1px solid var(--accent, #00cc66); color: var(--accent, #00cc66); }
  .body { padding: 16px; }
  .key { display: block; font-size: 11px; color: #bcbcbc; overflow-wrap: anywhere; }
  h2 { margin: 8px 0 12px; font: 700 16px/1.4 'JetBrains Mono', monospace; }
  h3 { margin: 16px 0 6px; color: #c8c8c8; text-transform: uppercase; }
  p { margin: 8px 0 12px; }
  .note { color: #bcbcbc; font-size: 12px; }
  .warning { color: var(--amber, #d4a017); font: 600 10px/1.5 'JetBrains Mono', monospace; }
  section { border-top: 1px solid #1a1a1a; margin-top: 16px; }
  ul { list-style: none; padding: 0; margin: 8px 0; }
  li { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; padding: 6px 8px; border-bottom: 1px solid #1a1a1a; font: 11px/1.5 'JetBrains Mono', monospace; }
  li.preferred { color: var(--accent, #00cc66); background: rgba(0, 204, 102, .07); }
  a { display: block; width: fit-content; margin-top: 12px; color: var(--accent, #00cc66); font: 11px/1.5 'JetBrains Mono', monospace; text-underline-offset: 3px; }
  a:focus-visible { outline: 1px solid var(--accent, #00cc66); outline-offset: 3px; }
  footer { margin-top: 16px; padding-top: 10px; border-top: 1px solid #1a1a1a; color: #a0a0a0; letter-spacing: 0; }
</style>
