import { app, BrowserWindow, shell } from "electron";
import path from "node:path";
import { HelperServer } from "./server";

let mainWindow: BrowserWindow | null = null;
let helperServer: HelperServer | null = null;

async function createApp(): Promise<void> {
  helperServer = new HelperServer({
    appDataDir: app.getPath("userData"),
    onShutdown: () => app.quit()
  });
  const port = await helperServer.start();

  mainWindow = new BrowserWindow({
    width: 760,
    height: 560,
    minWidth: 620,
    minHeight: 480,
    title: "ENA Read Submission Helper",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  const rendererPath = app.isPackaged
    ? path.join(process.resourcesPath, "renderer", "index.html")
    : path.join(__dirname, "..", "src", "renderer", "index.html");
  await mainWindow.loadFile(rendererPath, { query: { port: String(port) } });
}

app.whenReady().then(createApp).catch((err) => {
  console.error(err);
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", async (event) => {
  if (!helperServer) return;
  event.preventDefault();
  const server = helperServer;
  helperServer = null;
  await server.stop().catch(() => undefined);
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createApp().catch((err) => {
      console.error(err);
      app.quit();
    });
  }
});
