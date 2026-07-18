<script>
  import { onMount, onDestroy } from 'svelte';
  import { fade, slide } from 'svelte/transition';
  import { cubicInOut } from 'svelte/easing';

  const emojis = ['🫡', '✍️', '💪', '🧙‍♂️', '🕺', '🏃‍♂️‍➡️', '🦅', '🐋', '🐉', '⚡️', '🌊', '🍷', '🍻', '🏄‍♂️', '🏆', '🎸', '🚀', '🗿', '🗽', '🏗️', '📠', '🔌', '🔮', '🔭', '💯', '🏴‍☠️', '🥷', '👑', '🪐', '🍦', '🍾', '🎯', '❤️', '☑️', '🆒'];

  function getRandomEmoji() {
    return emojis[Math.floor(Math.random() * emojis.length)];
  }

  let clipboardToast = false;
  let clipboardTimer;
  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      clipboardToast = true;
      clearTimeout(clipboardTimer);
      clipboardTimer = setTimeout(() => { clipboardToast = false; }, 2000);
    } catch (_) {}
  }

  let randomEmoji;
  let currentPage = 0;
  let startX = 0;
  let startY = 0;
  let isDragging = false;
  let totalPages = 1;
  let autoScrollTimer;
  let isUserInteracting = false;

  const FIRST_PAGE_DURATION = 15000;  // 15 seconds
  const OTHER_PAGE_DURATION = 10000;  // 10 seconds

  const pages = [
    {
      content: {
        type: 'links',
        elements: [
          { href: "https://github.com/erebuskaimoros/boonetools", text: "Source" },
          { text: " by " },
          { href: "https://x.com/boonew", text: "boonew" },
          { text: " | " },
          { href: "https://thordex.eth.limo/?ref=boone", text: "Swap on THORDEX 📈" },
          { text: " | Tip Jar 🫙: " },
          { text: "thor194zytw9em6950gym75psq5qt6f2mt2le2nnnt8", clipboard: "thor194zytw9em6950gym75psq5qt6f2mt2le2nnnt8" }
        ]
      }
    }
  ];

  totalPages = pages.length;

  function startAutoScroll() {
    clearTimeout(autoScrollTimer);
    const duration = currentPage === 0 ? FIRST_PAGE_DURATION : OTHER_PAGE_DURATION;
    
    autoScrollTimer = setTimeout(() => {
      if (!isUserInteracting) {
        if (currentPage < totalPages - 1) {
          currentPage++;
          startAutoScroll(); // Schedule next scroll
        } else {
          currentPage = 0; // Reset to first page
          startAutoScroll(); // Restart cycle
        }
      }
    }, duration);
  }

  function handleUserInteraction() {
    isUserInteracting = true;
    clearTimeout(autoScrollTimer);
    
    // Reset auto-scroll after 30 seconds of no interaction
    setTimeout(() => {
      isUserInteracting = false;
      startAutoScroll();
    }, 30000);
  }

  function handleTouchStart(e) {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    isDragging = true;
    handleUserInteraction();
  }

  function handleTouchMove(e) {
    if (!isDragging) return;
    
    const currentX = e.touches[0].clientX;
    const currentY = e.touches[0].clientY;
    const diffX = startX - currentX;
    const diffY = startY - currentY;
    
    // If horizontal movement is greater than vertical, handle as horizontal swipe
    if (Math.abs(diffX) > Math.abs(diffY)) {
      if (Math.abs(diffX) > 20) {
        if (diffX > 0) {
          // Swipe left - next page
          currentPage = (currentPage + 1) % totalPages;
          isDragging = false;
        } else {
          // Swipe right - previous page
          currentPage = currentPage === 0 ? totalPages - 1 : currentPage - 1;
          isDragging = false;
        }
      }
    } else if (Math.abs(diffY) > 20) {
      // Handle vertical swipe as before
      if (diffY > 0) {
        currentPage = (currentPage + 1) % totalPages;
        isDragging = false;
      } else if (diffY < 0) {
        currentPage = currentPage === 0 ? totalPages - 1 : currentPage - 1;
        isDragging = false;
      }
    }
  }

  function handleTouchEnd() {
    isDragging = false;
  }

  function handleWheel(e) {
    handleUserInteraction();
    if (Math.abs(e.deltaY) > 10) {
      if (e.deltaY > 0) {
        currentPage = (currentPage + 1) % totalPages;
      } else if (e.deltaY < 0) {
        currentPage = currentPage === 0 ? totalPages - 1 : currentPage - 1;
      }
    }
  }

  // Add keyboard navigation
  function handleKeydown(e) {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      handleUserInteraction();
      if (e.key === 'ArrowDown') {
        currentPage = (currentPage + 1) % totalPages;
      } else {
        currentPage = currentPage === 0 ? totalPages - 1 : currentPage - 1;
      }
    }
  }

  function trackFooterClick(elementName) {
    if (typeof gtag !== 'undefined') {
      gtag('event', 'footer_click', {
        element_name: elementName
      });
    }
  }

  onMount(() => {
    randomEmoji = getRandomEmoji();
    startAutoScroll();
  });

  onDestroy(() => {
    clearTimeout(autoScrollTimer);
  });
</script>

<footer>
  <div
    class="page-container"
    role="button"
    tabindex="0"
    on:touchstart={handleTouchStart}
    on:touchmove={handleTouchMove}
    on:touchend={handleTouchEnd}
    on:wheel={handleWheel}
    on:mouseenter={handleUserInteraction}
    on:keydown={handleKeydown}
    on:click={() => {
      currentPage = (currentPage + 1) % totalPages;
      handleUserInteraction();
    }}
    aria-label="Navigate footer pages"
  >
    {#key currentPage}
      <div 
        class="page"
        in:slide={{ 
          duration: 300,
          easing: cubicInOut,
          axis: 'y'
        }}
      >
        {#if pages[currentPage].content.type === 'links'}
          <span>
            {#each pages[currentPage].content.elements as element}
              {#if element.href}
                <a 
                  href={element.href} 
                  target="_blank" 
                  class="source-link"
                  on:click|stopPropagation={() => trackFooterClick(element.text)}
                >
                  {element.text}
                </a>
              {:else if element.emoji}
                <span class="emoji-wrapper">
                  {getRandomEmoji()}
                </span>
              {:else if element.clipboard}
                <button
                  class="clipboard-btn"
                  on:click|stopPropagation={() => copyToClipboard(element.clipboard)}
                  title="Click to copy"
                >
                  {element.text}
                </button>
              {:else if element.onClick}
                <button
                  class="clickable-text"
                  on:click|stopPropagation={element.onClick}
                >
                  {element.text}
                </button>
              {:else}
                {element.text}
              {/if}
            {/each}
          </span>
        {:else if pages[currentPage].content.type === 'desktop-app'}
          <span>
            <a 
              href={pages[currentPage].content.href}
              class="source-link desktop-link"
              on:click|stopPropagation={() => trackFooterClick(pages[currentPage].content.text)}
            >
              {pages[currentPage].content.text}
            </a>
          </span>
        {/if}
      </div>
    {/key}
  </div>
  {#if clipboardToast}
    <div class="clipboard-toast" transition:fade={{ duration: 150 }}>Address copied!</div>
  {/if}
</footer>

<style>
  footer {
    padding: 0.5rem 1.5rem;
    background: rgba(44, 44, 44, 0.85);
    backdrop-filter: blur(10px);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
    user-select: none;
    touch-action: pan-x pan-y;
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    min-height: 32px;
    z-index: 100;
    border-top: 1px solid rgba(255, 255, 255, 0.05);
  }

  .page-container {
    position: relative;
    width: 100%;
    display: flex;
    justify-content: center;
    overflow: hidden;
    height: 24px;
    margin-top: 0;
    cursor: pointer;
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: inherit;
  }

  .page {
    width: 100%;
    text-align: center;
    font-size: 0.95rem;
    font-weight: 400;
    line-height: 24px;
    white-space: nowrap;
    overflow: hidden;
    color: rgba(255, 255, 255, 0.8);
    padding-right: 1.5rem;
  }

  footer span {
    color: rgba(255, 255, 255, 0.8);
  }

  .source-link,
  .source-link:visited,
  .source-link:active,
  .source-link:link {
    color: #31FD9D;
    text-decoration: none;
    font-weight: 600;
    transition: all 0.2s ease;
    opacity: 0.95;
  }

  .source-link:hover {
    opacity: 1;
    text-shadow: 0 0 8px rgba(49, 253, 157, 0.3);
  }

  .desktop-link {
    color: #ffd700 !important;
    font-weight: 700;
    animation: gold-glow 2s infinite alternate;
  }

  .desktop-link:hover {
    text-shadow: 0 0 12px rgba(255, 215, 0, 0.6) !important;
  }

  @keyframes gold-glow {
    from {
      text-shadow: 0 0 5px rgba(255, 215, 0, 0.3);
    }
    to {
      text-shadow: 0 0 10px rgba(255, 215, 0, 0.5);
    }
  }

  @media (max-width: 600px) {
    footer {
      padding: 0.25rem 1rem;
    }

    .page {
      font-size: 0.8rem;
      padding-right: 1rem;
      line-height: 20px;
    }
    
    .page-container {
      height: 20px;
    }
    
  }

  @media (max-width: 400px) {
    .page {
      font-size: 0.75rem;
      padding-right: 0.75rem;
    }
    
  }

  .emoji-wrapper {
    padding: 0 0.5rem;
    opacity: 0.9;
    transition: all 0.2s ease;
    display: inline;
  }

  .emoji-wrapper:hover {
    opacity: 1;
    transform: scale(1.1);
  }

  .clickable-text {
    cursor: pointer;
    color: #31FD9D;
    font-weight: 600;
    transition: all 0.2s ease;
    opacity: 0.95;
    background: none;
    border: none;
    padding: 0;
    font: inherit;
  }

  .clickable-text:hover {
    opacity: 1;
    text-shadow: 0 0 8px rgba(49, 253, 157, 0.3);
  }

  .clipboard-btn {
    cursor: pointer;
    color: inherit;
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    text-decoration: none;
  }
  .clipboard-btn:hover {
    color: #31FD9D;
  }

  .clipboard-toast {
    position: absolute;
    bottom: 100%;
    margin-bottom: 6px;
    background: #00cc66;
    color: #000;
    font-size: 11px;
    font-weight: 600;
    padding: 4px 12px;
    border-radius: 4px;
    pointer-events: none;
  }
</style>
