<script>
  export let tone = 'info';
  export let tag = '';

  $: resolvedTag = tag || (tone === 'err' ? 'ERR' : tone === 'warn' ? 'WRN' : 'INF');
</script>

<div class="alert {tone}">
  <span class="alert-tag">{resolvedTag}</span>
  <span><slot /></span>
</div>

<style>
  .alert {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    border: 1px solid;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
  }

  .alert.err {
    border-color: rgba(220, 53, 69, 0.4);
    background: rgba(220, 53, 69, 0.06);
    color: #f08089;
  }

  .alert.warn {
    border-color: rgba(212, 160, 23, 0.4);
    background: rgba(212, 160, 23, 0.06);
    color: #e8c068;
  }

  .alert.info {
    border-color: rgba(85, 136, 204, 0.4);
    background: rgba(85, 136, 204, 0.06);
    color: #80a8dc;
  }

  .alert-tag {
    font-weight: 700;
    letter-spacing: 0.1em;
    flex-shrink: 0;
  }
</style>
