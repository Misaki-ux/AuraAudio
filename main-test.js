const { app, BrowserWindow } = require('electron');

console.log('Test: app =', app);
console.log('Test: app.whenReady =', app?.whenReady);

app.whenReady().then(() => {
  console.log('Electron ready!');
  const win = new BrowserWindow({ width: 800, height: 600 });
  win.loadFile('index.html');
});
