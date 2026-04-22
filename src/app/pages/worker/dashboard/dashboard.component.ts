import { Component, OnInit, OnDestroy, NgZone } from '@angular/core';
import { SocketService } from '../../../services/socket.service';
import { AuthService } from '../../../services/auth.service';
import { ThemeService } from '../../../services/theme.service';
import { ApiService, Inspection, RobotHealth, RobotAlert } from '../../../services/api.service';
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

  // ── Dismissible robot alert banners ────────────────────────────
  dismissedAlertIds = new Set<string>();

  // ── Live telemetry ─────────────────────────────────────────────
  currentTime = '';
  fps = 0;
  lastProcessingTime = 0;
  confidenceScore = 0;   // comes from AI model via backend
  detectionStatus: 'WAITING' | 'NORMAL' | 'DEFECTIVE' = 'WAITING';
  rejectionRate = 0;
  lastDetectionTime = '--:--:--';

  // ── Camera stream ──────────────────────────────────────────────
  cameraStreamUrl = '';                  // NOT readonly — must be mutable
  streamActive = false;
  private streamHost = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
  private streamRetryTimer: any = null;
  private readonly STREAM_BASE_PORT = 5001;
  private readonly STREAM_RETRY_MS = 4000

  // ── Robot health ────────────────────────────────────────────────
  robotHealth: RobotHealth | null = null;
  activeAlerts: RobotAlert[] = [];

  // ── System link states (updated from real robot health data) ──
  systemLinks = {
    plc: false,
    mqtt: false,
    aiModel: false,
    camera: false,
    mongodb: false
  };

  // ── Robot action state ──────────────────────────────────────────
  actionLoading = false;
  actionMessage = '';
  actionSuccess = true;

  /** True if the robot is connected — driven by health data from Python backend */
  get isRobotConnected(): boolean {
    return !!this.robotHealth?.robot_connected;
  }

  // ── Private ────────────────────────────────────────────────────
  private clockTimer: any;
  private subscriptions = new Subscription();

  constructor(
    private socketService: SocketService,
    private authService: AuthService,
    private apiService: ApiService,
    public themeService: ThemeService,
    private snackBar: MatSnackBar,
    private ngZone: NgZone
  ) {

    this.refreshStreamUrl();
  }

  // ── Computed: visible (non-dismissed) alert banners ────────────
  get visibleBannerAlerts(): { id: string; icon: string; label: string; severity: string }[] {
    const banners: { id: string; icon: string; label: string; severity: string }[] = [];

    if (this.robotHealth) {
      // Calibration needed
      if (this.robotHealth.hardware_status?.calibration_needed) {
        banners.push({ id: 'calibration_needed', icon: '🔴', label: 'Calibration Needed — Robot requires recalibration before resuming operations', severity: 'critical' });
      }

      // Emergency stop (robot status indicates stopped)
      const status = this.robotHealth.robot_status?.robot_status_str?.toLowerCase() || '';
      if (status.includes('stop') || status.includes('emergency')) {
        banners.push({ id: 'emergency_stop', icon: '🔴', label: 'Emergency Stop Triggered — Robot has been halted. Manual reset required', severity: 'critical' });
      }

      // Motor errors requiring reboot
      const hwErrors = this.robotHealth.hardware_status?.hardware_errors_message || [];
      if (hwErrors.length > 0 && hwErrors.some((e: string) => e && e.length > 0)) {
        banners.push({ id: 'reboot_motors', icon: '🔴', label: 'Reboot Motors Required — Motor hardware error detected: ' + hwErrors.filter((e: string) => e && e.length > 0).join(', '), severity: 'critical' });
      }
    }

    // Also include real-time alerts from the robot that are critical/warning
    for (const alert of this.activeAlerts) {
      const msg = alert.message?.toLowerCase() || '';
      if (msg.includes('calibrat')) {
        banners.push({ id: 'rt_calib_' + alert.id, icon: '🔴', label: 'Calibration Needed — ' + alert.message, severity: 'critical' });
      } else if (msg.includes('emergency') || msg.includes('stop')) {
        banners.push({ id: 'rt_estop_' + alert.id, icon: '🔴', label: 'Emergency Stop Triggered — ' + alert.message, severity: 'critical' });
      } else if (msg.includes('motor') || msg.includes('reboot')) {
        banners.push({ id: 'rt_motor_' + alert.id, icon: '🔴', label: 'Reboot Motors Required — ' + alert.message, severity: 'critical' });
      }
    }

    // Deduplicate by id and filter out dismissed
    const seen = new Set<string>();
    return banners.filter(b => {
      if (seen.has(b.id) || this.dismissedAlertIds.has(b.id)) return false;
      seen.add(b.id);
      return true;
    });
  }

  dismissBannerAlert(id: string) {
    this.dismissedAlertIds.add(id);
  }

  ngOnInit() {
    this.startClock();
    this.fetchInspections();

    const socketSub = this.socketService.alerts$.subscribe(alert => {
      this.handleNewAlert(alert);
    });
    this.subscriptions.add(socketSub);

    // ── Robot health: real-time updates from Socket.IO ────────
    const healthSub = this.socketService.robotHealth$.subscribe(health => {
      this.ngZone.run(() => {
        this.robotHealth = health;
        this.activeAlerts = health.alerts || [];
        this.systemLinks.camera = this.streamActive;
        // Update FPS from robot health if available
        if (health.camera_fps !== undefined && health.camera_fps !== null) {
          this.fps = health.camera_fps;
        }
      });
    });
    this.subscriptions.add(healthSub);

    // ── Robot alerts: show snackbar for new critical/warning alerts ──
    const robotAlertSub = this.socketService.robotAlert$.subscribe(alert => {
      this.ngZone.run(() => {
        const panelClass = alert.severity === 'critical'
          ? ['alert-snackbar', 'alert-defective']
          : ['alert-snackbar', 'alert-warning'];
        this.snackBar.open(alert.message, 'Dismiss', {
          duration: alert.severity === 'critical' ? 10000 : 5000,
          panelClass
        });
      });
    });
    this.subscriptions.add(robotAlertSub);

    // Fetch initial health snapshot
    this.apiService.getRobotHealth().subscribe({
      next: (health) => {
        this.robotHealth = health;
        this.activeAlerts = health.alerts || [];
        this.systemLinks.camera = this.streamActive;
      },
      error: () => {} // niryo_stream not ready yet
    });
  }

  // ── Clock — updates every second ──────────────────────────────
  private startClock() {
    this.currentTime = new Date().toLocaleTimeString('en-GB', { hour12: false });

    this.clockTimer = setInterval(() => {
      this.ngZone.run(() => {
        this.currentTime = new Date().toLocaleTimeString('en-GB', { hour12: false });
      });
    }, 1000);
  }


  // ── Fetch existing inspections from backend ────────────────────
  fetchInspections() {
    this.apiService.getInspections().subscribe({
      next: (res) => {
        const history = res.history || [];
        this.inspections = history.slice(0, 20);

        // Use server-side gauge totals (all-time counts, not just recent 50)
        if (res.gauges) {
          this.totalInspections = res.gauges.totalInspected;
          this.defectCount = res.gauges.defective;
          this.normalCount = res.gauges.conforming;
          this.rejectionRate = this.totalInspections > 0
            ? Math.round((this.defectCount / this.totalInspections) * 100)
            : 0;
        } else {
          this.calculateMetrics(history);
        }

        if (history.length > 0) this.updateLatestDetection(history[0]);
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
    this.systemLinks.camera = true;
    if (this.streamRetryTimer) {
      clearTimeout(this.streamRetryTimer);
      this.streamRetryTimer = null;
    }
  }

  onStreamError(): void {
    this.streamActive = false;
    this.systemLinks.camera = false;
    clearTimeout(this.streamRetryTimer);
    this.streamRetryTimer = setTimeout(() => {
      this.ngZone.run(() => {
        this.refreshStreamUrl();
      });
    }, this.STREAM_RETRY_MS);
  }

  // ── Robot actions ───────────────────────────────────────────────
  triggerRobotAction(action: string) {
    this.actionLoading = true;
    this.actionSuccess = true;
    this.actionMessage = `Executing ${action.replace(/_/g, ' ')}...`;
    this.apiService.triggerRobotAction(action).subscribe({
      next: (res) => {
        this.actionSuccess = res.success;
        this.actionMessage = res.message;
        this.actionLoading = false;
        setTimeout(() => this.actionMessage = '', 8000);
      },
      error: (err) => {
        this.actionSuccess = false;
        this.actionMessage = err.error?.message || 'Robot not reachable';
        this.actionLoading = false;
        setTimeout(() => this.actionMessage = '', 8000);
      }
    });
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
    if (this.streamRetryTimer) clearTimeout(this.streamRetryTimer);
    this.subscriptions.unsubscribe();
  }

  logout() {
    this.authService.logout();
  }
}
