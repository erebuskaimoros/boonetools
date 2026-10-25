import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const devDataCacheRoot = fileURLToPath(new URL('../', import.meta.url));

// Development observations belong to the checkout, not npm's disposable tree.
// Explicit custom files are left alone; only the default location is migrated.
export function createDevDataCache(relativeFile, { root = devDataCacheRoot, validate = () => true } = {}) {
  const file = path.resolve(root, '.boonetools-cache', relativeFile);
  const legacyFile = path.resolve(root, 'node_modules', '.cache', relativeFile);
  let preparation;

  async function readValid(cacheFile) {
    let bytes;
    try { bytes = await readFile(cacheFile); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    try {
      if (!validate(JSON.parse(bytes.toString('utf8')))) throw new Error('Unrecognized cache structure');
    } catch (cause) {
      throw new Error(`Cannot use development cache ${cacheFile}: ${cause.message}. Preserve or repair it before restarting.`, { cause });
    }
    return bytes;
  }

  async function migrate() {
    if (await readValid(file) !== null) return file;
    const bytes = await readValid(legacyFile);
    if (bytes === null) return file; // A new checkout has nothing to migrate.
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.migrate-${randomUUID()}`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      try { await handle.writeFile(bytes); await handle.sync(); }
      finally { await handle.close(); }
      try {
        // The destination appears complete in one operation and cannot replace
        // a cache written by another dev process while this copy was prepared.
        await link(temporary, file);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (await readValid(file) === null) throw error;
      }
    } finally { await unlink(temporary); }
    return file;
  }

  return {
    file,
    async prepare(cacheFile = file) {
      if (path.resolve(cacheFile) !== file) return cacheFile;
      // A failed migration must block acquisition, but can be retried once the
      // user repairs permissions or invalid data. Never fall back to an empty cache.
      preparation ||= migrate().catch(error => { preparation = null; throw error; });
      return preparation;
    }
  };
}
