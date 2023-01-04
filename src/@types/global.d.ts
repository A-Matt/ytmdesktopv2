import Store from "../shared/store/renderer";
import { StoreSchema } from "../shared/store/schema";

declare global {
    interface Window {
        ytmd: {
            store: Store<StoreSchema>,
            minimizeWindow(): void,
            maximizeWindow(): void,
            restoreWindow(): void,
            closeWindow(): void,
            handleWindowEvents(callback: (event: Electron.IpcRendererEvent, ...args: any[]) => void),
            openSettingsWindow(): void
        }
    }
}