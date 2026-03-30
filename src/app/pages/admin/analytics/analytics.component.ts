import { Component } from '@angular/core';
import { AuthService } from '../../../services/auth.service';

@Component({
  selector: 'app-analytics',
  templateUrl: './analytics.component.html',
  styleUrls: ['./analytics.component.css'],
  standalone: false
})
export class AnalyticsComponent {
  constructor(private authService: AuthService) { }

  logout() {
    this.authService.logout();
  }

  // Placeholder for chart data and logic
  public chartData = [
    { data: [65, 59, 80, 81, 56, 55, 40], label: 'Defect Rate' },
    { data: [28, 48, 40, 19, 86, 27, 90], label: 'Throughput' }
  ];
  public chartLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  public chartOptions = {
    responsive: true,
    scales: {
      y: {
        beginAtZero: true,
        grid: { color: 'rgba(255,255,255,0.1)' },
        ticks: { color: 'white' }
      },
      x: {
        grid: { color: 'rgba(255,255,255,0.1)' },
        ticks: { color: 'white' }
      }
    },
    plugins: {
      legend: { labels: { color: 'white' } }
    }
  };
}
