import { platformBrowser } from '@angular/platform-browser';
import { AppModule } from './app/app.module';

// Boot tracer — writes a checkpoint to localStorage at each phase so that
// even if the page hangs, you can open DevTools > Application > Local Storage
// and read the LAST step that completed. This pinpoints which phase wedges.
function bootMark(step: string): void {
  try {
    const t = new Date().toISOString().slice(11, 23);
    const key = '__boot_trace__';
    const prev = localStorage.getItem(key) || '';
    localStorage.setItem(key, `${prev}${prev ? '\n' : ''}${t}  ${step}`);
    // eslint-disable-next-line no-console
    console.log('[boot]', t, step);
  } catch { /* localStorage may be unavailable in private mode */ }
}
// Reset on every page load so the trace is for THIS run only
try { localStorage.removeItem('__boot_trace__'); } catch {}
(window as any).__bootMark__ = bootMark;

// Tell the inline boot watchdog (in index.html) that JS has reached
// userland. If this line never runs, the watchdog will show a clean
// "App did not load" overlay with instructions to whitelist the
// extension — instead of leaving the user staring at a black screen.
(window as any).__shieldHide__?.();

bootMark('main.ts entered');

const platform = platformBrowser();
bootMark('platformBrowser() created');

bootMark('bootstrapModule(AppModule) called');
platform.bootstrapModule(AppModule, {})
  .then(() => bootMark('bootstrapModule resolved'))
  .catch(err => {
    bootMark('bootstrapModule REJECTED: ' + (err?.message || String(err)));
    console.error(err);
  });
