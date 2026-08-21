<script>
  import { onDestroy } from 'svelte';
  import CopyIcon from '$lib/components/CopyIcon.svelte';
  import { copyToClipboard } from '$lib/utils/formatting';

  export let voteKey = '';
  export let keyLabel = 'vote key';

  let copyStatus = 'idle';
  let resetTimer = null;

  $: feedbackLabel = keyLabel.charAt(0).toUpperCase() + keyLabel.slice(1);

  $: buttonLabel = copyStatus === 'copied'
    ? `${feedbackLabel} copied: ${voteKey}`
    : copyStatus === 'failed'
      ? `Could not copy ${keyLabel}: ${voteKey}`
      : `Copy ${keyLabel}: ${voteKey}`;

  $: feedback = copyStatus === 'copied'
    ? `${feedbackLabel} copied`
    : copyStatus === 'failed'
      ? `Could not copy ${keyLabel}`
      : '';

  async function handleCopy(event) {
    event.stopPropagation();
    clearTimeout(resetTimer);

    const copied = await copyToClipboard(voteKey);
    copyStatus = copied ? 'copied' : 'failed';
    resetTimer = setTimeout(() => {
      copyStatus = 'idle';
    }, 1800);
  }

  onDestroy(() => clearTimeout(resetTimer));
</script>

<button
  type="button"
  class="vote-key-copy"
  class:copied={copyStatus === 'copied'}
  class:failed={copyStatus === 'failed'}
  disabled={!voteKey}
  aria-label={buttonLabel}
  title={buttonLabel}
  on:click={handleCopy}
>
  {#if copyStatus === 'copied'}
    <span class="result" aria-hidden="true">✓</span>
  {:else if copyStatus === 'failed'}
    <span class="result" aria-hidden="true">!</span>
  {:else}
    <CopyIcon size={11} />
  {/if}
  <span class="sr-only" aria-live="polite">{feedback}</span>
</button>

<style>
  .vote-key-copy {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 22px;
    height: 20px;
    padding: 0 4px;
    border: 1px solid var(--border, #1a1a1a);
    background: transparent;
    color: var(--muted, #b8b8b8);
    font: 800 10px/1 'JetBrains Mono', monospace;
    cursor: pointer;
    flex: 0 0 auto;
  }

  .vote-key-copy:hover,
  .vote-key-copy:focus-visible,
  .vote-key-copy.copied {
    border-color: var(--accent, #00cc66);
    color: var(--accent, #00cc66);
    outline: none;
  }

  .vote-key-copy.failed {
    border-color: var(--err, #dc3545);
    color: var(--err, #dc3545);
  }

  .vote-key-copy:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .result {
    min-width: 11px;
    text-align: center;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
