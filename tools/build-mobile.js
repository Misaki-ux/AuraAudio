const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'mobile', 'index.html');
const manifestSource = path.join(root, 'mobile', 'manifest.webmanifest');
const serviceWorkerSource = path.join(root, 'mobile', 'service-worker.js');
const assetsSource = path.join(root, 'assets');
const outputDir = path.join(root, 'mobile-dist');
const output = path.join(outputDir, 'index.html');

fs.mkdirSync(outputDir, { recursive: true });
let html = fs.readFileSync(source, 'utf8');
const apiUrl = process.env.AURA_API_URL?.trim();
if (apiUrl) {
  if (!/^https?:\/\//i.test(apiUrl)) throw new Error('AURA_API_URL must start with http:// or https://');
  html = html.replace("const BUILD_API_URL='';", `const BUILD_API_URL=${JSON.stringify(apiUrl.replace(/\/$/, ''))};`);
}
fs.writeFileSync(output, html);
fs.copyFileSync(manifestSource, path.join(outputDir, 'manifest.webmanifest'));
fs.copyFileSync(serviceWorkerSource, path.join(outputDir, 'service-worker.js'));
if (fs.existsSync(assetsSource)) fs.cpSync(assetsSource, path.join(outputDir, 'assets'), { recursive: true });
console.log(`Mobile distribution written to ${output}`);
