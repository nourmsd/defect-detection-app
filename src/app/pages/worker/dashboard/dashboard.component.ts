import { Component, OnInit, OnDestroy, NgZone, ChangeDetectorRef } from '@angular/core';
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

  // ── Inspection data ────────────────────────────────────────────
  alerts: any[] = [];
  inspections: Inspection[] = [];
  normalCount = 0;
  defectCount = 0;
  totalInspections = 0;

  // ── Live telemetry ─────────────────────────────────────────────
  currentTime = '';
  fps = 30.0;
  lastProcessingTime = 0.45;
  confidenceScore = 0;   // comes from AI model via backend
  detectionStatus: 'WAITING' | 'NORMAL' | 'DEFECTIVE' = 'WAITING';
  rejectionRate = 0;
  lastDetectionTime = '--:--:--';

  // ── Camera stream ──────────────────────────────────────────────
  cameraStreamUrl = '';                  // NOT readonly — must be mutable
  streamActive = false;
  private streamHost = '10.10.10.10';
  private streamRetryTimer: any = null;
  private readonly STREAM_BASE_PORT = 5001;
  private readonly STREAM_RETRY_MS = 4000

  // ── System link states ─────────────────────────────────────────
  systemLinks = {
    plc: false,
    mqtt: true,
    aiModel: true,
    camera: true,
    mongodb: true
  };

  // ── Private ────────────────────────────────────────────────────
  private clockTimer: any;
  private simTimer: any;
  private subscriptions = new Subscription();

  constructor(
    private socketService: SocketService,
    private authService: AuthService,
    private apiService: ApiService,
    public themeService: ThemeService,
    private snackBar: MatSnackBar,
    private ngZone: NgZone,
    private cdr: ChangeDetectorRef

  ) {

    this.refreshStreamUrl();
  }

  ngOnInit() {
    this.startClock();
    this.startSimulation();
    this.fetchInspections();

    const socketSub = this.socketService.alerts$.subscribe(alert => {
      this.handleNewAlert(alert);
    });
    this.subscriptions.add(socketSub);
  }

  // ── Clock — updates every second ──────────────────────────────
  private startClock() {
    this.currentTime = new Date().toLocaleTimeString('en-GB', { hour12: false });

    this.clockTimer = setInterval(() => {
      this.ngZone.run(() => {
        this.currentTime = new Date().toLocaleTimeString('en-GB', { hour12: false });
        this.cdr.detectChanges();
      });
    }, 1000);
  }

  // ── Simulation — subtle live feel (FPS / proc time fluctuations) ──
  private startSimulation() {
    this.simTimer = setInterval(() => {
      this.ngZone.run(() => {
        this.fps = parseFloat((29.5 + Math.random()).toFixed(1));
        if (this.detectionStatus === 'WAITING') {
          this.lastProcessingTime = parseFloat((0.4 + Math.random() * 0.2).toFixed(3));
        }
      });
    }, 3000);
  }

  // ── Fetch existing inspections from backend ────────────────────
  fetchInspections() {
    this.apiService.getInspections().subscribe({
      next: (data) => {
        this.inspections = data.slice(0, 20);
        this.calculateMetrics(data);
        if (data.length > 0) this.updateLatestDetection(data[0]);
      },
      error: (err) => console.error('Failed to fetch inspections', err)
    });
  }

  // ── Handle real-time alert from socket ─────────────────────────
  private handleNewAlert(alert: any) {
    this.alerts.unshift(alert);
    this.snackBar.open(alert.message, 'Close', {
      duration: 5000,
      panelClass: ['alert-snackbar', `alert-${alert.type}`]
    });
    if (this.alerts.length > 5) this.alerts.pop();

    this.detectionStatus = alert.type === 'defective' ? 'DEFECTIVE' : 'NORMAL';
    this.lastDetectionTime = new Date().toLocaleTimeString();

    // Use confidence from alert payload if the robot provides it
    if (alert.confidence != null) {
      this.confidenceScore = this.normaliseConfidence(alert.confidence);
    }
    if (alert.processing_time != null) {
      this.lastProcessingTime = alert.processing_time;
    }

    this.fetchInspections();
  }

  private updateLatestDetection(inspection: Inspection) {
    this.lastDetectionTime = new Date(inspection.timestamp).toLocaleTimeString();
    this.detectionStatus = inspection.label === 'OK' ? 'NORMAL' : 'DEFECTIVE';

    if (inspection.confidence != null) {
      this.confidenceScore = this.normaliseConfidence(inspection.confidence);
    }
    if (inspection.processing_time != null) {
      this.lastProcessingTime = inspection.processing_time;
    }
  }

  // ── Normalise confidence to 0-100 (robot may send 0-1 or 0-100) ──
  private normaliseConfidence(raw: number): number {
    return raw <= 1 ? Math.round(raw * 100) : Math.round(raw);
  }

  private calculateMetrics(data: Inspection[]) {
    this.normalCount = data.filter(i => i.label === 'OK').length;
    this.defectCount = data.filter(i => i.label !== 'OK').length;
    this.totalInspections = data.length;
    this.rejectionRate = data.length
      ? Math.round((this.defectCount / data.length) * 100)
      : 0;
  }



  // ── Stream URL ─────────────────────────────────────────────────
  private refreshStreamUrl(): void {
    this.cameraStreamUrl =
      `http://${this.streamHost}:${this.STREAM_BASE_PORT}/stream?t=${Date.now()}`;
  }

  // ── Stream event handlers ──────────────────────────────────────
  onStreamLoad(): void {
    this.streamActive = true;
    if (this.streamRetryTimer) {
      clearTimeout(this.streamRetryTimer);
      this.streamRetryTimer = null;
    }
  }

  onStreamError(): void {
    this.streamActive = false;
    this.streamRetryTimer = setTimeout(() => {
      this.ngZone.run(() => {
        this.refreshStreamUrl();
        this.cdr.detectChanges();
      });
    }, this.STREAM_RETRY_MS);
  }

  // ── Reset all counters ─────────────────────────────────────────
  resetCounters() {
    this.normalCount = 0;
    this.defectCount = 0;
    this.totalInspections = 0;
    this.rejectionRate = 0;
    this.inspections = [];
    this.detectionStatus = 'WAITING';
    this.lastDetectionTime = '--:--:--';
    this.confidenceScore = 0;
  }

  ngOnDestroy() {
    clearInterval(this.clockTimer);
    clearInterval(this.simTimer);
    if (this.streamRetryTimer) clearTimeout(this.streamRetryTimer);  // ← add
    this.subscriptions.unsubscribe();
  }

  logout() {
    this.authService.logout();
  }
}
