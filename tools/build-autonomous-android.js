const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const projectDir = path.join(root, 'autonomous-android');
const androidDir = path.join(projectDir, 'android');
const cli = path.join(root, 'node_modules', '@capacitor', 'cli', 'bin', 'capacitor');
const env = { ...process.env };

function run(command, args, cwd) {
  const isWindowsBatch = process.platform === 'win32' && /\.(?:bat|cmd)$/i.test(command);
  const executable = isWindowsBatch ? (process.env.ComSpec || 'cmd.exe') : command;
  const commandArgs = isWindowsBatch
    ? ['/d', '/c', `call "${command}" ${args.join(' ')}`]
    : args;
  const result = spawnSync(executable, commandArgs, {
    cwd,
    env,
    stdio: 'inherit',
    windowsVerbatimArguments: isWindowsBatch
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

function installIcons() {
  const sourceDir = path.join(root, 'assets', 'android-icons');
  const resourcesDir = path.join(androidDir, 'app', 'src', 'main', 'res');
  for (const density of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
    const targetDir = path.join(resourcesDir, `mipmap-${density}`);
    fs.mkdirSync(targetDir, { recursive: true });
    const launcher = path.join(sourceDir, `${density}-launcher.png`);
    const foreground = path.join(sourceDir, `${density}-foreground.png`);
    if (!fs.existsSync(launcher) || !fs.existsSync(foreground)) {
      throw new Error(`AuraAudio launcher artwork is missing for ${density}: ${sourceDir}`);
    }
    fs.copyFileSync(launcher, path.join(targetDir, 'ic_launcher.png'));
    fs.copyFileSync(launcher, path.join(targetDir, 'ic_launcher_round.png'));
    fs.copyFileSync(foreground, path.join(targetDir, 'ic_launcher_foreground.png'));
  }
}

if (!fs.existsSync(cli)) throw new Error('Capacitor dependencies are missing. Run npm install first.');
if (!fs.existsSync(path.join(projectDir, 'capacitor.config.json'))) throw new Error(`Capacitor config missing: ${projectDir}`);

env.ANDROID_HOME ||= path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk');
env.ANDROID_SDK_ROOT ||= env.ANDROID_HOME;
if (process.platform === 'win32' && !process.env.JAVA_HOME) {
  const jdk23 = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Java', 'jdk-23');
  if (fs.existsSync(jdk23)) env.JAVA_HOME = jdk23;
}

run(process.execPath, [path.join(root, 'tools', 'build-server.js')], root);
if (!fs.existsSync(path.join(androidDir, 'app', 'build.gradle'))) {
  run(process.execPath, [cli, 'add', 'android'], projectDir);
}
run(process.execPath, [cli, 'sync', 'android'], projectDir);
installIcons();

const wrapper = process.platform === 'win32' ? 'gradlew.bat' : 'gradlew';
run(path.join(androidDir, wrapper), ['assembleDebug'], androidDir);

const builtApk = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
if (!fs.existsSync(builtApk)) throw new Error(`Gradle completed but the APK was not found at ${builtApk}`);
const outputDir = path.join(root, 'dist');
fs.mkdirSync(outputDir, { recursive: true });
const outputApk = path.join(outputDir, 'AuraAudio-Autonomous-debug.apk');
fs.copyFileSync(builtApk, outputApk);
const standaloneOutputDir = path.join(root, 'standalone-server', 'dist');
fs.mkdirSync(standaloneOutputDir, { recursive: true });
const standaloneOutputApk = path.join(standaloneOutputDir, 'AuraAudio-Autonomous-debug.apk');
fs.copyFileSync(builtApk, standaloneOutputApk);
console.log(`Autonomous client APK written to ${outputApk}`);
console.log(`Standalone server copy written to ${standaloneOutputApk}`);
console.log('The app uses the AuraAudio launcher icon and app-private on-device storage. A desktop server is optional for QR library transfer.');
