const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const androidDir = path.join(root, 'android');
const capacitorCli = path.join(root, 'node_modules', '@capacitor', 'cli', 'bin', 'capacitor');
const env = { ...process.env };

function privateIPv4(address) {
  return address.startsWith('10.') || address.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(address);
}

function discoverLanAddress() {
  const interfaces = os.networkInterfaces();
  const entries = Object.entries(interfaces).flatMap(([name, addresses]) =>
    (addresses || []).map(address => ({ name, ...address })));
  const usable = entries.filter(address => address.family === 'IPv4' && !address.internal && privateIPv4(address.address));
  const preferred = usable.find(address => !/virtual|vEthernet|vmware|virtualbox|docker|wsl|loopback/i.test(address.name));
  return (preferred || usable[0])?.address || '127.0.0.1';
}

function runNode(script, args = [], cwd = root) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

function runGradle() {
  const wrapper = process.platform === 'win32' ? 'gradlew.bat' : 'gradlew';
  const wrapperPath = path.join(androidDir, wrapper);
  const command = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : wrapperPath;
  const args = process.platform === 'win32'
    ? ['/d', '/c', `call "${wrapperPath}" assembleDebug`]
    : ['assembleDebug'];
  const result = spawnSync(command, args, {
    cwd: androidDir,
    env,
    stdio: 'inherit',
    windowsVerbatimArguments: process.platform === 'win32'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

function enableLanHttp() {
  const manifest = path.join(androidDir, 'app', 'src', 'main', 'AndroidManifest.xml');
  if (!fs.existsSync(manifest)) throw new Error(`Android manifest was not generated: ${manifest}`);
  let xml = fs.readFileSync(manifest, 'utf8');
  if (!/android:usesCleartextTraffic=/.test(xml)) {
    xml = xml.replace(/<application\b/, '<application\n        android:usesCleartextTraffic="true"');
    fs.writeFileSync(manifest, xml);
  }
}

function installAndroidIcons() {
  const sourceDir = path.join(root, 'assets', 'android-icons');
  const resourcesDir = path.join(androidDir, 'app', 'src', 'main', 'res');
  const densities = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'];
  for (const density of densities) {
    const targetDir = path.join(resourcesDir, `mipmap-${density}`);
    fs.mkdirSync(targetDir, { recursive: true });
    const launcher = path.join(sourceDir, `${density}-launcher.png`);
    const foreground = path.join(sourceDir, `${density}-foreground.png`);
    if (!fs.existsSync(launcher) || !fs.existsSync(foreground)) {
      throw new Error(`Android launcher artwork is missing for ${density}: ${sourceDir}`);
    }
    fs.copyFileSync(launcher, path.join(targetDir, 'ic_launcher.png'));
    fs.copyFileSync(launcher, path.join(targetDir, 'ic_launcher_round.png'));
    fs.copyFileSync(foreground, path.join(targetDir, 'ic_launcher_foreground.png'));
  }
  const background = path.join(resourcesDir, 'values', 'ic_launcher_background.xml');
  if (fs.existsSync(background)) {
    fs.writeFileSync(background, '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#090A0F</color>\n</resources>\n');
  }
}

if (!fs.existsSync(capacitorCli)) throw new Error('Capacitor dependencies are missing. Run npm install first.');

const apiHost = (process.env.AURA_API_HOST || discoverLanAddress()).trim();
const apiPort = String(Number(process.env.AURA_PORT) || 3456);
env.AURA_API_URL = process.env.AURA_API_URL || `http://${apiHost}:${apiPort}`;
env.ANDROID_HOME ||= path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk');
env.ANDROID_SDK_ROOT ||= env.ANDROID_HOME;
if (process.platform === 'win32' && !process.env.JAVA_HOME) {
  const jdk23 = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Java', 'jdk-23');
  if (fs.existsSync(jdk23)) env.JAVA_HOME = jdk23;
}

runNode(path.join(root, 'tools', 'build-mobile.js'));
if (!fs.existsSync(path.join(androidDir, 'app', 'build.gradle')) && !fs.existsSync(path.join(androidDir, 'app', 'build.gradle.kts'))) {
  if (fs.existsSync(androidDir) && fs.readdirSync(androidDir).length === 0) fs.rmdirSync(androidDir);
  runNode(capacitorCli, ['add', 'android']);
}
runNode(capacitorCli, ['sync', 'android']);
enableLanHttp();
installAndroidIcons();
runGradle();

const builtApk = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
if (!fs.existsSync(builtApk)) throw new Error(`Gradle completed but the APK was not found at ${builtApk}`);
const outputDir = path.join(root, 'dist');
fs.mkdirSync(outputDir, { recursive: true });
const outputApk = path.join(outputDir, 'AuraAudio-debug.apk');
fs.copyFileSync(builtApk, outputApk);
console.log(`Debug APK written to ${outputApk}`);
console.log(`This APK uses ${env.AURA_API_URL} by default. Change AURA_API_HOST/AURA_API_URL and rebuild to target another server.`);
