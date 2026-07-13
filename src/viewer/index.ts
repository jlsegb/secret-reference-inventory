/**
 * Deliberately tiny boundary: callers can start only an already-issued local
 * request. Request construction is app-internal and is not re-exported here.
 */
export { startLocalReportViewer } from "./server.js";
export type {
  LocalReportViewer,
  LocalReportViewerRequest,
} from "./types.js";
