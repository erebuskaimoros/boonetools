/**
 * Hide an image whose remote or optional asset failed to load.
 * @param {Event} event
 */
export function hideBrokenImage(event) {
  const image = /** @type {HTMLImageElement | null} */ (event.currentTarget || event.target);
  if (image) image.style.display = 'none';
}
