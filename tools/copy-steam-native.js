#!/usr/bin/env node
/*
  Copy Steamworks native redistributables next to the published bridge output.

  Expected layout in repo (you provide these 2 files from the Steamworks SDK redistributable_bin):

    bridge/native/win-x64/steam_api64.dll
    bridge/native/linux-x64/libsteam_api.so

  After `dotnet publish -o backend/<rid>`, this script copies the file into that folder.

  Why?
  - Steamworks.NET on Windows loads steam_api64.dll
  - On Linux it should load libsteam_api.so
  - We also set executable bit for the Linux bridge binary if running on Linux.
*/

const fs = require('fs');
const path = require('path');

const rid = process.argv[2];
if (!rid) {
  console.error('Usage: node tools/copy-steam-native.js <rid>  (e.g. win-x64 | linux-x64)');
  process.exit(2);
}

const repoRoot = path.resolve(__dirname, '..');
const srcDir = path.join(repoRoot, 'bridge', 'native', rid);
const dstDir = path.join(repoRoot, 'backend', rid);

const mapping = {
  'win-x64': ['steam_api64.dll'],
  'linux-x64': ['libsteam_api.so'],
};

const files = mapping[rid];
if (!files) {
  console.warn(`[Warn] Unknown rid: ${rid}. Nothing to copy.`);
  process.exit(0);
}

if (!fs.existsSync(dstDir)) {
  console.warn(`[Warn] backend output folder not found: ${dstDir}`);
  process.exit(0);
}

for (const f of files) {
  const src = path.join(srcDir, f);
  const dst = path.join(dstDir, f);

  if (!fs.existsSync(src)) {
    console.warn(`[Warn] Missing native file: ${src}`);
    console.warn('       Please copy it from the Steamworks SDK redistributable_bin into bridge/native/<rid>/');
    continue;
  }

  fs.copyFileSync(src, dst);
  console.log(`[OK] Copied ${f} -> ${path.relative(repoRoot, dst)}`);
}

// Best-effort: on Linux host, ensure the published bridge binary is executable.
// If you publish Linux RID on Windows, file mode might be 0644 in the VSIX.
// The extension can also chmod at runtime, but this helps for local testing.
try {
  if (process.platform === 'linux') {
    const entries = fs.readdirSync(dstDir);
    for (const name of entries) {
      const full = path.join(dstDir, name);
      const st = fs.statSync(full);
      if (!st.isFile()) continue;

      // Heuristic: the bridge executable is typically the only file without extension.
      if (!path.extname(name)) {
        fs.chmodSync(full, 0o755);
        console.log(`[OK] chmod +x ${path.relative(repoRoot, full)}`);
      }
    }
  }
} catch (e) {
  console.warn(`[Warn] chmod step failed: ${e.message}`);
}
