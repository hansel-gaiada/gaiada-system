// DW-6i UI: the one place Google's script is loaded and its Picker is opened (BFF §42.6). Client-only, no imports, so it can be
// tested with a fake `window.gapi` and `window.google`.
//
// * The script (`https://apis.google.com/js/api.js`) is loaded on the first click, once; a second click reuses the same promise.
//   A failed load clears it so the next click tries again.
// * The access token is handed to the Picker builder and goes nowhere else: not to storage, not to the console, not into state.
// * The Picker answers with the picked documents; this returns their ids (an empty list for a cancel), and the caller attaches them.

export const GAPI_SRC = "https://apis.google.com/js/api.js";

interface PickerResponseDoc { [key: string]: unknown }
interface PickerBuilderLike {
  addView(view: unknown): PickerBuilderLike;
  enableFeature(feature: unknown): PickerBuilderLike;
  setOAuthToken(token: string): PickerBuilderLike;
  setDeveloperKey(key: string): PickerBuilderLike;
  setAppId(appId: string): PickerBuilderLike;
  setCallback(cb: (data: Record<string, unknown>) => void): PickerBuilderLike;
  build(): { setVisible(visible: boolean): void };
}
interface GooglePickerLike {
  PickerBuilder: new () => PickerBuilderLike;
  ViewId: { DOCS: unknown };
  Feature: { MULTISELECT_ENABLED: unknown };
  Action: { PICKED: string; CANCEL: string };
  Response: { ACTION: string; DOCUMENTS: string };
  Document: { ID: string };
}
interface GapiLike {
  load(api: string, opts: { callback: () => void; onerror?: () => void }): void;
}
type DriveWindow = Window & { gapi?: GapiLike; google?: { picker?: GooglePickerLike } };

let scriptPromise: Promise<void> | null = null;
let pickerApiPromise: Promise<void> | null = null;

/** Test hook: forget the loaded state. */
export function resetDrivePickerLoader(): void {
  scriptPromise = null;
  pickerApiPromise = null;
}

function loadScript(): Promise<void> {
  if (scriptPromise) return scriptPromise;
  const w = window as DriveWindow;
  const p = new Promise<void>((resolve, reject) => {
    if (w.gapi?.load) return resolve();
    const el = document.createElement("script");
    el.src = GAPI_SRC;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error("Google's Picker script could not be loaded."));
    document.head.appendChild(el);
  });
  scriptPromise = p;
  p.catch(() => {
    if (scriptPromise === p) scriptPromise = null;
  });
  return p;
}

function loadPickerApi(): Promise<void> {
  if (pickerApiPromise) return pickerApiPromise;
  const p = loadScript().then(
    () =>
      new Promise<void>((resolve, reject) => {
        const gapi = (window as DriveWindow).gapi;
        if (!gapi?.load) return reject(new Error("Google's Picker script did not start."));
        gapi.load("picker", { callback: () => resolve(), onerror: () => reject(new Error("Google's Picker could not be loaded.")) });
      }),
  );
  pickerApiPromise = p;
  p.catch(() => {
    if (pickerApiPromise === p) pickerApiPromise = null;
  });
  return p;
}

export interface PickerOptions {
  accessToken: string;
  apiKey: string;
  appId: string;
}

/** Opens Google's Picker (multi-select) and resolves with the picked file ids, or `[]` when the person cancels. */
export async function openDrivePicker(opts: PickerOptions): Promise<string[]> {
  await loadPickerApi();
  const g = (window as DriveWindow).google?.picker;
  if (!g) throw new Error("Google's Picker did not start.");
  return new Promise<string[]>((resolve) => {
    const picker = new g.PickerBuilder()
      .addView(g.ViewId.DOCS)
      .enableFeature(g.Feature.MULTISELECT_ENABLED)
      .setOAuthToken(opts.accessToken)
      .setDeveloperKey(opts.apiKey)
      .setAppId(opts.appId)
      .setCallback((data) => {
        const action = data[g.Response.ACTION];
        if (action === g.Action.PICKED) {
          const docs = (data[g.Response.DOCUMENTS] as PickerResponseDoc[] | undefined) ?? [];
          resolve(docs.map((d) => d[g.Document.ID]).filter((id): id is string => typeof id === "string" && id.length > 0));
        } else if (action === g.Action.CANCEL) {
          resolve([]);
        }
      })
      .build();
    picker.setVisible(true);
  });
}
