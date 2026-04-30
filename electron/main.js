const { app, BrowserWindow, dialog, shell } = require("electron");
const { spawn } = require("child_process");
const { existsSync } = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");

const devServerUrl = process.env.ELECTRON_START_URL || "http://localhost:3000";

let mainWindow = null;
let nextServerProcess = null;
let isQuitting = false;

function findOpenPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to reserve local port")));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

function waitForServer(url, timeoutMs = 30000) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const check = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });

      req.on("error", () => {
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error(`Next standalone server did not start: ${url}`));
          return;
        }
        setTimeout(check, 250);
      });

      req.setTimeout(1000, () => {
        req.destroy();
      });
    };

    check();
  });
}

async function startStandaloneServer() {
  const appPath = app.getAppPath();
  const standaloneDir = path.join(appPath, ".next", "standalone");
  const serverPath = path.join(standaloneDir, "server.js");
  if (!existsSync(serverPath)) {
    throw new Error(`Next standalone server was not found: ${serverPath}`);
  }

  const port = await findOpenPort();
  const serverUrl = `http://127.0.0.1:${port}`;

  nextServerProcess = spawn(process.execPath, [serverPath], {
    cwd: standaloneDir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      HOSTNAME: "127.0.0.1",
      NODE_ENV: "production",
      PORT: String(port),
    },
    stdio: "ignore",
    windowsHide: true,
  });

  nextServerProcess.on("exit", (code) => {
    nextServerProcess = null;
    if (!isQuitting) {
      console.error(`Next standalone server exited with code ${code}`);
    }
  });

  await waitForServer(serverUrl);
  return serverUrl;
}

function stopStandaloneServer() {
  if (nextServerProcess) {
    nextServerProcess.kill();
    nextServerProcess = null;
  }
}

function createWindow(startUrl) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: "#0f1115",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.loadURL(startUrl);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

async function resolveStartUrl() {
  if (!app.isPackaged) {
    return devServerUrl;
  }
  return startStandaloneServer();
}

app.whenReady().then(async () => {
  try {
    const startUrl = await resolveStartUrl();
    createWindow(startUrl);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    dialog.showErrorBox("Analytics Checker", message);
    app.quit();
    return;
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void resolveStartUrl().then(createWindow);
    }
  });
});

app.on("before-quit", () => {
  isQuitting = true;
  stopStandaloneServer();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
