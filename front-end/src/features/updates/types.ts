// The shape is declared globally in front-end/types.d.ts because the Electron
// main process and the renderer share it across the IPC boundary; these aliases
// give the feature barrel a normal import path.
export type UpdateInfo = UpdateCheckResult;
export type UpdateStatus = UpdateCheckStatus;
export type UpdateErrorCode = UpdateCheckErrorCode;
