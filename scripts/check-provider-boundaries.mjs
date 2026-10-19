import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Explicit transport/catalog owners. Independent L1 custody adapters retain
// their reviewed chain-specific transport; this guard does not migrate them.
const TRANSPORTS = new Set(['shared/provider-client.js', 'backend/src/lib/provider-client.js',
  'backend/src/treasury/providers.js', 'backend/src/vault-balances/common.js']);
const CATALOGS = new Set(['shared/thorchain-providers.js', 'shared/external-providers.js',
  'backend/src/lib/config.js', 'backend/src/treasury/providers.js',
  'backend/src/vault-balances/chains.js', 'backend/src/vault-balances/evm.js', 'backend/src/vault-balances/tron.js']);
// Exact attribution links, not provider requests; additional links need review.
const ATTRIBUTIONS = new Map([
  ['backend/src/protocol-fee-comparison/collector.js', new Set(['https://docs.fastnear.com/transfers/query'])],
  ['backend/src/shared/tc-fee-dash-ingestion.js', new Set(['https://dune.com/queries/'])]
]);
const RAW_HTTP_MODULES = /^(?:node:)?https?$|^(?:axios|node-fetch|undici)(?:\/|$)/;
const PUBLIC_BACKEND_IMPORTS = new Map([
  ['shared/provider-client.js', new Set(['backend/src/lib/provider-client.js'])],
  ['shared/provider-services.js', new Set(['backend/src/lib/provider-services.js', 'backend/src/shared/financials-service.js'])]
]);

function nameOf(node) {
  return ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : '';
}

function containsFetchCall(node) {
  if (ts.isCallExpression(node)) return containsFetchCall(node.expression);
  if (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword) return false;
  if (ts.isIdentifier(node) && ['fetch', 'fetchImpl'].includes(node.text)) return true;
  if (ts.isPropertyAccessExpression(node) && ['fetch', 'fetchImpl'].includes(node.name.text)) return true;
  if (ts.isElementAccessExpression(node) && ['fetch', 'fetchImpl'].includes(nameOf(node.argumentExpression))) return true;
  return ts.forEachChild(node, containsFetchCall) || false;
}

export function auditProviderSource(file, source) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const violations = [];
  const report = (node, rule) => violations.push({ file, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1, rule });
  const transport = TRANSPORTS.has(file);
  function visit(node) {
    const localMethod = ts.isIdentifier(node) && (ts.isMethodDeclaration(node.parent)
      || ts.isPropertyAccessExpression(node.parent) && node.parent.expression.kind === ts.SyntaxKind.ThisKeyword);
    if (!transport && ((ts.isIdentifier(node) && node.text === 'fetch' && !localMethod)
      || (ts.isElementAccessExpression(node) && nameOf(node.argumentExpression) === 'fetch')
      || (ts.isCallExpression(node) && containsFetchCall(node.expression)))) {
      report(node, 'raw-fetch: use a shared provider adapter');
    }
    if (file.startsWith('shared/') && ((ts.isPropertyAccessExpression(node) && node.name.text === 'env')
      || (ts.isElementAccessExpression(node) && nameOf(node.argumentExpression) === 'env'))) {
      report(node, 'private-config: runtime-neutral modules must receive configuration');
    }
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node)) {
      const value = node.text;
      const isImport = ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)
        || (ts.isCallExpression(node.parent) && (node.parent.expression.kind === ts.SyntaxKind.ImportKeyword
          || nameOf(node.parent.expression) === 'require'));
      if (isImport) {
        if (RAW_HTTP_MODULES.test(value) && !transport && !(file === 'backend/src/server.js' && value === 'node:http')) {
          report(node, 'raw-http-import: use a shared provider adapter');
        }
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), value));
        const owners = PUBLIC_BACKEND_IMPORTS.get(target);
        if (file.startsWith('backend/src/') && owners && !owners.has(file)) {
          report(node, 'backend-transport: use the budgeted backend adapter');
        }
      }
      if (/^https?:\/\//i.test(value) && !CATALOGS.has(file) && !ATTRIBUTIONS.get(file)?.has(value)) {
        let hostname = '';
        try { hostname = new URL(value).hostname; } catch { /* Partial URL literals are still declarations. */ }
        if (!(hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.invalid') || hostname.endsWith('.local'))) {
          report(node, 'provider-url: declare endpoints in an approved catalog, request services with relative paths');
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return violations;
}

async function sourceFiles(root, directory) {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true });
  return (await Promise.all(entries.map(entry => {
    const relative = `${directory}/${entry.name}`;
    return entry.isDirectory() ? sourceFiles(root, relative) : /\.[cm]?js$/.test(entry.name) ? [relative] : [];
  }))).flat();
}

export async function checkProviderBoundaries(root) {
  const files = [...await sourceFiles(root, 'backend/src'), ...await sourceFiles(root, 'shared'),
    'scripts/dev-financials.mjs', 'scripts/dev-protocol-fee-comparison.mjs', 'src/lib/api/midgard.js'];
  return (await Promise.all(files.map(async file => auditProviderSource(file, await readFile(path.join(root, file), 'utf8'))))).flat();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failures = await checkProviderBoundaries(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  if (failures.length) {
    for (const failure of failures) console.error(`${failure.file}:${failure.line}: ${failure.rule}`);
    process.exitCode = 1;
  } else console.log('Provider transport, endpoint and configuration boundaries are clean.');
}
