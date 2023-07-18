import { contextBridge, ipcRenderer, webFrame } from "electron";
import Store from "../shared/store/renderer";
import { StoreSchema } from "../shared/store/schema";

const store = new Store<StoreSchema>();

contextBridge.exposeInMainWorld('ytmd', {
    sendVideoProgress: (volume: number) => ipcRenderer.send('ytmView:videoProgressChanged', volume),
    sendVideoState: (state: number) => ipcRenderer.send('ytmView:videoStateChanged', state),
    sendVideoData: (videoDetails: any, playlistId: string) => ipcRenderer.send('ytmView:videoDataChanged', videoDetails, playlistId),
    sendAdState: (adRunning: boolean) => ipcRenderer.send('ytmView:adStateChanged', adRunning),
    sendStoreUpdate: (queueState: any) => ipcRenderer.send('ytmView:storeStateChanged', queueState)
})

function createStyleSheet() {
    const css = document.createElement('style')
    css.appendChild(document.createTextNode(
        `
        .ytmd-history-back, .ytmd-history-forward {
            cursor: pointer;
            margin: 0 18px 0 2px;
            font-size: 24px;
            color: rgba(255, 255, 255, 0.5);
        }

        .ytmd-history-back.pivotbar, .ytmd-history-forward.pivotbar {
            padding-top: 12px;
        }

        .ytmd-history-forward {
            transform: rotate(180deg);
        }

        .ytmd-history-back.disabled, .ytmd-history-forward.disabled {
            cursor: not-allowed;
        }

        .ytmd-history-back:hover:not(.disabled), .ytmd-history-forward:hover:not(.disabled) {
            color: #FFFFFF;
        }

        .ytmd-hidden {
            display: none;
        }

        .persist-volume-slider {
            opacity: 1 !important;
            pointer-events: initial !important;
        }
        `
    ))
    document.head.appendChild(css);
}

function createMaterialSymbolsLink() {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,100,0,0'
    return link;
}

function createNavigationMenuArrows() {
    // Go back in history
    const historyBackElement = document.createElement('span');
    historyBackElement.classList.add('material-symbols-outlined', 'ytmd-history-back', 'disabled');
    historyBackElement.innerText = 'keyboard_backspace';

    historyBackElement.addEventListener('click', function () {
        if (!historyBackElement.classList.contains('disabled')) {
            history.back();
        }
    });

    // Go forward in history
    const historyForwardElement = document.createElement('span');
    historyForwardElement.classList.add('material-symbols-outlined', 'ytmd-history-forward', 'disabled');
    historyForwardElement.innerText = 'keyboard_backspace';

    historyForwardElement.addEventListener('click', function () {
        if (!historyForwardElement.classList.contains('disabled')) {
            history.forward();
        }
    });

    ipcRenderer.on('ytmView:navigationStateChanged', (event, state) => {
        if (state.canGoBack) {
            historyBackElement.classList.remove('disabled');
        } else {
            historyBackElement.classList.add('disabled');
        }

        if (state.canGoForward) {
            historyForwardElement.classList.remove('disabled');
        } else {
            historyForwardElement.classList.add('disabled');
        }
    })

    const pivotBar = document.getElementsByTagName("ytmusic-pivot-bar-renderer")[0];
    if (!pivotBar) {
        // New YTM UI
        const searchBar = document.getElementsByTagName("ytmusic-search-box")[0];
        const navBar = searchBar.parentNode;
        navBar.insertBefore(historyForwardElement, searchBar);
        navBar.insertBefore(historyBackElement, historyForwardElement);
    } else {
        historyForwardElement.classList.add("pivotbar");
        historyBackElement.classList.add("pivotbar");
        pivotBar.prepend(historyForwardElement);
        pivotBar.prepend(historyBackElement);
    }
}

function createKeyboardNavigation() {
    const keyboardNavigation = document.createElement('div');
    keyboardNavigation.tabIndex = 32767;
    keyboardNavigation.onfocus = () => {
        keyboardNavigation.blur();
        ipcRenderer.send('ytmView:switchFocus', 'main')
    }
    document.body.appendChild(keyboardNavigation);
}

function hideChromecastButton() {
    webFrame.executeJavaScript(`
        window.ytmdPlayerBar.store.dispatch({ type: 'SET_CAST_AVAILABLE', payload: false });
    `);
}

function hookPlayerApiEvents() {
    webFrame.executeJavaScript(`
        window.ytmdPlayerBar.playerApi_.addEventListener('onVideoProgress', (progress) => { window.ytmd.sendVideoProgress(progress) });
        window.ytmdPlayerBar.playerApi_.addEventListener('onStateChange', (state) => { window.ytmd.sendVideoState(state) });
        window.ytmdPlayerBar.playerApi_.addEventListener('onVideoDataChange', (event) => { if (event.type === 'dataloaded' && event.playertype === 1) { window.ytmd.sendVideoData(window.ytmdPlayerBar.playerApi_.getPlayerResponse().videoDetails, window.ytmdPlayerBar.playerApi_.getPlaylistId()) } });
        window.ytmdPlayerBar.playerApi_.addEventListener('onAdStart', () => { window.ytmd.sendAdState(true) });
        window.ytmdPlayerBar.playerApi_.addEventListener('onAdEnd', () => { window.ytmd.sendAdState(false) });
        window.ytmdPlayerBar.store.subscribe(() => {
            // We don't want to see everything in the store as there can be some sensitive data so we only send what's necessary to operate
            let state = window.ytmdPlayerBar.store.getState();
            window.ytmd.sendStoreUpdate(state.queue)
        })
    `);
}

window.addEventListener('load', async () => {
    if (window.location.hostname !== "music.youtube.com") {
        if (window.location.hostname === 'consent.youtube.com') {
            ipcRenderer.send('ytmView:loaded');
        }
        return;
    }

    let materialSymbolsLoaded = false;

    const materialSymbols = createMaterialSymbolsLink();
    materialSymbols.onload = () => {
        materialSymbolsLoaded = true;
    }
    document.head.appendChild(materialSymbols);

    await new Promise<void>((resolve) => {
        const interval = setInterval(async () => {
            const playerApiReady: boolean = await webFrame.executeJavaScript(`
                document.getElementsByTagName("ytmusic-player-bar")[0].playerApi_.isReady();
            `);

            if (materialSymbolsLoaded && playerApiReady) {
                clearInterval(interval);
                resolve();
            }
        }, 250);
    });

    await webFrame.executeJavaScript(`
        window.ytmdPlayerBar = document.getElementsByTagName("ytmusic-player-bar")[0];
    `);

    createStyleSheet();
    createNavigationMenuArrows();
    createKeyboardNavigation();
    hideChromecastButton();
    hookPlayerApiEvents();

    const state = await store.get('state');
    const continueWhereYouLeftOff = (await store.get('playback')).continueWhereYouLeftOff;

    if (continueWhereYouLeftOff) {
        // The last page the user was on is already a page where it will be playing a song from (no point telling YTM to play it again)
        if (!state.lastUrl.startsWith("https://music.youtube.com/watch") && state.lastVideoId) {
            document.dispatchEvent(new CustomEvent('yt-navigate', {
                detail: {
                    endpoint: {
                        watchEndpoint: {
                            videoId: state.lastVideoId,
                            playlistId: state.lastPlaylistId
                        }
                    }
                }
            }));
        } else {
            webFrame.executeJavaScript(`
                window.ytmd.sendVideoData(window.ytmdPlayerBar.playerApi_.getPlayerResponse().videoDetails, window.ytmdPlayerBar.playerApi_.getPlaylistId());
            `);
        }
    }

    const alwaysShowVolumeSlider = (await store.get('general')).alwaysShowVolumeSlider;
    if (alwaysShowVolumeSlider) {
        document.querySelector("#volume-slider").classList.add("persist-volume-slider");
    }

    ipcRenderer.on('remoteControl:execute', async (event, command, value) => {
        if (command === 'playPause') {
            webFrame.executeJavaScript(`
                window.ytmdPlayerBar.playing_ ? window.ytmdPlayerBar.playerApi_.pauseVideo() : window.ytmdPlayerBar.playerApi_.playVideo();
            `);
        } else if (command === 'next') {
            webFrame.executeJavaScript(`
                window.ytmdPlayerBar.playerApi_.nextVideo();
            `);
        } else if (command === 'previous') {
            webFrame.executeJavaScript(`
                window.ytmdPlayerBar.playerApi_.previousVideo();
            `);
        } else if (command === 'thumbsUp') {
            // TODO
        } else if (command === 'thumbsDown') {
            // TODO
        } else if (command === 'volumeUp') {
            const currentVolume: number = await webFrame.executeJavaScript(`
                window.ytmdPlayerBar.playerApi_.getVolume();
            `);

            if (currentVolume < 100) {
                const newVolume = currentVolume + 10
                webFrame.executeJavaScript(`
                    window.ytmdPlayerBar.playerApi_.setVolume(${newVolume});
                    window.ytmdPlayerBar.store.dispatch({ type: 'SET_VOLUME', payload: ${newVolume} });
                `);
            }
        } else if (command === 'volumeDown') {
            const currentVolume: number = await webFrame.executeJavaScript(`
                window.ytmdPlayerBar.playerApi_.getVolume();
            `);

            if (currentVolume > 0) {
                const newVolume = currentVolume - 10
                webFrame.executeJavaScript(`
                    window.ytmdPlayerBar.playerApi_.setVolume(${newVolume});
                    window.ytmdPlayerBar.store.dispatch({ type: 'SET_VOLUME', payload: ${newVolume} });
                `);
            }
        } else if (command === 'navigate') {
            const endpoint = value;
            console.log('navigating from remote command', endpoint);
            document.dispatchEvent(new CustomEvent('yt-navigate', {
                detail: {
                    endpoint
                }
            }));
        }
    });

    store.onDidAnyChange((newState) => {
        if (newState.general.alwaysShowVolumeSlider) {
            const volumeSlider = document.querySelector("#volume-slider")
            if (!volumeSlider.classList.contains("persist-volume-slider")) {
                volumeSlider.classList.add("persist-volume-slider")
            }
        } else {
            const volumeSlider = document.querySelector("#volume-slider")
            if (volumeSlider.classList.contains("persist-volume-slider")) {
                volumeSlider.classList.remove("persist-volume-slider")
            }
        }
    });

    ipcRenderer.send('ytmView:loaded');
});