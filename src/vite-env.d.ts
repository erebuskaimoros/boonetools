/// <reference types="svelte" />
/// <reference types="vite/client" />

declare function gtag(command: string, ...args: unknown[]): void;

interface Window {
  ethereum?: any;
  keplr?: any;
  leap?: any;
  cosmostation?: any;
  okxwallet?: any;
  phantom?: any;
  vultisig?: any;
  xfi?: any;
}
