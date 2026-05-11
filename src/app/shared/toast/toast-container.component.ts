import { ChangeDetectionStrategy, Component } from '@angular/core';
import { ToastService, Toast } from './toast.service';
import { ThemeService } from '../../services/theme.service';

@Component({
  selector: 'app-toast-container',
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="toast-stack" [class.light]="themeService.isLight" aria-live="polite" role="status">
      <div *ngFor="let t of (toasts.stream | async); trackBy: trackById"
           class="toast" [ngClass]="'toast-' + t.type"
           (click)="toasts.dismiss(t.id)">
        <span class="toast-icon">
          <ng-container [ngSwitch]="t.type">
            <span *ngSwitchCase="'success'">&#10003;</span>
            <span *ngSwitchCase="'warning'">!</span>
            <span *ngSwitchCase="'error'">&#10005;</span>
            <span *ngSwitchDefault>i</span>
          </ng-container>
        </span>
        <span class="toast-msg">{{ t.message }}</span>
        <button class="toast-close" (click)="$event.stopPropagation(); toasts.dismiss(t.id)" aria-label="Dismiss">&#10005;</button>
      </div>
    </div>
  `,
  styles: [`
    .toast-stack {
      position: fixed;
      top: 16px;
      right: 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      z-index: 9999;
      pointer-events: none;
      max-width: 360px;
    }
    .toast {
      pointer-events: auto;
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 10px 12px;
      border-radius: 6px;
      border: 1px solid rgba(255,255,255,.08);
      background: #0f1620;
      color: #dde6f0;
      box-shadow: 0 6px 18px rgba(0,0,0,0.45);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      font-size: 13px;
      line-height: 1.35;
      cursor: pointer;
      animation: toast-in .22s ease-out;
      border-left: 4px solid #6b7280;
      min-width: 240px;
    }
    .toast.toast-success { border-left-color: #22c55e; }
    .toast.toast-warning { border-left-color: #f59e0b; }
    .toast.toast-error   { border-left-color: #ef4444; }
    .toast.toast-info    { border-left-color: #00d4ff; }

    .toast-icon {
      flex-shrink: 0;
      width: 20px; height: 20px;
      display: flex; align-items: center; justify-content: center;
      border-radius: 50%;
      font-weight: 700;
      font-size: 12px;
      color: #fff;
      background: #6b7280;
    }
    .toast-success .toast-icon { background: #22c55e; }
    .toast-warning .toast-icon { background: #f59e0b; }
    .toast-error   .toast-icon { background: #ef4444; }
    .toast-info    .toast-icon { background: #00d4ff; color: #062130; }

    .toast-msg { flex: 1; word-break: break-word; }

    .toast-close {
      background: none; border: none; cursor: pointer;
      color: inherit; opacity: .55;
      font-size: 13px; padding: 0 2px;
      transition: opacity .15s;
    }
    .toast-close:hover { opacity: 1; }

    /* Light mode */
    .toast-stack.light .toast {
      background: #ffffff;
      color: #162030;
      border-color: #d0dae8;
      box-shadow: 0 4px 14px rgba(20,40,80,.18);
    }

    @keyframes toast-in {
      from { opacity: 0; transform: translateX(20px) scale(.96); }
      to   { opacity: 1; transform: translateX(0) scale(1); }
    }
  `]
})
export class ToastContainerComponent {
  constructor(public toasts: ToastService, public themeService: ThemeService) {}
  trackById(_: number, t: Toast) { return t.id; }
}
