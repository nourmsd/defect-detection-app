import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { Subscription } from 'rxjs';
import { ApiService } from '../../../services/api.service';
import { AuthService } from '../../../services/auth.service';
import { ThemeService } from '../../../services/theme.service';
import { ChartConfiguration, ChartData } from 'chart.js';

@Component({
  selector: 'app-analytics',
  templateUrl: './analytics.component.html',
  styleUrls: ['./analytics.component.css'],
  standalone: false
})
export class AnalyticsComponent implements OnInit, OnDestroy {
  private _themeSub?: Subscription;

  // Time range
  selectedRange = '7d';
  ranges = [
    { value: '7d',  label: 'Last 7 Days' },
    { value: '30d', label: 'Last 30 Days' },
    { value: '90d', label: 'Last 3 Months' },
    { value: 'all', label: 'All Time' }
  ];

  // KPIs
  kpis = {
    totalInspections: 0,
    passRate: 0,
    avgConfidence: 0,
    defective: 0,
    MTBF: 0,
    MTTR: 0,
    availability: 0,
    avgProcessingTime: 0,
    trends: {
      totalChange: null as number | null,
      passRateChange: null as number | null,
      confidenceChange: null as number | null
    }
  };

  loading = true;
  hasData = false;
  errorMessage: string | null = null;

  // Charts data
  lineChartData: ChartData<'line'>      = { labels: [], datasets: [] };
  donutChartData: ChartData<'doughnut'> = { labels: ['Pass', 'Fail'], datasets: [] };
  histChartData: ChartData<'bar'>       = { labels: [], datasets: [] };
  barChartData: ChartData<'bar'>        = { labels: [], datasets: [] };

  // Theme-aware chart option getters
  private get _tc() {
    return this.themeService.isLight
      ? { legend: '#4a5568', tick: '#8893a4', grid: 'rgba(200,210,220,0.4)', tooltip: { bg: '#ffffff', border: '#d8dde6' } }
      : { legend: '#8899aa', tick: '#556677', grid: 'rgba(30,42,58,0.5)',   tooltip: { bg: '#111820', border: '#1e2a3a' } };
  }

  get lineChartOptions(): ChartConfiguration<'line'>['options'] {
    const tc = this._tc;
    return {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: tc.legend, font: { family: "'JetBrains Mono', monospace", size: 11 } } },
        tooltip: { backgroundColor: tc.tooltip.bg, borderColor: tc.tooltip.border, borderWidth: 1, titleFont: { family: "'JetBrains Mono', monospace" }, bodyFont: { family: "'JetBrains Mono', monospace" } }
      },
      scales: {
        x: { grid: { color: tc.grid }, ticks: { color: tc.tick, font: { family: "'JetBrains Mono', monospace", size: 10 } } },
        y: { beginAtZero: true, grid: { color: tc.grid }, ticks: { color: tc.tick, font: { family: "'JetBrains Mono', monospace", size: 10 } } }
      }
    };
  }

  get donutChartOptions(): ChartConfiguration<'doughnut'>['options'] {
    const tc = this._tc;
    return {
      responsive: true, maintainAspectRatio: false, cutout: '65%',
      plugins: {
        legend: { position: 'bottom', labels: { color: tc.legend, font: { family: "'JetBrains Mono', monospace", size: 11 }, padding: 16 } },
        tooltip: { backgroundColor: tc.tooltip.bg, borderColor: tc.tooltip.border, borderWidth: 1 }
      }
    };
  }

  get histChartOptions(): ChartConfiguration<'bar'>['options'] {
    const tc = this._tc;
    return {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { backgroundColor: tc.tooltip.bg, borderColor: tc.tooltip.border, borderWidth: 1 }
      },
      scales: {
        x: { grid: { color: tc.grid }, ticks: { color: tc.tick, font: { family: "'JetBrains Mono', monospace", size: 10 } }, title: { display: true, text: 'Confidence %', color: tc.tick, font: { family: "'JetBrains Mono', monospace", size: 11 } } },
        y: { beginAtZero: true, grid: { color: tc.grid }, ticks: { color: tc.tick, font: { family: "'JetBrains Mono', monospace", size: 10 } }, title: { display: true, text: 'Count', color: tc.tick, font: { family: "'JetBrains Mono', monospace", size: 11 } } }
      }
    };
  }

  get barChartOptions(): ChartConfiguration<'bar'>['options'] {
    const tc = this._tc;
    return {
      responsive: true, maintainAspectRatio: false, indexAxis: 'y',
      plugins: {
        legend: { display: false },
        tooltip: { backgroundColor: tc.tooltip.bg, borderColor: tc.tooltip.border, borderWidth: 1 }
      },
      scales: {
        x: { beginAtZero: true, grid: { color: tc.grid }, ticks: { color: tc.tick, font: { family: "'JetBrains Mono', monospace", size: 10 } } },
        y: { grid: { display: false }, ticks: { color: tc.legend, font: { family: "'JetBrains Mono', monospace", size: 11 } } }
      }
    };
  }

  constructor(
    private apiService: ApiService,
    private authService: AuthService,
    public themeService: ThemeService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit() {
    this.loading = true;
    this.fetchAnalytics();
  }

  selectRange(range: string) {
    this.selectedRange = range;
    this.loading = true;
    this.errorMessage = null;
    this.fetchAnalytics();
  }

  fetchAnalytics() {
    this.loading = true;
    this.errorMessage = null;

    this.apiService.getAnalytics(this.selectedRange).subscribe({
      next: (data: any) => {
        try {
          const kpis = data?.kpis || {};
          this.kpis = {
            totalInspections: kpis.totalInspections ?? 0,
            passRate:          kpis.passRate    != null ? Number(kpis.passRate.toFixed(1))    : 0,
            avgConfidence:     kpis.avgConfidence != null ? Number(kpis.avgConfidence.toFixed(1)) : 0,
            defective:         kpis.defective    ?? 0,
            MTBF:              kpis.MTBF         ?? 0,
            MTTR:              kpis.MTTR         ?? 0,
            availability:      kpis.availability ?? 0,
            avgProcessingTime: kpis.avgProcessingTime ?? 0,
            trends: { totalChange: null, passRateChange: null, confidenceChange: null }
          };

          this.hasData = this.kpis.totalInspections > 0;

          this.buildLineChart(data.dailyTrend || []);
          this.buildDonutChart(this.kpis);
          this.buildHistChart(data.confidenceDistribution || []);
          this.buildBarChart(data.defectTypeBreakdown || []);
        } catch (e) {
          console.error('[analytics] data processing error', e);
          this.hasData = false;
          this.errorMessage = 'Unable to process analytics data';
        } finally {
          this.loading = false;
          this.cdr.markForCheck();
        }
      },
      error: (err) => {
        this.loading = false;
        this.hasData = false;
        if (err?.name === 'TimeoutError') {
          this.errorMessage = 'Server timeout — retry';
        } else if (err?.status === 0) {
          this.errorMessage = 'Unable to load data — backend unreachable';
        } else if (err?.status === 403) {
          this.errorMessage = 'Access denied';
        } else {
          this.errorMessage = 'Unable to load analytics';
        }
        this.cdr.markForCheck();
      }
    });
  }

  private buildLineChart(dailyTrend: any[]) {
    if (!dailyTrend?.length) {
      this.lineChartData = { labels: [], datasets: [] };
      return;
    }
    this.lineChartData = {
      labels: dailyTrend.map(d => {
        const date = new Date(d._id + 'T00:00:00');
        return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
      }),
      datasets: [
        {
          data: dailyTrend.map(d => d.total ?? 0),
          label: 'Total',
          borderColor: '#00d4ff',
          backgroundColor: 'rgba(0, 212, 255, 0.08)',
          fill: true,
          tension: 0.3,
          pointRadius: 3,
          pointBackgroundColor: '#00d4ff'
        },
        {
          data: dailyTrend.map(d => (d.total ?? 0) - (d.defective ?? 0)),
          label: 'Passed',
          borderColor: '#22c55e',
          backgroundColor: 'rgba(34, 197, 94, 0.08)',
          fill: false,
          tension: 0.3,
          pointRadius: 2,
          pointBackgroundColor: '#22c55e'
        },
        {
          data: dailyTrend.map(d => d.defective ?? 0),
          label: 'Failed',
          borderColor: '#ef4444',
          backgroundColor: 'rgba(239, 68, 68, 0.08)',
          fill: false,
          tension: 0.3,
          pointRadius: 2,
          pointBackgroundColor: '#ef4444'
        }
      ]
    };
  }

  private buildDonutChart(kpis: any) {
    const passed = (kpis.totalInspections ?? 0) - (kpis.defective ?? 0);
    const failed = kpis.defective ?? 0;
    // Provide at least a zero-value slice so the chart renders instead of crashing.
    this.donutChartData = {
      labels: [`Pass (${passed})`, `Fail (${failed})`],
      datasets: [{
        data: [Math.max(passed, 0), Math.max(failed, 0)],
        backgroundColor: ['rgba(34, 197, 94, 0.7)', 'rgba(239, 68, 68, 0.7)'],
        borderColor: ['#22c55e', '#ef4444'],
        borderWidth: 1,
        hoverOffset: 6
      }]
    };
  }

  private buildHistChart(distribution: any[]) {
    const bucketLabels = ['0-10','10-20','20-30','30-40','40-50','50-60','60-70','70-80','80-90','90-100'];
    const counts = new Array(10).fill(0);

    for (const bucket of (distribution || [])) {
      const raw = typeof bucket._id === 'number' ? bucket._id : -1;
      // _id == 10 means exactly 100 % → clamp to bucket 9
      const idx = Math.min(raw, 9);
      if (idx >= 0 && idx < 10) counts[idx] = bucket.count ?? 0;
    }

    this.histChartData = {
      labels: bucketLabels,
      datasets: [{
        data: counts,
        label: 'Inspections',
        backgroundColor: 'rgba(0, 212, 255, 0.5)',
        borderColor: '#00d4ff',
        borderWidth: 1,
        borderRadius: 3
      }]
    };
  }

  private buildBarChart(breakdown: any[]) {
    if (!breakdown?.length) {
      this.barChartData = {
        labels: ['No defects recorded'],
        datasets: [{ data: [0], backgroundColor: 'rgba(100, 116, 139, 0.3)', borderWidth: 0 }]
      };
      return;
    }

    this.barChartData = {
      labels: breakdown.map(d => d._id || 'Unknown Source'),
      datasets: [{
        data: breakdown.map(d => d.count ?? 0),
        backgroundColor: 'rgba(239, 68, 68, 0.5)',
        borderColor: '#ef4444',
        borderWidth: 1,
        borderRadius: 3
      }]
    };
  }

  ngOnDestroy() {
    this._themeSub?.unsubscribe();
  }

  logout() {
    this.authService.logout();
  }
}
