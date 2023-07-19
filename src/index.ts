import { app, BrowserView, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, Notification, safeStorage, session, shell, Tray } from 'electron';
import ElectronStore from 'electron-store';
import path from 'path';
import CompanionServer from './integrations/companion-server';
import DiscordPresence from './integrations/discord-presence';
import playerStateStore from './player-state-store';
import { StoreSchema } from './shared/store/schema';
// This allows TypeScript to pick up the magic constants that's auto-generated by Forge's Webpack
// plugin that tells the Electron app where to look for the Webpack-bundled app code (depending on
// whether you're running in development or production).
declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;
declare const SETTINGS_WINDOW_WEBPACK_ENTRY: string;
declare const SETTINGS_WINDOW_PRELOAD_WEBPACK_ENTRY: string;
declare const YTM_VIEW_PRELOAD_WEBPACK_ENTRY: string;

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
  app.quit();
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}
else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }

      mainWindow.show();
      mainWindow.focus();

      // Do some more bits if the commandLine is provided.
      // For example open to a video or playlist.
    }
  });
}

const companionServer = new CompanionServer();
const discordPresence = new DiscordPresence();

let mainWindow: BrowserWindow = null;
let settingsWindow: BrowserWindow = null;
let ytmView: BrowserView = null;
let tray = null;
let trayContextMenu = null;

// These variables tend to be changed often so we store it in memory and write on close (less disk usage)
let lastUrl = '';
let lastVideoId = '';
let lastPlaylistId = '';

let companionAuthWindowEnableTimeout: NodeJS.Timeout | null = null;

// Create the persistent config store
const store = new ElectronStore<StoreSchema>({
  watch: true,
  defaults: {
    general: {
      hideToTrayOnClose: false,
      showNotificationOnSongChange: false,
      startOnBoot: false,
      startMinimized: false,
      alwaysShowVolumeSlider: false
    },
    playback: {
      continueWhereYouLeftOff: true,
      taskbarProgress: false,
    },
    integrations: {
      companionServerEnabled: false,
      companionServerAuthWindowEnabled: null,
      companionServerAuthTokens: null,
      discordPresenceEnabled: false
    },
    shortcuts: {
      playPause: '',
      next: '',
      previous: '',
      thumbsUp: '',
      thumbsDown: '',
      volumeUp: '',
      volumeDown: ''
    },
    state: {
      lastUrl: 'https://music.youtube.com/',
      lastVideoId: '',
      lastPlaylistId: '',
      companionServerAuthWindowEnableTime: null,
      windowBounds: null,
      windowMaximized: false
    },
    notifications: {
      nowPlaying: false
    }
  }
});
store.onDidAnyChange((newState, oldState) => {
  if (settingsWindow !== null) {
    settingsWindow.webContents.send('settings:stateChanged', newState, oldState);
  }

  if (ytmView !== null) {
    ytmView.webContents.send('settings:stateChanged', newState, oldState);
  }

  app.setLoginItemSettings({
    openAtLogin: newState.general.startOnBoot
  });

  let companionServerAuthWindowEnabled = false;
  try {
    companionServerAuthWindowEnabled = safeStorage.decryptString(Buffer.from(newState.integrations.companionServerAuthWindowEnabled, 'hex')) === 'true' ? true : false;
  } catch { /* do nothing, value is false */ }

  if (newState.integrations.companionServerEnabled) {
    companionServer.provide(store);
    companionServer.enable();
  } else {
    companionServer.disable();

    if (companionServerAuthWindowEnabled) {
      store.set('integrations.companionServerAuthWindowEnabled', null);
      store.set('state.companionServerAuthWindowEnableTime', null);
      clearInterval(companionAuthWindowEnableTimeout);
      companionAuthWindowEnableTimeout = null;
      companionServerAuthWindowEnabled = false;
    }
  }

  if (companionServerAuthWindowEnabled) {
    if (!companionAuthWindowEnableTimeout) {
      companionAuthWindowEnableTimeout = setTimeout(() => {
        store.set('integrations.companionServerAuthWindowEnabled', null);
        store.set('state.companionServerAuthWindowEnableTime', null);
        companionAuthWindowEnableTimeout = null;
      }, 300 * 1000);
      store.set('state.companionServerAuthWindowEnableTime', safeStorage.encryptString(new Date().toISOString()).toString('hex'));
    }
  }

  if (newState.integrations.discordPresenceEnabled) {
    discordPresence.enable();
  } else {
    discordPresence.disable();
  }

  registerShortcuts();
});

// Integrations setup
// CompanionServer
companionServer.addEventListener((command, value) => {
  ytmView.webContents.send('remoteControl:execute', command, value);
});
if (store.get('integrations').companionServerEnabled) {
  companionServer.provide(store);
  companionServer.enable();
}

// DiscordPresence
if (store.get('integrations').discordPresenceEnabled) {
  discordPresence.enable();
}

function integrationsSetupAppReady() {
  let companionServerAuthWindowEnabled = false;
  try {
    companionServerAuthWindowEnabled = safeStorage.decryptString(Buffer.from(store.get('integrations').companionServerAuthWindowEnabled, 'hex')) === 'true' ? true : false;
  } catch { /* do nothing, value is false */ }

  if (companionServerAuthWindowEnabled) {
    let companionAuthEnableTimeSate = null;
    try {
      companionAuthEnableTimeSate = safeStorage.decryptString(Buffer.from(store.get('state').companionServerAuthWindowEnableTime, 'hex'));
    } catch { /* do nothing, value is not valid */ }

    if (companionAuthEnableTimeSate) {
      const currentDateTime = new Date();
      const enableDateTime = new Date(companionAuthEnableTimeSate);

      const timeDifference = currentDateTime.getTime() - enableDateTime.getTime();
      if (timeDifference >= 300 * 1000) {
        store.set('integrations.companionServerAuthWindowEnabled', null);
        store.set('state.companionServerAuthWindowEnableTime', null);
      } else {
        companionAuthWindowEnableTimeout = setTimeout(() => {
          store.set('integrations.companionServerAuthWindowEnabled', null);
          store.set('state.companionServerAuthWindowEnableTime', null);
          companionAuthWindowEnableTimeout = null;
        }, (300 * 1000) - timeDifference);
      }
    } else {
      store.set('integrations.companionServerAuthWindowEnabled', null);
      store.set('state.companionServerAuthWindowEnableTime', null);
    }
  }
}

// Shortcut registration
function registerShortcuts() {
  const shortcuts = store.get('shortcuts');

  globalShortcut.unregisterAll();

  if (shortcuts.playPause) {
    globalShortcut.register(shortcuts.playPause, () => {
      if (ytmView) {
        ytmView.webContents.send('remoteControl:execute', 'playPause');
      }
    });
  }

  if (shortcuts.next) {
    globalShortcut.register(shortcuts.next, () => {
      if (ytmView) {
        ytmView.webContents.send('remoteControl:execute', 'next');
      }
    });
  }

  if (shortcuts.previous) {
    globalShortcut.register(shortcuts.previous, () => {
      if (ytmView) {
        ytmView.webContents.send('remoteControl:execute', 'previous');
      }
    });
  }

  if (shortcuts.thumbsUp) {
    globalShortcut.register(shortcuts.thumbsUp, () => {
      if (ytmView) {
        ytmView.webContents.send('remoteControl:execute', 'thumbsUp');
      }
    });
  }

  if (shortcuts.thumbsDown) {
    globalShortcut.register(shortcuts.thumbsDown, () => {
      if (ytmView) {
        ytmView.webContents.send('remoteControl:execute', 'thumbsDown');
      }
    });
  }

  if (shortcuts.volumeUp) {
    globalShortcut.register(shortcuts.volumeUp, () => {
      if (ytmView) {
        ytmView.webContents.send('remoteControl:execute', 'volumeUp');
      }
    });

  }

  if (shortcuts.volumeDown) {
    globalShortcut.register(shortcuts.volumeDown, () => {
      if (ytmView) {
        ytmView.webContents.send('remoteControl:execute', 'volumeDown');
      }
    });
  }
}

// Functions which call to mainWindow renderer
function sendMainWindowStateIpc() {
  if (mainWindow !== null) {
    mainWindow.webContents.send('mainWindow:stateChanged', {
      minimized: mainWindow.isMinimized(),
      maximized: mainWindow.isMaximized()
    })
  }
}

// Functions with call to ytmView renderer
function ytmViewNavigated() {
  if (ytmView !== null) {
    lastUrl = ytmView.webContents.getURL();
    ytmView.webContents.send('ytmView:navigationStateChanged', {
      canGoBack: ytmView.webContents.canGoBack(),
      canGoForward: ytmView.webContents.canGoForward(),
    })
  }
}

// Functions which call to settingsWindow renderer
function sendSettingsWindowStateIpc() {
  if (settingsWindow !== null) {
    settingsWindow.webContents.send('settingsWindow:stateChanged', {
      minimized: settingsWindow.isMinimized(),
      maximized: settingsWindow.isMaximized()
    })
  }
}

const createOrShowSettingsWindow = (): void => {
  if (mainWindow === null) {
    return;
  }

  if (settingsWindow !== null) {
    settingsWindow.focus();
    return;
  }

  const mainWindowBounds = mainWindow.getBounds();

  // Create the browser window.
  settingsWindow = new BrowserWindow({
    width: 800,
    height: 600,
    x: Math.round(mainWindowBounds.x + (mainWindowBounds.width / 2 - 400)),
    y: Math.round(mainWindowBounds.y + (mainWindowBounds.height / 2 - 300)),
    minimizable: false,
    maximizable: false,
    resizable: false,
    frame: false,
    parent: mainWindow,
    modal: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      preload: SETTINGS_WINDOW_PRELOAD_WEBPACK_ENTRY,
    },
  });

  // Attach events to settings window
  settingsWindow.on('maximize', sendSettingsWindowStateIpc)
  settingsWindow.on('unmaximize', sendSettingsWindowStateIpc)
  settingsWindow.on('minimize', sendSettingsWindowStateIpc)
  settingsWindow.on('restore', sendSettingsWindowStateIpc)

  settingsWindow.once('closed', () => {
    settingsWindow = null;
  });

  // and load the index.html of the app.
  settingsWindow.loadURL(SETTINGS_WINDOW_WEBPACK_ENTRY);

  // Open the DevTools.
  if (process.env.NODE_ENV === 'development') {
    settingsWindow.webContents.openDevTools({
      mode: 'detach'
    });
  }
};

const createMainWindow = (): void => {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    frame: false,
    icon: './assets/icons/ytmd.png',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
    },
  });
  const windowBounds = store.get('state').windowBounds;
  const windowMaximized = store.get('state').windowMaximized;
  if (windowBounds) {
    mainWindow.setBounds(windowBounds);
  }
  if (windowMaximized) {
    mainWindow.maximize();
  }

  // Create the YouTube Music view
  ytmView = new BrowserView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      partition: 'persist:ytmview',
      preload: YTM_VIEW_PRELOAD_WEBPACK_ENTRY,
    },
  });
  // This block of code adding the browser view setting the bounds and removing it is a temporary fix for a bug in YTMs UI
  // where a small window size will lock the scrollbar and have difficult unlocking it without changing the guide bar collapse state
  if (ytmView !== null && mainWindow !== null) {
    mainWindow.addBrowserView(ytmView);
    ytmView.setBounds({
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
    });
    mainWindow.removeBrowserView(ytmView);
  }

  let navigateDefault = true;

  const continueWhereYouLeftOff: boolean = store.get('playback.continueWhereYouLeftOff');
  if (continueWhereYouLeftOff) {
    const lastUrl: string = store.get('state.lastUrl');
    if (lastUrl) {
      if (lastUrl.startsWith("https://music.youtube.com/")) {
        ytmView.webContents.loadURL(lastUrl);
        navigateDefault = false;
      }
    }
  }

  if (navigateDefault) {
    ytmView.webContents.loadURL('https://music.youtube.com/');
    store.set('state.lastUrl', 'https://music.youtube.com/')
  }

  // Attach events to ytm view
  ytmView.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith("https://consent.youtube.com/") && !url.startsWith("https://accounts.google.com/") && !url.startsWith("https://accounts.youtube.com/") && !url.startsWith("https://music.youtube.com/") && !url.startsWith("https://www.youtube.com/signin")) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
  ytmView.webContents.on('did-navigate', ytmViewNavigated);
  ytmView.webContents.on('did-navigate-in-page', ytmViewNavigated);

  ytmView.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return {
      action: 'deny'
    }
  });

  // Attach events to main window
  mainWindow.on('resize', () => {
    setTimeout(() => {
      ytmView.setBounds({
        x: 0,
        y: 36,
        width: mainWindow.getContentBounds().width,
        height: mainWindow.getContentBounds().height - 36,
      });
    });
  });

  mainWindow.on('maximize', sendMainWindowStateIpc)
  mainWindow.on('unmaximize', sendMainWindowStateIpc)
  mainWindow.on('minimize', sendMainWindowStateIpc)
  mainWindow.on('restore', sendMainWindowStateIpc)
  mainWindow.on('close', () => {
    store.set('state.lastUrl', lastUrl);
    store.set('state.lastVideoId', lastVideoId);
    store.set('state.lastPlaylistId', lastPlaylistId);

    store.set('state.windowBounds', mainWindow.getNormalBounds());
    store.set('state.windowMaximized', mainWindow.isMaximized());
  });

  // Taskbar Stuff (Windows Only)
  if (process.platform === 'win32') {
    const assetFolder = path.join(process.env.NODE_ENV === 'development' ? path.join(app.getAppPath(), 'src/assets') : process.resourcesPath);
    mainWindow.setThumbarButtons([
      {
        tooltip: 'Previous',
        // FIX ICON PATH
        icon: nativeImage.createFromPath(path.join(assetFolder, 'icons/media-controls/previous.png')),
        click() {
          if (ytmView) {
            ytmView.webContents.send('remoteControl:execute', 'previous');
          }
        }
      },
      {
        tooltip: 'Play/Pause',
        // FIX ICON PATH
        icon: nativeImage.createFromPath(path.join(assetFolder, 'icons/media-controls/play.png')),
        click() {
          if (ytmView) {
            ytmView.webContents.send('remoteControl:execute', 'playPause');
          }
        }
      },
      {
        tooltip: 'Next',
        // FIX ICON PATH
        icon: nativeImage.createFromPath(path.join(assetFolder, 'icons/media-controls/next.png')),
        click() {
          if (ytmView) {
            ytmView.webContents.send('remoteControl:execute', 'next');
          }
        }
      }
    ]);
  }


  // and load the index.html of the app.
  mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);

  // Open the DevTools.
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools({
      mode: 'detach'
    });
    ytmView.webContents.openDevTools({
      mode: 'detach'
    });
  }
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', () => {
  // Handle main window ipc
  ipcMain.on('mainWindow:minimize', () => {
    if (mainWindow !== null) {
      mainWindow.minimize();
    }
  });

  ipcMain.on('mainWindow:maximize', () => {
    if (mainWindow !== null) {
      mainWindow.maximize();
    }
  });

  ipcMain.on('mainWindow:restore', () => {
    if (mainWindow !== null) {
      mainWindow.restore();
    }
  });

  ipcMain.on('mainWindow:close', () => {
    if (mainWindow !== null) {
      if (store.get('general').hideToTrayOnClose) {
        mainWindow.hide();
      } else {
        app.quit();
      }
    }
  });

  ipcMain.on('mainWindow:requestWindowState', () => {
    sendMainWindowStateIpc();
  })

  // Handle settings window ipc
  ipcMain.on('settingsWindow:open', () => {
    createOrShowSettingsWindow();
  });

  ipcMain.on('settingsWindow:minimize', () => {
    if (settingsWindow !== null) {
      settingsWindow.minimize();
    }
  });

  ipcMain.on('settingsWindow:maximize', () => {
    if (settingsWindow !== null) {
      settingsWindow.maximize();
    }
  });

  ipcMain.on('settingsWindow:restore', () => {
    if (settingsWindow !== null) {
      settingsWindow.restore();
    }
  });

  ipcMain.on('settingsWindow:close', () => {
    if (settingsWindow !== null) {
      settingsWindow.close();
    }
  });

  // Handle ytm view ipc
  ipcMain.on('ytmView:loaded', () => {
    if (ytmView !== null && mainWindow !== null) {
      mainWindow.addBrowserView(ytmView);
      ytmView.setBounds({
        x: 0,
        y: 36,
        width: mainWindow.getContentBounds().width,
        height: mainWindow.getContentBounds().height - 36,
      });
    }
  });

  ipcMain.on('ytmView:videoProgressChanged', (event, progress) => {
    playerStateStore.updateVideoProgress(progress);
  });

  ipcMain.on('ytmView:videoStateChanged', (event, state) => {
    // ytm state mapping definitions
    // -1 -> Unknown (Seems tied to no buffer data, but cannot confirm)
    // 1 -> Playing
    // 2 -> Paused
    // 3 -> Buffering
    // 5 -> Unknown (Only happens when loading new songs - unsure what this is for)

    // ytm state flow
    // Play Button Click
    //   -1 -> 5 -> -1 -> 3 -> 1
    // First Play Button Click (Only happens when the player is first loaded)
    //   -1 -> 3 -> 1
    // Previous/Next Song Click
    //   -1 -> 5 -> -1 -> 5 -> -1 -> 3 -> 1

    playerStateStore.updateVideoState(state);
  });

  ipcMain.on('ytmView:videoDataChanged', (event, videoDetails, playlistId) => {
    lastVideoId = videoDetails.videoId;
    lastPlaylistId = playlistId;

    playerStateStore.updateVideoDetails(videoDetails, playlistId);

    if (store.get('notifications.nowPlaying')) {
      const nowPlayingNotification = new Notification(
        {
          title: 'Now Playing',
          body: videoDetails.title,
          icon: videoDetails.thumbnail.thumbnails[0].url,

          timeoutType: 'default',
          silent: true,
          urgency: 'low',
        }
      );

      nowPlayingNotification.show();
      nowPlayingNotification.on('click', () => {
        // Show, bring the window to the front, and focus it
        mainWindow.show();
        ytmView.webContents.focus();
      });
    }
  });

  ipcMain.on('ytmView:storeStateChanged', (event, queue) => {
    playerStateStore.updateQueue(queue);
  });

  ipcMain.on('ytmView:switchFocus', (event, context) => {
    if (context === 'main') {
      if (mainWindow && ytmView.webContents.isFocused()) {
        mainWindow.webContents.focus();
      }
    } else if (context === 'ytm') {
      if (ytmView && mainWindow.webContents.isFocused()) {
        ytmView.webContents.focus();
      }
    }
  })

  // Handle settings store ipc
  ipcMain.on('settings:set', (event, key: string, value?: string) => {
    store.set(key, value);
  });

  ipcMain.handle('settings:get', (event, key: string) => {
    return store.get(key);
  });

  // Handle safeStorage ipc
  ipcMain.handle('safeStorage:decryptString', (event, value: string) => {
    if (value) {
      return safeStorage.decryptString(Buffer.from(value, 'hex'));
    } else {
      return null
    }
  });

  ipcMain.handle('safeStorage:encryptString', (event, value: string) => {
    return safeStorage.encryptString(value).toString('hex');
  });

  // Create the permission handlers
  session.fromPartition('persist:ytmview').setPermissionRequestHandler((webContents, permission, callback) => {
    return callback(false);
  });

  // Register global shortcuts
  registerShortcuts();


  // Run functions which rely on ready event
  integrationsSetupAppReady();

  // Create the tray
  tray = new Tray(path.join(process.env.NODE_ENV === 'development' ? path.join(app.getAppPath(), 'src/assets') : process.resourcesPath, process.platform === 'win32' ? 'icons/tray.ico' : 'icons/tray.png'));
  trayContextMenu = Menu.buildFromTemplate([
    {
      label: 'YouTube Music Desktop',
      type: 'normal',
      enabled: false
    },
    {
      type: 'separator'
    },
    {
      label: 'Play/Pause',
      type: 'normal',
      click: () => {
        ytmView.webContents.send('remoteControl:execute', 'playPause');
      }
    },
    {
      label: 'Previous',
      type: 'normal',
      click: () => {
        ytmView.webContents.send('remoteControl:execute', 'previous');
      }
    },
    {
      label: 'Next',
      type: 'normal',
      click: () => {
        ytmView.webContents.send('remoteControl:execute', 'next');
      }
    },
    {
      type: 'separator'
    },
    {
      label: 'Quit',
      type: 'normal',
      role: 'quit'
    },
  ]);
  tray.setToolTip('YouTube Music Desktop');
  tray.setContextMenu(trayContextMenu);
  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.show();
    }
  })

  createMainWindow();
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.
