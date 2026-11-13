// Minimal declarations for web platform globals available in both
// modern browsers and Node 20+. We avoid the full DOM lib on purpose so
// the core engine cannot accidentally depend on browser-only APIs.

declare function btoa(data: string): string;
declare function atob(data: string): string;

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

declare class TextDecoder {
  decode(input?: Uint8Array): string;
}
