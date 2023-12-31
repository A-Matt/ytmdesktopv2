export type StoreSchema = {
    general: {
        hideToTrayOnClose: boolean,
        showNotificationOnSongChange: boolean,
        startOnBoot: boolean,
        startMinimized: boolean,
        alwaysShowVolumeSlider: boolean
    },
    playback: {
        continueWhereYouLeftOff: boolean
        taskbarProgress: boolean
    },
    integrations: {
        companionServerEnabled: boolean,
        companionServerAuthWindowEnabled: string | null, // boolean | Encrypted for security
        companionServerAuthTokens: string | null, // array[object] | Encrypted for security
        discordPresenceEnabled: boolean
    },
    shortcuts: {
        playPause: string,
        next: string,
        previous: string,
        thumbsUp: string,
        thumbsDown: string,
        volumeUp: string,
        volumeDown: string
    }
    state: {
        lastUrl: string,
        lastVideoId: string,
        lastPlaylistId: string,
        companionServerAuthWindowEnableTime: string | null // string (ISO8601) | Encrypted for security
        windowBounds: Electron.Rectangle | null
        windowMaximized: boolean
    },

    notifications: {
        nowPlaying: boolean
    }
}