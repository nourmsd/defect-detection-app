import { Component, OnInit, OnDestroy } from '@angular/core';
import { SocketService } from '../../../services/socket.service';
import { AuthService } from '../../../services/auth.service';
import { ThemeService } from '../../../services/theme.service';
import { ApiService, Inspection, WorkerStats } from '../../../services/api.service';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Subscription, interval } from 'rxjs';
import { map } from 'rxjs/operators';

@Component({
  selector: 'app-worker-dashboard',
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.css'],
  standalone: false
})
export class WorkerDashboardComponent implements OnInit, OnDestroy {
  // User
  username = '';

  // Inspection data
  inspections: Inspection[] = [];
  normalCount = 0;
  defectCount = 0;
  totalInspections = 0;
  defectRate = 0;

  // Today's stats
  todayTotal = 0;
  todayOk = 0;
  todayDefective = 0;
  lastHourCount = 0;

  // Live telemetry
  currentTime = '';
  currentDate = '';
  confidenceScore = 0;
  detectionStatus: 'WAITING' | 'OK' | 'DEFECTIVE' = 'WAITING';
  lastDetectionTime = '--:--:--';
  lastDetectionDevice = '--';

  // Connection state (driven by real socket/API status)
  socketConnected = false;
  serverOnline = false;
  databaseOnline = false;

  // Alerts queue
  alerts: Array<{ type: string; message: string; time: string }> = [];
  hasUnreadAlert = false;

  private subscriptions = new Subscription();

  constructor(
    private socketService: SocketService,
    private authService: AuthService,
    private apiService: ApiService,
    public themeService: ThemeService,
    private snackBar: MatSnackBar
  ) {}

  ngOnInit() {
    const user = this.authService.userValue;
    this.username = user?.username || 'Worker';

    this.startClock();
    this.fetchInspections();
    this.fetchStats();
    this.checkHealth();

    // Poll stats every 30s to keep dashboard fresh
    const statsPoll = interval(30000).subscribe(() => {
      this.fetchStats();
      this.checkHealth();
    });
    this.subscriptions.add(statsPoll);

    // Socket connection status
    const connSub = this.socketService.connected$.subscribe(connected => {
      this.socketConnected = connected;
    });
    this.subscriptions.add(connSub);

    // Real-time: new inspection arrives
    const inspSub = this.socketService.newInspection$.subscribe(inspection => {
      this.handleNewInspection(inspection);
    });
    this.subscriptions.add(inspSub);

    // Real-time: defect alert
    const alertSub = this.socketService.alerts$.subscribe(alert => {
      this.handleAlert(alert);
    });
    this.subscriptions.add(alertSub);
  }

  private startClock() {
    // Immediate update
    this.updateDateTime();
    const clockSub = interval(1000).pipe(
      map(() => this.updateDateTime())
    ).subscribe();
    this.subscriptions.add(clockSub);
  }

  private updateDateTime() {
    const now = new Date();
    this.currentTime = now.toLocaleTimeString('en-GB', { hour12: false });
    this.currentDate = now.toLocaleDateString('en-GB', {
      weekday: 'short', day: '2-digit', month: 'short', year: 'numeric'
    });
  }

  fetchInspections() {
    this.apiService.getInspections().subscribe({
      next: (data) => {
        this.inspections = data.slice(0, 15);
        if (data.length > 0) {
          const latest = data[0];
          this.detectionStatus = latest.label === 'OK' ? 'OK' : 'DEFECTIVE';
          this.confidenceScore = latest.confidence || 0;
          this.lastDetectionTime = new Date(latest.timestamp).toLocaleTimeString('en-GB', { hour12: false });
          this.lastDetectionDevice = latest.device || 'Camera 1';
        }
      },
      error: () => {}
    });
  }

  fetchStats() {
    this.apiService.getWorkerStats().subscribe({
      next: (stats) => {
        this.totalInspections = stats.total;
        this.normalCount = stats.ok;
        this.defectCount = stats.defective;
        this.defectRate = stats.defectRate;
        this.todayTotal = stats.today.total;
        this.todayOk = stats.today.ok;
        this.todayDefective = stats.today.defective;
        this.lastHourCount = stats.lastHourCount;
      },
      error: () => {}
    });
  }

  checkHealth() {
    this.apiService.getHealth().subscribe({
      next: (health) => {
        this.serverOnline = health.server;
        this.databaseOnline = health.database;
      },
      error: () => {
        this.serverOnline = false;
        this.databaseOnline = false;
      }
    });
  }

  private handleNewInspection(inspection: any) {
    // Prepend to list, keep max 15
    this.inspections.unshift(inspection);
    if (this.inspections.length > 15) this.inspections.pop();

    // Update live status
    this.detectionStatus = inspection.label === 'OK' ? 'OK' : 'DEFECTIVE';
    this.confidenceScore = inspection.confidence || 0;
    this.lastDetectionTime = new Date(inspection.timestamp).toLocaleTimeString('en-GB', { hour12: false });
    this.lastDetectionDevice = inspection.device || 'Camera 1';

    // Update counters
    this.totalInspections++;
    this.todayTotal++;
    if (inspection.label === 'OK') {
      this.normalCount++;
      this.todayOk++;
    } else {
      this.defectCount++;
      this.todayDefective++;
    }
    this.defectRate = this.totalInspections > 0
      ? Math.round((this.defectCount / this.totalInspections) * 100) : 0;
  }

  private handleAlert(alert: any) {
    const alertEntry = {
      type: alert.type || 'warning',
      message: alert.message || 'Alert received',
      time: new Date().toLocaleTimeString('en-GB', { hour12: false })
    };
    this.alerts.unshift(alertEntry);
    if (this.alerts.length > 10) this.alerts.pop();
    this.hasUnreadAlert = true;

    this.snackBar.open(alert.message, 'OK', {
      duration: 5000,
      panelClass: ['alert-snackbar-defect']
    });
  }

  dismissAlerts() {
    this.hasUnreadAlert = false;
  }

  getDefectRateColor(): string {
    if (this.defectRate <= 5) return '#10b981';
    if (this.defectRate <= 15) return '#f59e0b';
    return '#ef4444';
  }

  getConfidenceColor(): string {
    if (this.confidenceScore >= 80) return '#10b981';
    if (this.confidenceScore >= 50) return '#f59e0b';
    return '#ef4444';
  }

  trackById(index: number, item: Inspection): string {
    return item.id;
  }

  ngOnDestroy() {
    this.subscriptions.unsubscribe();
  }

  logout() {
    this.authService.logout();
  }
}
