import { ChangeDetectionStrategy, Component, Inject } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { ThemeService } from '../../services/theme.service';
import { ErrorLog } from '../../pages/worker/dashboard/dashboard.component';

export interface AlertsHistoryData {
  logs: ErrorLog[];
}

type Filter = 'all' | 'critical' | 'error' | 'warning' | 'info' | 'success';

@Component({
  selector: 'app-alerts-history-dialog',
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ah-root" [class.light]="themeService.isLight">
      <div class="ah-header">
        <div class="ah-title">
          <span class="ah-title-text">ALERTS &amp; ERROR LOGS</span>
          <span class="ah-count">{{ filtered().length }} / {{ data.logs.length }}</span>
        </div>
        <button class="ah-close" (click)="dialogRef.close()" aria-label="Close">&#10005;</button>
      </div>

      <div class="ah-toolbar">
        <input class="ah-search" type="text" placeholder="Search type, message, action…"
               [(ngModel)]="query" (input)="onChange()"/>
        <div class="ah-filters">
          <button *ngFor="let f of filters" class="ah-chip"
                  [class.active]="filter === f.key"
                  [ngClass]="'chip-' + f.key"
                  (click)="filter = f.key; onChange()">
            {{ f.label }}
          </button>
        </div>
      </div>

      <div class="ah-body">
        <div *ngIf="filtered().length === 0" class="ah-empty">No alerts match your filter.</div>
        <div *ngFor="let log of filtered()" class="ah-row" [ngClass]="'sev-' + log.severity"
             [class.resolved]="log.resolved">
          <div class="ah-sev-badge">{{ log.severity | uppercase }}</div>
          <div class="ah-info">
            <div class="ah-type">{{ log.errorType }}</div>
            <div class="ah-msg">{{ log.message }}</div>
            <div class="ah-action" *ngIf="log.suggestedAction">→ {{ log.suggestedAction }}</div>
          </div>
          <div class="ah-meta">
            <span class="ah-ts">{{ log.timestamp | date:'HH:mm:ss · dd MMM yyyy' }}</span>
            <span class="ah-status" *ngIf="log.resolved">✓ Resolved</span>
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .ah-root {
      display: flex; flex-direction: column;
      min-width: 640px; max-width: 920px;
      width: 80vw; max-height: 78vh;
      background: #0f1620; color: #dde6f0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      border-radius: 6px;
    }
    .ah-root.light { background: #ffffff; color: #162030; }

    .ah-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 12px 16px;
      border-bottom: 1px solid #1c2840;
    }
    .ah-root.light .ah-header { border-bottom-color: #d0dae8; }
    .ah-title { display: flex; align-items: center; gap: 10px; }
    .ah-title-text {
      font-size: 12px; font-weight: 700; letter-spacing: .12em;
      color: #7a90aa;
    }
    .ah-count {
      font-family: 'JetBrains Mono', monospace; font-size: 11px;
      background: rgba(0,212,255,.1); color: #00d4ff;
      padding: 2px 8px; border-radius: 8px;
    }
    .ah-close {
      background: none; border: 1px solid #1c2840;
      color: #7a90aa; width: 26px; height: 26px;
      border-radius: 4px; cursor: pointer; font-size: 13px;
      transition: all .15s;
    }
    .ah-close:hover { color: #ef4444; border-color: #ef4444; }
    .ah-root.light .ah-close { border-color: #d0dae8; color: #445566; }

    .ah-toolbar {
      display: flex; gap: 10px; padding: 10px 16px;
      border-bottom: 1px solid #1c2840;
      flex-wrap: wrap; align-items: center;
    }
    .ah-root.light .ah-toolbar { border-bottom-color: #d0dae8; }
    .ah-search {
      flex: 1; min-width: 200px;
      background: #131b27; border: 1px solid #1c2840;
      color: inherit; padding: 7px 10px;
      border-radius: 4px; font-size: 12px;
      outline: none; transition: border-color .15s;
    }
    .ah-search:focus { border-color: #00d4ff; }
    .ah-root.light .ah-search { background: #f4f7fb; border-color: #d0dae8; }

    .ah-filters { display: flex; gap: 5px; flex-wrap: wrap; }
    .ah-chip {
      background: transparent; border: 1px solid #1c2840;
      color: #7a90aa; padding: 4px 10px;
      border-radius: 10px; font-size: 10px; font-weight: 700;
      letter-spacing: .06em; cursor: pointer;
      text-transform: uppercase; transition: all .15s;
    }
    .ah-chip:hover { color: #dde6f0; border-color: #243050; }
    .ah-root.light .ah-chip { border-color: #d0dae8; color: #445566; }
    .ah-root.light .ah-chip:hover { color: #162030; }
    .ah-chip.active { color: #fff; border-color: transparent; }
    .ah-chip.active.chip-all      { background: #00d4ff; color: #062130; }
    .ah-chip.active.chip-critical { background: #ef4444; }
    .ah-chip.active.chip-error    { background: #f97316; }
    .ah-chip.active.chip-warning  { background: #f59e0b; color: #1f1300; }
    .ah-chip.active.chip-info     { background: #00d4ff; color: #062130; }
    .ah-chip.active.chip-success  { background: #22c55e; }

    .ah-body {
      flex: 1; overflow-y: auto; padding: 4px 0;
      scrollbar-width: thin; scrollbar-color: #243050 transparent;
    }
    .ah-body::-webkit-scrollbar { width: 8px; }
    .ah-body::-webkit-scrollbar-thumb { background: #243050; border-radius: 4px; }
    .ah-body::-webkit-scrollbar-thumb:hover { background: #2f3d60; }
    .ah-root.light .ah-body { scrollbar-color: #c0cad8 transparent; }
    .ah-root.light .ah-body::-webkit-scrollbar-thumb { background: #c0cad8; }

    .ah-empty {
      padding: 24px 16px; text-align: center;
      color: #7a90aa; font-size: 12px;
    }

    .ah-row {
      display: grid;
      grid-template-columns: 80px 1fr auto;
      gap: 12px; padding: 10px 16px;
      border-bottom: 1px solid #1c2840;
      border-left: 3px solid transparent;
      align-items: flex-start;
    }
    .ah-root.light .ah-row { border-bottom-color: #e3e9f2; }
    .ah-row.sev-critical { border-left-color: #ef4444; }
    .ah-row.sev-error    { border-left-color: #f97316; }
    .ah-row.sev-warning  { border-left-color: #f59e0b; }
    .ah-row.resolved { opacity: .55; }

    .ah-sev-badge {
      font-family: 'JetBrains Mono', monospace; font-size: 9px; font-weight: 700;
      padding: 3px 7px; border-radius: 8px; text-align: center;
      background: rgba(128,128,128,.12); color: #7a90aa;
    }
    .ah-row.sev-critical .ah-sev-badge { background: rgba(239,68,68,.12);  color: #ef4444; }
    .ah-row.sev-error    .ah-sev-badge { background: rgba(249,115,22,.12); color: #f97316; }
    .ah-row.sev-warning  .ah-sev-badge { background: rgba(245,158,11,.12); color: #f59e0b; }

    .ah-info { min-width: 0; }
    .ah-type { font-size: 12px; font-weight: 700; }
    .ah-msg  { font-size: 12px; color: #7a90aa; margin-top: 3px; line-height: 1.4; }
    .ah-action { font-size: 11px; color: #00d4ff; margin-top: 3px; font-style: italic; }
    .ah-root.light .ah-msg { color: #445566; }

    .ah-meta {
      display: flex; flex-direction: column;
      align-items: flex-end; gap: 3px;
      font-family: 'JetBrains Mono', monospace; font-size: 10px;
      color: #7a90aa; white-space: nowrap;
    }
    .ah-status { color: #22c55e; }
  `]
})
export class AlertsHistoryDialogComponent {
  query = '';
  filter: Filter = 'all';
  filters: { key: Filter; label: string }[] = [
    { key: 'all',      label: 'All' },
    { key: 'critical', label: 'Critical' },
    { key: 'error',    label: 'Error' },
    { key: 'warning',  label: 'Warning' },
    { key: 'info',     label: 'Info' },
    { key: 'success',  label: 'Success' },
  ];

  private cache: ErrorLog[] = [];
  private cacheKey = '';

  constructor(
    public dialogRef: MatDialogRef<AlertsHistoryDialogComponent>,
    public themeService: ThemeService,
    @Inject(MAT_DIALOG_DATA) public data: AlertsHistoryData
  ) {}

  onChange(): void { this.cacheKey = ''; }

  filtered(): ErrorLog[] {
    const key = this.filter + '|' + this.query.toLowerCase().trim();
    if (key === this.cacheKey) return this.cache;
    const q = this.query.toLowerCase().trim();
    this.cache = (this.data.logs || []).filter(l => {
      if (this.filter !== 'all' && String(l.severity).toLowerCase() !== this.filter) return false;
      if (!q) return true;
      return (l.errorType || '').toLowerCase().includes(q)
          || (l.message || '').toLowerCase().includes(q)
          || (l.suggestedAction || '').toLowerCase().includes(q);
    });
    this.cacheKey = key;
    return this.cache;
  }
}
