export type StoreSchema = {
    general: {
        hideToTrayOnClose: boolean,
        showNotificationOnSongChange: boolean,
        startOnBoot: boolean,
        startMinimized: boolean
    },
    playback: {
        continueWhereYouLeftOff: boolean
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
        lastPlaylistId: string
    }
}