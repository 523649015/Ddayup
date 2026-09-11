#!/usr/bin/env node
// Structural audit for the backend architecture-refactor effort.
// 1. For each lib/*.mjs module, confirm its exported symbols are imported
//    somewhere in the server tree (no orphaned modules).
// 2. Confirm no duplicate `function NAME` definitions exist in main for any
//    symbol exported by a lib module (single-source-of-truth).
// 3. Scan for leftover temp/backup artifacts from refactoring work.
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SERVER = path.join(REPO, 'app', 'server');
const LIB = path.join(SERVER, 'lib');
const TMP = path.join(HERE, 'tmp');
mkdirSync(TMP, { recursive: true });

const libFiles = readdirSync(LIB).filter((f) => f.endsWith('.mjs'));
const serverFiles = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.mjs') || e.name.endsWith('.cjs')) serverFiles.push(p);
  }
})(SERVER);

const mainPath = path.join(SERVER, 'hmdao-api.mjs');
const mainSrc = readFileSync(mainPath, 'utf8');

function exportedSymbols(file) {
  const src = readFileSync(file, 'utf8');
  const syms = new Set();
  // export { a, b };   |   export function a()  |  export const a =
  let m;
  const re1 = /export\s*\{([^}]*)\}/g;
  while ((m = re1.exec(src))) {
    m[1].split(',').forEach((s) => {
      const name = s.trim().split(/\s+as\s+/).pop().trim();
      if (name) syms.add(name);
    });
  }
  const re2 = /export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g;
  while ((m = re2.exec(src))) syms.add(m[1]);
  const re3 = /export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/g;
  while ((m = re3.exec(src))) syms.add(m[1]);
  return syms;
}

function importedSymbols(file, fromModule) {
  const src = readFileSync(file, 'utf8');
  const imp = new Set();
  const re = /import\s*\{([^}]*)\}\s*from\s*['"]\.{0,2}\/.*?([\w-]+\.mjs)['"]/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[2] === path.basename(fromModule)) {
      m[1].split(',').forEach((s) => {
        const name = s.trim().split(/\s+as\s+/)[0].trim();
        if (name) imp.add(name);
      });
    }
  }
  return imp;
}

const audit = [];
let orphaned = 0;
let dupDefs = 0;

for (const lf of libFiles) {
  const full = path.join(LIB, lf);
  const syms = exportedSymbols(full);
  if (syms.size === 0) {
    audit.push({ module: lf, status: 'NO_EXPORTS', note: 'module declares no exports' });
    continue;
  }
  const consumers = new Set();
  for (const sf of serverFiles) {
    if (path.resolve(sf) === full) continue;
    const imp = importedSymbols(sf, full);
    if (imp.size > 0) {
      for (const s of imp) consumers.add(path.relative(REPO, sf) + ':' + s);
      // duplicate local definition check in main
      if (path.resolve(sf) === mainPath) {
        for (const s of imp) {
          const dup = new RegExp('^(?:async\\s+)?function\\s+' + s + '\\s*\\(', 'm');
          if (dup.test(mainSrc)) {
            dupDefs += 1;
            audit.push({ module: lf, symbol: s, status: 'DUP_DEF_IN_MAIN', note: 'symbol still defined as function in hmdao-api.mjs' });
          }
        }
      }
    }
  }
  if (consumers.size === 0) {
    orphaned += 1;
    audit.push({ module: lf, status: 'ORPHANED', note: 'no importer found for its exports' });
  }
}

// Temp/backup artifact scan in scripts + app/server
const artifacts = [];
function scanTemp(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'artifacts' || e.name === 'tmp') continue;
      scanTemp(p);
    } else if (/(_tmp|\.bak|-old|old\.|\.tmp$|\.orig$)/i.test(e.name) && !/^run-refactor|\.json$/.test(e.name)) {
      if (path.relative(REPO, p).replace(/\\/g, '/').startsWith('scripts/tmp')) continue;
      artifacts.push(path.relative(REPO, p).replace(/\\/g, '/'));
    }
  }
}
scanTemp(HERE);
scanTemp(SERVER);

const report = {
  generatedAt: new Date().toISOString(),
  libModules: libFiles.length,
  totalExportedSymbols: [...libFiles].reduce((a, f) => a + exportedSymbols(path.join(LIB, f)).size, 0),
  orphanedModules: orphaned,
  duplicateDefinitionsInMain: dupDefs,
  auditDetail: audit,
  tempArtifacts: artifacts,
};
writeFileSync(path.join(TMP, 'refactor-audit.json'), JSON.stringify(report, null, 2));

console.log('\n================ REFACTOR STRUCTURAL AUDIT ================');
console.log('  lib modules scanned :', report.libModules);
console.log('  exported symbols    :', report.totalExportedSymbols);
console.log('  orphaned modules    :', report.orphanedModules);
console.log('  dup defs in main    :', report.duplicateDefinitionsInMain);
console.log('  temp/backup artifacts:', report.tempArtifacts.length ? report.tempArtifacts.join(', ') : 'none');
if (audit.length) {
  console.log('  --- audit detail ---');
  for (const a of audit) console.log('   ', a.status, a.module, a.symbol || '', a.note || '');
}
console.log('==========================================================\n');
process.exit(report.orphanedModules === 0 && report.duplicateDefinitionsInMain === 0 ? 0 : 1);
