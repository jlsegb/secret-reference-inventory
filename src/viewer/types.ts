/** Internal display primitives used only by the app-owned builder. */
export type ViewerDisposition = "informational" | "review" | "inconclusive";

export type ViewerFactTone = "neutral" | "warning" | "positive";

/**
 * An identity-backed local request. The viewer server verifies issuance via a
 * private WeakMap before reading any request property, so an object literal,
 * Proxy, getter, or deserialized value cannot become a viewer input.
 */
declare const localReportViewerRequestBrand: unique symbol;
export type LocalReportViewerRequest = {
  readonly [localReportViewerRequestBrand]: true;
};

export interface LocalReportViewer {
  readonly address: {
    readonly host: "127.0.0.1";
    readonly port: number;
  };
  readonly url: URL;
  close(): Promise<void>;
}
