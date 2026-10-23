const normalize = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Small, local catalog: tolerate missing letters and adjacent transpositions
// without adding a search dependency or sending queries to a server.
function distance(a, b) {
  const matrix = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        matrix[i][j] = Math.min(matrix[i][j], matrix[i - 2][j - 2] + 1);
      }
    }
  }
  return matrix[a.length][b.length];
}

function wordScore(query, word, fuzzy) {
  if (word === query) return 0;
  if (word.startsWith(query)) return 1;
  if (word.includes(query)) return 3;
  if (!fuzzy || query.length < 3) return Infinity;
  const allowance = query.length >= 6 ? 2 : 1;
  if (Math.abs(word.length - query.length) <= allowance) {
    const edits = distance(query, word);
    if (edits <= allowance) return 5 + edits;
  }
  // Subsequence abbreviations apply only to names, not long descriptions.
  let index = 0;
  for (const character of word) if (character === query[index]) index++;
  return index === query.length && word.length <= query.length * 2 ? 8 + (word.length - query.length) : Infinity;
}

/** Rank only the supplied public navigation catalog; never import tool modules. */
export function searchTools(apps, value) {
  const query = normalize(String(value || '').slice(0, 96));
  if (!query) return [...apps];
  const terms = query.split(' ');
  return apps.map((app, order) => {
    const names = [normalize(app.path), normalize(app.name), ...(app.keywords || []).map(normalize)];
    const primaryWords = names.flatMap(name => name.split(' '));
    const descriptionWords = normalize(app.description).split(' ');
    let score = terms.reduce((sum, term) => sum + Math.min(
      ...primaryWords.map(word => wordScore(term, word, true)),
      ...descriptionWords.map(word => wordScore(term, word, false) + 12)
    ), 0);
    // Exact names, route fragments, and initials rank ahead of incidental prose.
    if (names.includes(query)) score = -30;
    else if (names.some(name => name.startsWith(query))) score = Math.min(score, -20);
    else if (names.some(name => name.includes(query))) score = Math.min(score, -10);
    else if (terms.length === 1 && query.length > 1 && names.some(name => {
      const words = name.split(' ');
      return words.map(word => word[0]).join('') === query ||
        words.map(word => word.length <= 2 ? word : word[0]).join('') === query;
    })) score = -5;
    return { app, order, score };
  }).filter(result => Number.isFinite(result.score))
    .sort((a, b) => a.score - b.score || a.order - b.order).map(result => result.app);
}

/** Slash must never hijack typing or modified browser shortcuts. */
export function isNavigationSearchShortcut(event) {
  if (event.defaultPrevented || event.isComposing || event.repeat || event.altKey || event.shiftKey) return false;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') return true;
  if (event.metaKey || event.ctrlKey || event.key !== '/') return false;
  return !event.target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"]');
}
