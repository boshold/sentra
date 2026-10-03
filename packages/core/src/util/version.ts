declare const __VERSION__: string;

export const VERSION: string = typeof __VERSION__ === "undefined" ? "dev" : __VERSION__;
