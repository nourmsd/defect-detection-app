import { Component, OnInit, OnDestroy } from '@angular/core';
import { AuthService } from '../../../services/auth.service';
import { SocketService } from '../../../services/socket.service';
import { ThemeService } from '../../../services/theme.service';
import { ApiService, RobotHealth, RobotAlert } from '../../../services/api.service';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../../environments/environment';
import { Subscription, interval } from 'rxjs';
import { MatSnackBar } from '@angular/material/snack-bar';

@Component({
  selector: 'app-admin-dashboard',
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.css'],
  standalone: false
})
export class AdminDashboardComponent implements OnInit, OnDestroy {

  // UI State
  activeTab: 'overview' | 'requests' | 'defective' | 'workers' = 'overview';
  sidebarCollapsed = false;
  searchTerm = '';
  currentTime = new Date();

  // Data
  stats: any = { totalInspected: null, defective: null, efficiency: null };
  pendingWorkers: any[] = [];
  defectiveItems: any[] = [];
  defectiveLoading = false;
  validationLoading = false;
  allUsers: any[] = [];
  allUsersLoading = false;
  deletingUserId: string | null = null;

  // Robot health (real-time from socket)
  robotHealth: RobotHealth | null = null;
  activeAlerts: RobotAlert[] = [];
  robotEventLog: { time: string; message: string; severity: string }[] = [];

  // AI Vision state
  lastInspection: any = null;
  modelLoaded = false;
  aiConfidenceThreshold = 50;

  private subscriptions = new Subscription();
  private clockSubscription?: Subscription;

  constructor(
    private authService: AuthService,
    private http: HttpClient,
    private socketService: SocketService,
    private apiService: ApiService,
    public themeService: ThemeService,
    private snackBar: MatSnackBar
  ) {}

  ngOnInit() {
    this.fetchPendingWorkers();
    this.fetchStats();
    this.fetchAllUsers();
    this.fetchDefectiveItems();

    // Live clock
    this.clockSubscription = interval(1000).subscribe(() => {
      this.currentTime = new Date();
    });

    // Robot health: real-time from Socket.IO
    const healthSub = this.socketService.robotHealth$.subscribe(health => {
      this.robotHealth = health;
      this.activeAlerts = health.alerts || [];
      this.modelLoaded = !!health.robot_connected;
    });
    this.subscriptions.add(healthSub);

    // Robot alerts: log events
    const alertSub = this.socketService.robotAlert$.subscribe(alert => {
      this.robotEventLog.unshift({
        time: new Date().toLocaleTimeString('en-GB', { hour12: false }),
        message: alert.message,
        severity: alert.severity
      });
      if (this.robotEventLog.length > 3) this.robotEventLog.pop();
    });
    this.subscriptions.add(alertSub);

    // Socket alerts for AI detections
    const detectionSub = this.socketService.alerts$.subscribe(alert => {
      if (alert) {
        this.lastInspection = {
          label: alert.type === 'defective' ? 'defective' : 'OK',
          confidence: alert.confidence,
          timestamp: new Date().toISOString(),
          processing_time: alert.processing_time
        };
      }
    });
    this.subscriptions.add(detectionSub);

    // Initial robot health fetch
    this.apiService.getRobotHealth().subscribe({
      next: (health) => {
        this.robotHealth = health;
        this.activeAlerts = health.alerts || [];
        this.modelLoaded = !!health.robot_connected;
      },
      error: () => {}
    });

    // Fetch last inspection
    this.apiService.getInspectionHistory({ page: 1, limit: 1 }).subscribe({
      next: (res: any) => {
        if (res.data && res.data.length > 0) {
          this.lastInspection = res.data[0];
        }
      },
      error: () => {}
    });
  }

  ngOnDestroy() {
    this.subscriptions.unsubscribe();
    this.clockSubscription?.unsubscribe();
  }

  // Robot status helpers
  get robotStatusLabel(): string {
    if (!this.robotHealth) return 'OFFLINE';
    if (!this.robotHealth.robot_connected) return 'OFFLINE';
    const status = this.robotHealth.robot_status?.robot_status_str?.toLowerCase() || '';
    if (status.includes('emergency') || status.includes('stop')) return 'EMERGENCY STOP';
    if (this.robotHealth.hardware_status?.calibration_in_progress) return 'CALIBRATING';
    if (this.robotHealth.hardware_status?.calibration_needed) return 'ERROR';
    const hwErrors = this.robotHealth.hardware_status?.hardware_errors_message || [];
    if (hwErrors.some(e => e && e.length > 0)) return 'ERROR';
    return 'ONLINE';
  }

  get robotStatusColor(): string {
    switch (this.robotStatusLabel) {
      case 'ONLINE': return 'status-green';
      case 'OFFLINE': return 'status-gray';
      case 'CALIBRATING': return 'status-amber';
      case 'ERROR': case 'EMERGENCY STOP': return 'status-red';
      default: return 'status-gray';
    }
  }

  get isRobotError(): boolean {
    return this.robotStatusLabel === 'ERROR' || this.robotStatusLabel === 'EMERGENCY STOP';
  }

  get lastHeartbeat(): string {
    if (!this.robotHealth?.last_updated) return '—';
    return new Date(this.robotHealth.last_updated).toLocaleTimeString('en-GB', { hour12: false });
  }

  get motorStatusSummary(): string {
    if (!this.robotHealth?.hardware_status?.temperatures) return 'No data';
    const temps = this.robotHealth.hardware_status.temperatures;
    const max = Math.max(...temps);
    if (max >= 65) return `Critical (${max}°C)`;
    if (max >= 55) return `Warning (${max}°C)`;
    return `Normal (max ${max}°C)`;
  }

  get operationMode(): string {
    if (!this.robotHealth?.robot_connected) return 'Disconnected';
    return this.robotHealth?.robot_status?.robot_status_str || 'Unknown';
  }

  normaliseConfidence(raw: number | undefined): number {
    if (raw == null) return 0;
    return raw <= 1 ? Math.round(raw * 100) : Math.round(raw);
  }

  // Existing admin methods
  fetchPendingWorkers() {
    const token = this.authService.getToken();
    if (!token) return;
    this.http.get<any[]>(`${environment.apiUrl}/pending-workers`, {
      headers: { Authorization: `Bearer ${token}` }
    }).subscribe({
      next: (data) => { this.pendingWorkers = data; },
      error: (err) => {
        const msg = err.status === 403 ? 'Access denied.' : 'Could not load pending workers.';
        this.snackBar.open(msg, 'Close', { duration: 6000 });
      }
    });
  }

  validateWorker(userId: string, status: 'approved' | 'rejected') {
    if (this.validationLoading) return;
    this.validationLoading = true;
    const token = this.authService.getToken();
    this.http.post(`${environment.apiUrl}/validate-worker`, { userId, status }, {
      headers: { Authorization: `Bearer ${token}` }
    }).subscribe({
      next: () => {
        this.pendingWorkers = this.pendingWorkers.filter(w => w._id !== userId);
        this.validationLoading = false;
        this.snackBar.open(`Worker ${status === 'approved' ? 'approved' : 'rejected'} successfully`, 'Close', { duration: 4000 });
      },
      error: (err) => {
        this.snackBar.open('Action failed: ' + (err.error?.message || 'Unknown error'), 'Close', { duration: 5000 });
        this.validationLoading = false;
      }
    });
  }

  fetchStats() {
    const token = this.authService.getToken();
    this.http.get<any>(`${environment.apiUrl}/admin/stats`, {
      headers: { Authorization: `Bearer ${token}` }
    }).subscribe({
      next: (data) => { this.stats = data; },
      error: () => {}
    });
  }

  fetchDefectiveItems() {
    this.defectiveLoading = true;
    this.apiService.getInspectionHistory({ page: 1, limit: 50, result: 'fail' }).subscribe({
      next: (res: any) => {
        this.defectiveItems = res.data || [];
        this.defectiveLoading = false;
      },
      error: () => {
        this.defectiveLoading = false;
      }
    });
  }

  getShortId(id: any): string {
    if (!id) return 'UNKNOWN';
    const strId = String(id);
    return strId.substring(strId.length - 6).toUpperCase();
  }

  fetchAllUsers() {
    this.allUsersLoading = true;
    const token = this.authService.getToken();
    this.http.get<any[]>(`${environment.apiUrl}/admin/all-users`, {
      headers: { Authorization: `Bearer ${token}` }
    }).subscribe({
      next: (data) => { this.allUsers = data; this.allUsersLoading = false; },
      error: (err) => {
        this.snackBar.open('Could not load users.', 'Close', { duration: 5000 });
        this.allUsersLoading = false;
      }
    });
  }

  deleteUser(userId: string, email: string) {
    if (!confirm(`Delete "${email}"? This frees the email for re-registration.`)) return;
    const token = this.authService.getToken();
    this.allUsers = this.allUsers.filter(u => u._id !== userId);
    this.http.delete(`${environment.apiUrl}/admin/delete-user/${userId}`, {
      headers: { Authorization: `Bearer ${token}` }
    }).subscribe({
      next: () => {
        this.snackBar.open(`"${email}" deleted.`, 'Close', { duration: 5000 });
      },
      error: (err) => {
        this.fetchAllUsers();
        this.snackBar.open('Delete failed.', 'Close', { duration: 5000 });
      }
    });
  }

  logout() {
    this.authService.logout();
  }
}
