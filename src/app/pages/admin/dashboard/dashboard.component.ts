import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { AuthService } from '../../../services/auth.service';
import { SocketService } from '../../../services/socket.service';
import { ThemeService } from '../../../services/theme.service';
import { ApiService } from '../../../services/api.service';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../../environments/environment';
import { Subscription, interval } from 'rxjs';
import { MatSnackBar } from '@angular/material/snack-bar';
import { SocketEventEnvelope } from '../../../services/socket.service';

@Component({
  selector: 'app-admin-dashboard',
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.css'],
  standalone: false
})
export class AdminDashboardComponent implements OnInit, OnDestroy {

  activeTab: 'overview' | 'requests' | 'defective' | 'workers' | 'attendance' | 'timeline' | 'settings' = 'overview';
  sidebarCollapsed = false;
  currentTime = new Date();

  stats: any = { totalInspected: null, defective: null, efficiency: null, dailyTarget: 450 };
  pendingWorkers: any[] = [];
  defectiveItems: any[] = [];
  defectiveLoading = false;
  validationLoading = false;
  allUsers: any[] = [];
  allUsersLoading = false;
  allUsersError: string | null = null;
  statsError: string | null = null;

  lastInspection: any = null;

  /* ── Live System Health ───────────────────── */
  systemHealth = {
    robot:    'offline' as 'online' | 'offline',
    ai:       'offline' as 'online' | 'offline',
    plc:      'offline' as 'online' | 'offline',
    database: 'online'  as 'online' | 'offline',   // assumed online if stats load
  };

  /* ── Attendance ───────────────────────────── */
  connectedWorkers: any[] = [];
  connectedCount = 0;
  attendanceLogs: any[] = [];
  attendanceSummary: any[] = [];
  attendanceLoading = false;
  attendanceRange: 'day' | 'week' | 'month' = 'day';
  // Use LOCAL calendar date (toISOString() is UTC and rolls back at midnight UTC+1).
  attendanceDate = AdminDashboardComponent.todayLocalStr();

  /* ── Timeline ────────────────────────────── */
  timelineEvents: any[] = [];
  timelineDate = new Date().toISOString().slice(0, 10);
  timelineLoading = false;
  readonly TIMELINE_START_H = 7;
  readonly TIMELINE_END_H   = 19;

  /* ── Settings ────────────────────────────── */
  settings: { daily_target: number; expiry_threshold: string | null } = { daily_target: 450, expiry_threshold: null };
  settingsSaving = false;
  settingsSuccess = false;

  /* ── Danger alert ────────────────────────── */
  dangerAlertActive = false;
  dangerAlertMessage = '';
  sendingDangerAlert = false;
  manualDangerMessage = '';

  private subscriptions = new Subscription();
  private clockSubscription?: Subscription;

  constructor(
    private authService: AuthService,
    private http: HttpClient,
    private socketService: SocketService,
    private apiService: ApiService,
    public themeService: ThemeService,
    private snackBar: MatSnackBar,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit() {
    this.fetchPendingWorkers();
    this.fetchStats();
    this.fetchAllUsers();
    this.fetchDefectiveItems();
    this.fetchConnectedWorkers();
    this.loadSystemSettings();

    this.clockSubscription = interval(1000).subscribe(() => {
      this.currentTime = new Date();
      this.cdr.markForCheck();
    });

    // Refresh connected workers every 30s
    this.subscriptions.add(
      interval(30000).subscribe(() => this.fetchConnectedWorkers())
    );

    const socketSub = this.socketService.onEvent().subscribe({
      next: (event: SocketEventEnvelope) => {
        if (!event) return;
        const { type, payload } = event;

        if (type === 'inspection') {
          this.lastInspection = {
            label: (payload as any).label === 'defective' ? 'defective' : 'OK',
            confidence: (payload as any).confidence,
            timestamp: (payload as any).timestamp,
            processing_time: (payload as any).processing_time
          };
          this.fetchStats();
          this.systemHealth.ai = 'online';
        }

        if (type === 'system_health') {
          const hp = payload as any;
          this.systemHealth.robot    = hp.robot_connected || hp.robot_status === 'online' ? 'online' : 'offline';
          this.systemHealth.ai       = hp.ai_status === 'online' || hp.stream === 'online'  ? 'online' : 'offline';
          this.systemHealth.plc      = hp.plc_status === 'online' ? 'online' : 'offline';
          this.systemHealth.database = hp.db_status === 'online'  ? 'online' : 'offline';
        }

        if (type === 'robot_alert') {
          const level = (payload as any).level?.toUpperCase() || 'INFO';
          const msg = (payload as any).message;
          this.snackBar.open(`${level}: ${msg}`, 'Close', { duration: 5000 });
        }

        if (type === 'attendance_update') {
          this.fetchConnectedWorkers();
          if (this.activeTab === 'attendance') this.fetchAttendanceHistory();
        }

        if (type === 'system_timeline') {
          const tlPayload = payload as any;
          if (tlPayload.date === this.timelineDate) {
            this.timelineEvents = [...this.timelineEvents, tlPayload.event];
          }
        }

        if (type === 'danger_alert') {
          const dp = payload as any;
          this.dangerAlertActive = true;
          this.dangerAlertMessage = dp.message || 'System in danger!';
          this.snackBar.open(`DANGER: ${dp.message}`, 'Dismiss', { duration: 10000, panelClass: ['snack-danger'] });
        }

        this.cdr.markForCheck();
      }
    });

    this.subscriptions.add(socketSub);

    // Prime system health from stats (DB is online if stats load)
    this.apiService.getInspectionHistory({ page: 1, limit: 1 }).subscribe({
      next: (res: any) => {
        this.systemHealth.database = 'online';
        if (res.data?.length) {
          this.lastInspection = res.data[0];
          this.cdr.markForCheck();
        }
      },
      error: () => {
        this.systemHealth.database = 'offline';
        this.cdr.markForCheck();
      }
    });
  }

  ngOnDestroy() {
    this.subscriptions.unsubscribe();
    this.clockSubscription?.unsubscribe();
  }

  /** Returns today as YYYY-MM-DD in the LOCAL timezone (not UTC). */
  static todayLocalStr(): string {
    const d = new Date();
    const y  = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const dy = String(d.getDate()).padStart(2, '0');
    return `${y}-${mo}-${dy}`;
  }

  get aiPipelineStatus(): string {
    return this.lastInspection ? 'ACTIVE' : 'WAITING';
  }

  /* Helper: display name from user object (fullName preferred over username) */
  displayName(user: any): string {
    return user?.fullName || user?.username || user?.email || '?';
  }

  /* Avatar initials from full name */
  avatarInitials(user: any): string {
    const name = this.displayName(user);
    const parts = name.trim().split(' ');
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  }

  normaliseConfidence(raw: number | undefined): number {
    if (raw == null) return 0;
    return raw <= 1 ? Math.round(raw * 100) : Math.round(raw);
  }

  /* ═══════════════ WORKERS ═══════════════ */

  fetchPendingWorkers() {
    const token = this.authService.getToken();
    if (!token) return;
    this.http.get<any[]>(`${environment.apiUrl}/pending-workers`, {
      headers: { Authorization: `Bearer ${token}` }
    }).subscribe({
      next: (data) => { this.pendingWorkers = data; this.cdr.markForCheck(); },
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
    this.http.post(`${environment.apiUrl}/validate-worker`,
      { userId, status },
      { headers: { Authorization: `Bearer ${token}` } }
    ).subscribe({
      next: () => {
        this.pendingWorkers = this.pendingWorkers.filter(w => w._id !== userId);
        this.validationLoading = false;
        this.snackBar.open(`Worker ${status === 'approved' ? 'approved' : 'rejected'} successfully`, 'Close', { duration: 4000 });
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.validationLoading = false;
        this.snackBar.open('Action failed: ' + (err.error?.message || 'Unknown error'), 'Close', { duration: 5000 });
        this.cdr.markForCheck();
      }
    });
  }

  /* ═══════════════ STATS ═══════════════ */

  fetchStats() {
    const token = this.authService.getToken();
    this.statsError = null;
    this.http.get<any>(`${environment.apiUrl}/admin/stats`, {
      headers: { Authorization: `Bearer ${token}` }
    }).subscribe({
      next: (data) => {
        this.stats = data;
        this.statsError = null;
        this.systemHealth.database = 'online';
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.statsError = err?.name === 'TimeoutError' ? 'Server timeout' : 'Unable to load stats';
        this.systemHealth.database = 'offline';
        this.cdr.markForCheck();
      }
    });
  }

  /* ═══════════════ DEFECTIVE ═══════════════ */

  fetchDefectiveItems() {
    this.defectiveLoading = true;
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    this.apiService.getInspectionHistory({
      page: 1, limit: 50, result: 'fail', dateFrom: startOfDay.toISOString()
    }).subscribe({
      next: (res: any) => {
        this.defectiveItems = res.data || [];
        this.defectiveLoading = false;
        this.cdr.markForCheck();
      },
      error: () => { this.defectiveLoading = false; this.cdr.markForCheck(); }
    });
  }

  /* ═══════════════ USERS ═══════════════ */

  fetchAllUsers() {
    this.allUsersLoading = true;
    this.allUsersError = null;
    const token = this.authService.getToken();
    this.http.get<any[]>(`${environment.apiUrl}/admin/all-users`, {
      headers: { Authorization: `Bearer ${token}` }
    }).subscribe({
      next: (data) => {
        this.allUsers = data;
        this.allUsersLoading = false;
        this.allUsersError = null;
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.allUsersLoading = false;
        if (err?.name === 'TimeoutError') this.allUsersError = 'Server timeout — retry';
        else if (err?.status === 0) this.allUsersError = 'Unable to load data — backend unreachable';
        else if (err?.status === 403) this.allUsersError = 'Access denied';
        else this.allUsersError = 'Unable to load users';
        this.cdr.markForCheck();
      }
    });
  }

  deleteUser(userId: string, email: string) {
    if (!confirm(`Delete "${email}"? This frees the email for re-registration.`)) return;
    const token = this.authService.getToken();
    this.allUsers = this.allUsers.filter(u => u._id !== userId);
    this.cdr.markForCheck();
    this.http.delete(`${environment.apiUrl}/admin/delete-user/${userId}`, {
      headers: { Authorization: `Bearer ${token}` }
    }).subscribe({
      next: () => this.snackBar.open(`"${email}" deleted.`, 'Close', { duration: 5000 }),
      error: () => { this.fetchAllUsers(); this.snackBar.open('Delete failed.', 'Close', { duration: 5000 }); }
    });
  }

  /* ═══════════════ ATTENDANCE ═══════════════ */

  fetchConnectedWorkers() {
    this.apiService.getConnectedWorkers().subscribe({
      next: (res) => {
        this.connectedWorkers = res.connected || [];
        this.connectedCount = res.count || 0;
        this.cdr.markForCheck();
      },
      error: () => {}
    });
  }

  fetchAttendanceHistory() {
    this.attendanceLoading = true;
    const params: any = {};

    if (this.attendanceRange === 'day') {
      // Single-day exact match — backend queries the local `date` field
      params.date = this.attendanceDate;
    } else {
      // Week / month — backend uses loginTime range
      params.range = this.attendanceRange;
    }

    this.apiService.getAttendanceHistory(params).subscribe({
      next: (res: any) => {
        this.attendanceLogs    = res.logs    || [];
        this.attendanceSummary = res.summary || [];
        this.attendanceLoading = false;
        this.cdr.markForCheck();
      },
      error: () => {
        this.attendanceLogs    = [];
        this.attendanceSummary = [];
        this.attendanceLoading = false;
        this.cdr.markForCheck();
      }
    });
  }

  formatDuration(minutes: number): string {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  /* ═══════════════ TIMELINE ═══════════════ */

  fetchTimeline() {
    this.timelineLoading = true;
    this.apiService.getTimeline(this.timelineDate).subscribe({
      next: (res) => {
        this.timelineEvents = res.events || [];
        this.timelineLoading = false;
        this.cdr.markForCheck();
      },
      error: () => { this.timelineLoading = false; this.cdr.markForCheck(); }
    });
  }

  timelineEventLeft(event: any): string {
    const ts = new Date(event.timestamp);
    const totalMin = (this.TIMELINE_END_H - this.TIMELINE_START_H) * 60;
    const eventMin = (ts.getHours() - this.TIMELINE_START_H) * 60 + ts.getMinutes();
    const pct = Math.max(0, Math.min(100, (eventMin / totalMin) * 100));
    return `${pct.toFixed(2)}%`;
  }

  timelineHours(): number[] {
    const arr = [];
    for (let h = this.TIMELINE_START_H; h <= this.TIMELINE_END_H; h++) arr.push(h);
    return arr;
  }

  timelineColorClass(event: any): string {
    const c = event?.color;
    if (c === 'green')  return 'tl-ev-green';
    if (c === 'red')    return 'tl-ev-red';
    return 'tl-ev-yellow';
  }

  /* ═══════════════ SETTINGS ═══════════════ */

  loadSystemSettings() {
    this.apiService.getSystemSettings().subscribe({
      next: (s) => {
        this.settings = { daily_target: s.daily_target || 450, expiry_threshold: s.expiry_threshold || null };
        this.stats.dailyTarget = this.settings.daily_target;
        this.cdr.markForCheck();
      },
      error: () => {}
    });
  }

  saveSettings() {
    this.settingsSaving = true;
    this.apiService.updateSystemSettings(this.settings).subscribe({
      next: () => {
        this.settingsSaving = false;
        this.settingsSuccess = true;
        this.fetchStats();
        this.snackBar.open('Settings saved successfully', 'OK', { duration: 3000 });
        setTimeout(() => { this.settingsSuccess = false; this.cdr.markForCheck(); }, 3000);
        this.cdr.markForCheck();
      },
      error: () => {
        this.settingsSaving = false;
        this.snackBar.open('Failed to save settings', 'OK', { duration: 3000 });
        this.cdr.markForCheck();
      }
    });
  }

  /* ═══════════════ DANGER ALERT ═══════════════ */

  triggerManualDangerAlert() {
    if (!this.manualDangerMessage.trim()) return;
    this.sendingDangerAlert = true;
    this.apiService.triggerDangerAlert(this.manualDangerMessage).subscribe({
      next: () => {
        this.sendingDangerAlert = false;
        this.manualDangerMessage = '';
        this.snackBar.open('Emergency broadcast sent to all users!', 'OK', { duration: 4000 });
        this.cdr.markForCheck();
      },
      error: () => {
        this.sendingDangerAlert = false;
        this.snackBar.open('Failed to send alert', 'OK', { duration: 3000 });
        this.cdr.markForCheck();
      }
    });
  }

  dismissDangerBanner() {
    this.dangerAlertActive = false;
    this.cdr.markForCheck();
  }

  logout() {
    this.authService.logout();
  }
}
