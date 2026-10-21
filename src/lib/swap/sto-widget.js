/**
 * swap.thorchain.org's embeddable swap widget, mounted the way its loader's
 * static mode does it: an iframe on STO's own origin. Framing the widget page
 * directly keeps STO's mutable loader script off boone.tools, which also holds
 * wallet sessions for Thorfolio and Limit Orders.
 */

import { writable } from 'svelte/store';

/** @type {Record<string, string | undefined>} */
const runtimeEnv = import.meta.env || {};

export const STO_WIDGET_ORIGIN = 'https://swap.thorchain.org';

/**
 * Affiliate key issued at swap.thorchain.org/affiliate. It is browser-visible
 * by design (STO's own loader puts it in the page); empty hides the launcher.
 */
export const STO_WIDGET_API_KEY = String(runtimeEnv.VITE_STO_WIDGET_API_KEY || '').trim();

/** Whether the footer swap panel is open; shared by the footer launcher and the panel. */
export const swapOpen = writable(false);

/** The site is dark-only, so the theme is pinned rather than detected from the host page. */
export function stoWidgetUrl(apiKey, { theme = 'dark', origin = STO_WIDGET_ORIGIN } = {}) {
  return `${origin}/widget?${new URLSearchParams({ apiKey, theme })}`;
}

/** A bare `s` toggles the panel, unless the person is typing or holding a modifier. */
export function isSwapShortcut(event) {
  if (String(event?.key || '').toLowerCase() !== 's' || event.metaKey || event.ctrlKey || event.altKey) return false;
  const target = event.target;
  const tag = target?.tagName;
  return !(tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable);
}
