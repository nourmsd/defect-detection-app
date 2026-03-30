import { Component, OnInit, OnDestroy } from '@angular/core';
import { SocketService } from '../../../services/socket.service';
import { AuthService } from '../../../services/auth.service';
import { ThemeService } from '../../../services/theme.service';
import { ApiService, Inspection } from '../../../services/api.service';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Subscription } from 'rxjs';

@Component({
  selector: 'app-worker-dashboard',
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.css'],
  standalone: false
})
export class WorkerDashboardComponent implements OnInit, OnDestroy {
  alerts: any[] = [];
  inspections: Inspection[] = [];
  defectRate = 0;
  normalRate = 0;
  totalInspections = 0;
  displayedColumns: string[] = ['id', 'label', 'timestamp'];
  private alertSubscription?: Subscription;

  constructor(
    private socketService: SocketService,
    private authService: AuthService,
    private apiService: ApiService,
    public themeService: ThemeService,
    private snackBar: MatSnackBar
  ) { }

  ngOnInit() {
    this.fetchInspections();

    this.alertSubscription = this.socketService.alerts$.subscribe(alert => {
      this.alerts.unshift(alert);
      this.snackBar.open(alert.message, 'Close', { 
        duration: 5000,
        panelClass: ['alert-snackbar', `alert-${alert.type}`]
      });
      // Limit to last 5 alerts for worker
      if (this.alerts.length > 5) this.alerts.pop();
      
      // Refresh inspections list on new alert
      this.fetchInspections();
    });
  }

  fetchInspections() {
    this.apiService.getInspections().subscribe({
      next: (data) => {
        this.totalInspections = data.length;
        this.inspections = data.slice(0, 5); // display only last 5
        this.calculateMetrics(data);
      },
      error: (err) => console.error('Failed to fetch inspections', err)
    });
  }

  private calculateMetrics(data: Inspection[]) {
    if (data.length === 0) return;
    const defects = data.filter(i => i.label === 'defective').length;
    const normal = data.filter(i => i.label === 'OK').length;
    this.defectRate = (defects / data.length) * 100;
    this.normalRate = (normal / data.length) * 100;
  }

  ngOnDestroy() {
    this.alertSubscription?.unsubscribe();
  }

  logout() {
    this.authService.logout();
  }
}
