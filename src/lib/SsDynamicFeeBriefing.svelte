<script>
  import reportMarkdown from '../../docs/ss-dynamic-fee-impact.md?raw';

  export let assetRoot;
  export let briefingsRoot;
  export let navigate;

  const SOURCE_ROOT = 'https://github.com/erebuskaimoros/boonetools/blob/main/';

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function normalizeHref(href) {
    if (/^https?:\/\//.test(href)) return href;
    if (href.startsWith('./ss-dynamic-fee-charts/')) {
      return `${assetRoot}/${href.slice('./ss-dynamic-fee-charts/'.length)}`;
    }
    if (href.startsWith('./')) return `${SOURCE_ROOT}docs/${href.slice(2)}`;
    if (href.startsWith('../')) return `${SOURCE_ROOT}${href.slice(3)}`;
    return href;
  }

  function renderInline(value) {
    const tokens = [];
    const token = (html) => {
      const key = `\u0000INLINE${tokens.length}\u0000`;
      tokens.push(html);
      return key;
    };

    let rendered = String(value)
      .replace(/`([^`]+)`/g, (_, code) => token(`<code>${escapeHtml(code)}</code>`))
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
        const resolved = normalizeHref(href);
        const external = /^https?:\/\//.test(resolved) ? ' target="_blank" rel="noreferrer"' : '';
        return token(`<a href="${escapeHtml(resolved)}"${external}>${renderInline(label)}</a>`);
      });

    rendered = escapeHtml(rendered)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');

    tokens.forEach((html, index) => {
      rendered = rendered.replace(`\u0000INLINE${index}\u0000`, html);
    });
    return rendered;
  }

  function isTableDivider(line) {
    return /^\|(?:\s*:?-+:?\s*\|)+$/.test(line.trim());
  }

  function tableCells(line) {
    return line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
  }

  function isBlockStart(line) {
    const trimmed = line.trim();
    return /^#{1,3}\s/.test(trimmed)
      || trimmed.startsWith('|')
      || trimmed.startsWith('- ')
      || trimmed.startsWith('```')
      || /^!\[[^\]]*\]\([^)]+\)$/.test(trimmed);
  }

  function paragraphHtml(lines) {
    let output = '';
    lines.forEach((line, index) => {
      const hardBreak = /\s{2}$/.test(line);
      output += renderInline(line.replace(/\s{2}$/, ''));
      if (index < lines.length - 1) output += hardBreak ? '<br>' : ' ';
    });
    return `<p>${output}</p>`;
  }

  function slugify(value) {
    return value
      .replace(/[*`]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }

  function renderMarkdown(markdown) {
    const lines = markdown.replace(/\r\n/g, '\n').split('\n');
    const blocks = [];

    for (let index = 0; index < lines.length;) {
      const line = lines[index];
      const trimmed = line.trim();

      if (!trimmed) {
        index += 1;
        continue;
      }

      const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
      if (heading) {
        const level = heading[1].length;
        blocks.push(`<h${level} id="${slugify(heading[2])}">${renderInline(heading[2])}</h${level}>`);
        index += 1;
        continue;
      }

      if (trimmed.startsWith('```')) {
        const language = trimmed.slice(3).trim();
        const code = [];
        index += 1;
        while (index < lines.length && !lines[index].trim().startsWith('```')) {
          code.push(lines[index]);
          index += 1;
        }
        index += 1;
        blocks.push(`<pre><code${language ? ` class="language-${escapeHtml(language)}"` : ''}>${escapeHtml(code.join('\n'))}</code></pre>`);
        continue;
      }

      const image = trimmed.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
      if (image) {
        blocks.push(`<figure><img src="${escapeHtml(normalizeHref(image[2]))}" alt="${escapeHtml(image[1])}"></figure>`);
        index += 1;
        continue;
      }

      if (trimmed.startsWith('|') && index + 1 < lines.length && isTableDivider(lines[index + 1])) {
        const headers = tableCells(line);
        const rows = [];
        index += 2;
        while (index < lines.length && lines[index].trim().startsWith('|')) {
          rows.push(tableCells(lines[index]));
          index += 1;
        }
        const head = headers.map((cell) => `<th>${renderInline(cell)}</th>`).join('');
        const body = rows.map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join('')}</tr>`).join('');
        blocks.push(`<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`);
        continue;
      }

      if (trimmed.startsWith('- ')) {
        const items = [];
        while (index < lines.length && lines[index].trim().startsWith('- ')) {
          items.push(`<li>${renderInline(lines[index].trim().slice(2))}</li>`);
          index += 1;
        }
        blocks.push(`<ul>${items.join('')}</ul>`);
        continue;
      }

      const paragraph = [line];
      index += 1;
      while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index])) {
        paragraph.push(lines[index]);
        index += 1;
      }
      blocks.push(paragraphHtml(paragraph));
    }

    return blocks.join('\n');
  }

  const reportHtml = renderMarkdown(reportMarkdown);
</script>

<article class="briefings-page report-page full-report-page">
  <nav class="breadcrumbs" aria-label="Breadcrumb">
    <a href={briefingsRoot} on:click={(event) => navigate(event)}>briefings</a>
    <span>/</span>
    <span>ss-dynamic-fee-impact</span>
  </nav>

  <div class="head-top">
    <div class="command-line"><span class="prompt">$</span> <span class="cmd">read</span> <span class="arg">./briefings/ss-dynamic-fee-impact.md</span></div>
    <span class="status"><span class="status-dot"></span> PUBLISHED</span>
  </div>

  <div class="markdown-report">{@html reportHtml}</div>

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
  .back-link {
    font-family: 'JetBrains Mono', monospace;
  }

  .breadcrumbs {
    display: flex;
    gap: 8px;
    margin-bottom: 20px;
    color: var(--term-text-5);
    font-size: 12px;
  }

  .breadcrumbs a,
  .back-link,
  :global(.markdown-report a) {
    color: #00cc66;
    text-decoration-color: rgba(0, 204, 102, 0.45);
    text-underline-offset: 3px;
  }

  .breadcrumbs span:last-child {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .head-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 18px;
  }

  .command-line {
    color: var(--term-text-2);
    font-size: 12px;
    font-weight: 600;
  }

  .prompt {
    color: #00cc66;
    font-weight: 700;
  }

  .cmd {
    color: var(--term-text-body, #e8e8e8);
    font-weight: 700;
  }

  .arg {
    color: var(--term-text-3);
  }

  .status {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 3px 8px;
    border: 1px solid #1a1a1a;
    border-radius: 999px;
    color: var(--term-text-3);
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

  .markdown-report {
    border-top: 1px solid #1a1a1a;
  }

  :global(.markdown-report h1) {
    margin: 28px 0 14px;
    color: var(--term-text, #f5f5f5);
    font-family: 'JetBrains Mono', monospace;
    font-size: clamp(24px, 4vw, 34px);
    font-weight: 800;
    line-height: 1.18;
    letter-spacing: 0.03em;
  }

  :global(.markdown-report h2) {
    margin: 34px 0 14px;
    padding: 14px 16px;
    border: 1px solid #1a1a1a;
    border-left: 3px solid #00cc66;
    background: #0a0a0a;
    color: var(--term-text, #f5f5f5);
    font-family: 'JetBrains Mono', monospace;
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  :global(.markdown-report h3) {
    margin: 26px 0 10px;
    color: #d8d8d8;
    font-family: 'JetBrains Mono', monospace;
    font-size: 14px;
    font-weight: 700;
    letter-spacing: 0.04em;
  }

  :global(.markdown-report p),
  :global(.markdown-report li) {
    color: var(--term-text-body);
    font-size: 15px;
    line-height: 1.72;
  }

  :global(.markdown-report p) {
    margin: 0 0 14px;
  }

  :global(.markdown-report strong) {
    color: var(--term-text, #f5f5f5);
    font-weight: 700;
  }

  :global(.markdown-report em) {
    color: var(--term-text-3);
  }

  :global(.markdown-report ul) {
    margin: 10px 0 18px;
    padding-left: 22px;
  }

  :global(.markdown-report li + li) {
    margin-top: 5px;
  }

  :global(.markdown-report li::marker) {
    color: #00cc66;
  }

  :global(.markdown-report code) {
    padding: 1px 5px;
    border: 1px solid #1a1a1a;
    background: #111;
    color: #00cc66;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.9em;
  }

  :global(.markdown-report pre) {
    margin: 14px 0 20px;
    padding: 16px;
    overflow-x: auto;
    border: 1px solid #1a1a1a;
    background: #080808;
  }

  :global(.markdown-report pre code) {
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--term-text-body, #e8e8e8);
    line-height: 1.7;
  }

  :global(.markdown-report .table-wrap) {
    margin: 14px 0 22px;
    overflow-x: auto;
    border: 1px solid #1a1a1a;
    background: #0a0a0a;
  }

  :global(.markdown-report table) {
    width: 100%;
    min-width: 660px;
    border-collapse: collapse;
    color: var(--term-text-2);
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
  }

  :global(.markdown-report th),
  :global(.markdown-report td) {
    padding: 11px 13px;
    border-bottom: 1px solid #151515;
    text-align: right;
    white-space: nowrap;
  }

  :global(.markdown-report th:first-child),
  :global(.markdown-report td:first-child) {
    text-align: left;
  }

  :global(.markdown-report th) {
    color: var(--term-text-3);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  :global(.markdown-report tbody tr:last-child td) {
    border-bottom: 0;
  }

  :global(.markdown-report figure) {
    margin: 16px 0 10px;
    overflow-x: auto;
    border: 1px solid #151515;
    background: #080808;
  }

  :global(.markdown-report figure img) {
    display: block;
    width: 100%;
    min-width: 960px;
    height: auto;
  }

  .back-link {
    display: inline-block;
    margin-top: 28px;
    color: var(--term-text-4, #bcbcbc);
    font-size: 12px;
    font-weight: 600;
    text-decoration: none;
  }

  .back-link span {
    color: #00cc66;
  }

  @media (max-width: 700px) {
    .briefings-page {
      width: calc(100% - 28px);
      padding-top: 20px;
    }

    .head-top {
      align-items: flex-start;
    }

    .status {
      flex-shrink: 0;
    }

    :global(.markdown-report h1) {
      font-size: 24px;
    }

    :global(.markdown-report h2) {
      margin-top: 28px;
      font-size: 13px;
    }

    :global(.markdown-report p),
    :global(.markdown-report li) {
      font-size: 14px;
    }
  }
</style>
