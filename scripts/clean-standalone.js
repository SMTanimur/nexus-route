const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

// 1. Clean up node_modules
const targetNodeModules = path.join(root, '.next', 'standalone', 'node_modules');
if (fs.existsSync(targetNodeModules)) {
  console.log(`🧹 Cleaning up standalone node_modules: ${targetNodeModules}`);
  fs.rmSync(targetNodeModules, { recursive: true, force: true });
  console.log('✅ Successfully cleaned up standalone node_modules.');
} else {
  console.log('ℹ️ No standalone node_modules found.');
}

// 2. Copy .next/static/ to .next/standalone/.next/static/
const srcStatic = path.join(root, '.next', 'static');
const destStatic = path.join(root, '.next', 'standalone', '.next', 'static');
if (fs.existsSync(srcStatic)) {
  console.log('📦 Copying .next/static to standalone folder...');
  fs.mkdirSync(path.dirname(destStatic), { recursive: true });
  fs.cpSync(srcStatic, destStatic, { recursive: true, force: true });
  console.log('✅ Copied static files.');
} else {
  console.log('⚠️ Source .next/static not found.');
}

// 3. Copy public/ to .next/standalone/public/
const srcPublic = path.join(root, 'public');
const destPublic = path.join(root, '.next', 'standalone', 'public');
if (fs.existsSync(srcPublic)) {
  console.log('📦 Copying public assets to standalone folder...');
  fs.cpSync(srcPublic, destPublic, { recursive: true, force: true });
  console.log('✅ Copied public assets.');
} else {
  console.log('⚠️ Source public/ not found.');
}
