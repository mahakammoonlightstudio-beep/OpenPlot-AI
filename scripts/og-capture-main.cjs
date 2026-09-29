// One-shot Electron main process: open the OG card page, screenshot it, exit.
const { app, BrowserWindow } = require('electron');
const { writeFile } = require('node:fs/promises');

const [cardPath, outPath] = process.argv.slice(2);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1200,
    height: 630,
    useContentSize: true,
    show: false,
    webPreferences: { offscreen: true },
  });
  await win.loadFile(cardPath);
  await new Promise((r) => setTimeout(r, 400)); // let fonts/gradients settle
  const image = await win.webContents.capturePage();
  const png = image.resize({ width: 1200, height: 630 });
  await writeFile(outPath, png.toPNG());
  console.log('OG image written:', outPath);
  app.exit(0);
}).catch((err) => {
  console.error(err);
  app.exit(1);
});
