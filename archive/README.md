# Legacy surface archive

This directory keeps retired BooneTools frontend material recoverable without
shipping it in the Vite production bundle.

- `legacy-static-assets/` contains the classical-music playlist and the 100
  THORWizard images. Neither asset set is reachable from the active
  `src/main.js` application.
- `legacy-thorchad/` contains the retired THORWizard viewer that was the only
  consumer of the archived wizard image set.
- `legacy-sveltekit-shell/` contains the old `src/routes` tree and SvelteKit
  `src/app.html` template. BooneTools uses
  the plain Vite entry point and the router in `src/App.svelte`; the SvelteKit
  route tree was not compiled or served.

Restore a directory to its original path only together with an active route or
control that consumes it. Keeping these files here instead of under `public/`
prevents Vite from copying roughly 80 MB of unreachable media into every
production release.
