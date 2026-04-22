import { Component, OnInit } from '@angular/core';
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
export class AnalyticsComponent implements OnInit {

  // Time range
  selectedRange = '7d';
  ranges = [
    { value: '7d', label: 'Last 7 Days' },
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
    MTBF:0,
    MTTR:0,
    availability:0,
    avgProcessingTime:0,
    trends: { totalChange: null as number | null, passRateChange: null as number | null, confidenceChange: null as number | null }
  };

  loading = true;
  hasData = false;

  // Line chart — Inspections over time
  lineChartData: ChartData<'line'> = { labels: [], datasets: [] };
  lineChartOptions: ChartConfiguration<'line'>['options'] = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { labels: { color: '#8899aa', font: { family: "'JetBrains Mono', monospace", size: 11 } } },
      tooltip: { backgroundColor: '#111820', borderColor: '#1e2a3a', borderWidth: 1, titleFont: { family: "'JetBrains Mono', monospace" }, bodyFont: { family: "'JetBrains Mono', monospace" } }
    },
    scales: {
      x: { grid: { color: 'rgba(30, 42, 58, 0.5)' }, ticks: { color: '#556677', font: { family: "'JetBrains Mono', monospace", size: 10 } } },
      y: { beginAtZero: true, grid: { color: 'rgba(30, 42, 58, 0.5)' }, ticks: { color: '#556677', font: { family: "'JetBrains Mono', monospace", size: 10 } } }
    }
  };

  // Donut chart — Pass vs Fail
  donutChartData: ChartData<'doughnut'> = { labels: ['Pass', 'Fail'], datasets: [] };
  donutChartOptions: ChartConfiguration<'doughnut'>['options'] = {
    responsive: true,
    maintainAspectRatio: false,
    cutout: '65%',
    plugins: {
      legend: { position: 'bottom', labels: { color: '#8899aa', font: { family: "'JetBrains Mono', monospace", size: 11 }, padding: 16 } },
      tooltip: { backgroundColor: '#111820', borderColor: '#1e2a3a', borderWidth: 1 }
    }
  };

  // Histogram — Confidence distribution
  histChartData: ChartData<'bar'> = { labels: [], datasets: [] };
  histChartOptions: ChartConfiguration<'bar'>['options'] = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: { backgroundColor: '#111820', borderColor: '#1e2a3a', borderWidth: 1 }
    },
    scales: {
      x: { grid: { color: 'rgba(30, 42, 58, 0.5)' }, ticks: { color: '#556677', font: { family: "'JetBrains Mono', monospace", size: 10 } }, title: { display: true, text: 'Confidence %', color: '#556677', font: { family: "'JetBrains Mono', monospace", size: 11 } } },
      y: { beginAtZero: true, grid: { color: 'rgba(30, 42, 58, 0.5)' }, ticks: { color: '#556677', font: { family: "'JetBrains Mono', monospace", size: 10 } }, title: { display: true, text: 'Count', color: '#556677', font: { family: "'JetBrains Mono', monospace", size: 11 } } }
    }
  };

  // Bar chart — Defect type breakdown
  barChartData: ChartData<'bar'> = { labels: [], datasets: [] };
  barChartOptions: ChartConfiguration<'bar'>['options'] = {
    responsive: true,
    maintainAspectRatio: false,
    indexAxis: 'y',
    plugins: {
      legend: { display: false },
      tooltip: { backgroundColor: '#111820', borderColor: '#1e2a3a', borderWidth: 1 }
    },
    scales: {
      x: { beginAtZero: true, grid: { color: 'rgba(30, 42, 58, 0.5)' }, ticks: { color: '#556677', font: { family: "'JetBrains Mono', monospace", size: 10 } } },
      y: { grid: { display: false }, ticks: { color: '#8899aa', font: { family: "'JetBrains Mono', monospace", size: 11 } } }
    }
  };

  constructor(
    private apiService: ApiService,
    private authService: AuthService,
    public themeService: ThemeService
  ) {}

  ngOnInit() {
    this.loading = true;
    this.fetchAnalytics();
    
  }

  selectRange(range: string) {
  this.selectedRange = range;
  this.loading = true;
  this.fetchAnalytics();
}

  fetchAnalytics() {
    this.apiService.getAnalytics(this.selectedRange).subscribe({
      next: (data: any) => {
        this.kpis = data.kpis;
        this.hasData = data.kpis.totalInspections > 0;
        this.buildLineChart(data.dailyTrend);
        this.buildDonutChart(data.kpis);
        this.buildHistChart(data.confidenceDistribution);
        this.buildBarChart(data.defectTypeBreakdown);
        this.loading = false;
      },
      error: () => {
        this.loading = false;
        this.hasData = false;
      }
    });
  }

  private buildLineChart(dailyTrend: any[]) {
    this.lineChartData = {
      labels: dailyTrend.map(d => {
        const date = new Date(d._id);
        return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
      }),
      datasets: [
        {
          data: dailyTrend.map(d => d.total),
          label: 'Total',
          borderColor: '#00d4ff',
          backgroundColor: 'rgba(0, 212, 255, 0.08)',
          fill: true,
          tension: 0.3,
          pointRadius: 3,
          pointBackgroundColor: '#00d4ff'
        },
        {
          data: dailyTrend.map(d => d.passed),
          label: 'Passed',
          borderColor: '#22c55e',
          backgroundColor: 'rgba(34, 197, 94, 0.08)',
          fill: false,
          tension: 0.3,
          pointRadius: 2,
          pointBackgroundColor: '#22c55e'
        },
        {
          data: dailyTrend.map(d => d.failed),
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
    const passed = kpis.totalInspections - kpis.defective;
    this.donutChartData = {
      labels: [`Pass (${passed})`, `Fail (${kpis.defective})`],
      datasets: [{
        data: [passed, kpis.defective],
        backgroundColor: ['rgba(34, 197, 94, 0.7)', 'rgba(239, 68, 68, 0.7)'],
        borderColor: ['#22c55e', '#ef4444'],
        borderWidth: 1,
        hoverOffset: 6
      }]
    };
  }

  private buildHistChart(distribution: any[]) {
    const bucketLabels = ['0-10', '10-20', '20-30', '30-40', '40-50', '50-60', '60-70', '70-80', '80-90', '90-100'];
    const counts = new Array(10).fill(0);

    for (const bucket of distribution) {
      const idx = typeof bucket._id === 'number' ? Math.floor(bucket._id / 10) : -1;
      if (idx >= 0 && idx < 10) counts[idx] = bucket.count;
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
    if (breakdown.length === 0) {
      this.barChartData = { labels: ['No defects recorded'], datasets: [{ data: [0], backgroundColor: 'rgba(100, 116, 139, 0.3)', borderWidth: 0 }] };
        return;
    }

    this.barChartData = {
      labels: breakdown.map(d => d._id || 'Unknown Source'),
      datasets: [{
        data: breakdown.map(d => d.count),
        backgroundColor: 'rgba(239, 68, 68, 0.5)',
        borderColor: '#ef4444',
        borderWidth: 1,
        borderRadius: 3
      }]
    };
  }

  logout() {
    this.authService.logout();
  }
}
