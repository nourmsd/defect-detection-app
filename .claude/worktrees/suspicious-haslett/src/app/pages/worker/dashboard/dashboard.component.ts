import { Component, OnInit, OnDestroy } from '@angular/core';
import { SocketService } from '../../../services/socket.service';
import { AuthService } from '../../../services/auth.service';
import { ThemeService } from '../../../services/theme.service';
import { ApiService, Inspection } from '../../../services/api.service';
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
  // --- Existing Logic Variables ---
  alerts: any[] = [];
  inspections: Inspection[] = [];
  normalCount: number = 0;
  defectCount: number = 0;
  totalInspections: number = 0;
  
  // --- New UI Telemetry & State ---
  currentTime: string = '';
  fps: number = 30.0;
  lastProcessingTime: number = 0.45;
  confidenceScore: number = 88;
  detectionStatus: 'WAITING' | 'NORMAL' | 'DEFECTIVE' = 'WAITING';
  rejectionRate: number = 0;
  lastDetectionTime: string = '--:--:--';
  
  systemLinks = {
    plc: false,
    mqtt: true,
    aiModel: true,
    camera: true,
    mongodb: true
  };

  private subscriptions: Subscription = new Subscription();

  constructor(
    private socketService: SocketService,
    private authService: AuthService,
    private apiService: ApiService,
    public themeService: ThemeService,
    private snackBar: MatSnackBar
  ) { }

  ngOnInit() {
    this.startClock();
    this.startSimulation();
    this.fetchInspections();

    // Listen for new inspections/alerts via socket
    const socketSub = this.socketService.alerts$.subscribe(alert => {
      this.handleNewAlert(alert);
    });
    this.subscriptions.add(socketSub);
  }

  private startClock() {
    const clockSub = interval(1000).pipe(
      map(() => new Date().toLocaleTimeString('en-GB', { hour12: false }))
    ).subscribe(time => this.currentTime = time);
    this.subscriptions.add(clockSub);
  }

  private startSimulation() {
    // Subtle fluctuations for FPS and Processing Time to make it feel alive
    const simSub = interval(3000).subscribe(() => {
      this.fps = parseFloat((29.5 + Math.random()).toFixed(1));
      if (this.detectionStatus === 'WAITING') {
        this.lastProcessingTime = parseFloat((0.4 + Math.random() * 0.2).toFixed(2));
      }
    });
    this.subscriptions.add(simSub);
  }

  fetchInspections() {
    this.apiService.getInspections().subscribe({
      next: (data) => {
        this.inspections = data.slice(0, 10); // Keep last 10 for history list
        this.calculateMetrics(data);
        if (data.length > 0) {
          const latest = data[0];
          this.updateLatestDetection(latest);
        }
      },
      error: (err) => console.error('Failed to fetch inspections', err)
    });
  }

  private handleNewAlert(alert: any) {
    this.alerts.unshift(alert);
    this.snackBar.open(alert.message, 'Close', {
      duration: 5000,
      panelClass: ['alert-snackbar', `alert-${alert.type}`]
    });
    if (this.alerts.length > 5) this.alerts.pop();

    // On new alert, trigger detection UI update
    this.detectionStatus = alert.type === 'defective' ? 'DEFECTIVE' : 'NORMAL';
    this.confidenceScore = Math.floor(85 + Math.random() * 14);
    this.lastDetectionTime = new Date().toLocaleTimeString();
    
    this.fetchInspections();
  }

  private updateLatestDetection(inspection: Inspection) {
    this.lastDetectionTime = new Date(inspection.timestamp).toLocaleTimeString();
    this.detectionStatus = inspection.label === 'OK' ? 'NORMAL' : 'DEFECTIVE';
  }

  private calculateMetrics(data: Inspection[]) {
    if (data.length === 0) {
      this.rejectionRate = 0;
      return;
    }
    this.normalCount = data.filter(i => i.label === 'OK').length;
    this.defectCount = data.filter(i => i.label !== 'OK').length;
    this.totalInspections = data.length;
    this.rejectionRate = Math.round((this.defectCount / this.totalInspections) * 100);
  }

  resetCounters() {
    this.normalCount = 0;
    this.defectCount = 0;
    this.totalInspections = 0;
    this.rejectionRate = 0;
    this.inspections = [];
    this.detectionStatus = 'WAITING';
    this.lastDetectionTime = '--:--:--';
  }

  ngOnDestroy() {
    this.subscriptions.unsubscribe();
  }

  logout() {
    this.authService.logout();
  }
}
