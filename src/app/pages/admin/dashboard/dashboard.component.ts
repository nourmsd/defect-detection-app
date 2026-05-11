import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { AuthService } from '../../../services/auth.service';
import { SocketService } from '../../../services/socket.service';
import { ThemeService } from '../../../services/theme.service';
import { ApiService, formatInspectionId } from '../../../services/api.service';
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
  selectedHour: number | null = null;

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
          const p = payload as any;
          this.lastInspection = {
            id: p.id,
            label: p.label === 'defective' ? 'defective' : 'ok',
            defect_type: p.defect_type ?? null,
            flavor: p.flavor || 'missing',
            expiry_date: p.expiry_date || p.detected_date || 'missing',
            confidence: p.confidence,
            timestamp: p.timestamp,
            processing_time: p.processing_time
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

  selectHour(h: number) {
    this.selectedHour = (this.selectedHour === h) ? null : h;
  }

  clearSelectedHour() {
    this.selectedHour = null;
  }

  eventsInHour(h: number): any[] {
    return this.timelineEvents.filter(ev => new Date(ev.timestamp).getHours() === h);
  }

  hourEventLeft(event: any): string {
    const ts = new Date(event.timestamp);
    const min = ts.getMinutes() + ts.getSeconds() / 60;
    const pct = (min / 60) * 100;
    return `${pct.toFixed(2)}%`;
  }

  hourMinuteTicks(): number[] {
    return [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60];
  }

  /* Compute colored segments between consecutive events.
     - rangeStart/End : visual scale (denominator for %)
     - dataEnd        : where to stop the trailing segment (e.g. "now" on today) */
  private buildSegments(rangeStartMin: number, rangeEndMin: number, dataEndMin: number, events: any[]): any[] {
    const totalMin = rangeEndMin - rangeStartMin;
    if (totalMin <= 0) return [];

    const clampedEnd = Math.min(rangeEndMin, dataEndMin);

    const sorted = [...events].sort((a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    const toMin = (ev: any): number => {
      const ts = new Date(ev.timestamp);
      return ts.getHours() * 60 + ts.getMinutes() + ts.getSeconds() / 60;
    };

    const segments: any[] = [];
    let cursor = rangeStartMin;
    let currentColor: string | null = null;
    let currentLabel = '';

    if (sorted.length === 0) return [];

    for (let i = 0; i < sorted.length; i++) {
      const ev = sorted[i];
      const evMin = Math.max(rangeStartMin, Math.min(clampedEnd, toMin(ev)));

      if (currentColor !== null && evMin > cursor) {
        const leftPct = ((cursor - rangeStartMin) / totalMin) * 100;
        const widthPct = ((evMin - cursor) / totalMin) * 100;
        segments.push({
          color: currentColor,
          leftPct, widthPct,
          fromLabel: this.minToHHMM(cursor),
          toLabel: this.minToHHMM(evMin),
          label: currentLabel
        });
      }

      cursor = evMin;
      currentColor = ev.color || 'yellow';
      currentLabel = ev.label || '';
    }

    // Trailing segment up to dataEnd (capped at "now" for today)
    if (currentColor !== null && cursor < clampedEnd) {
      const leftPct = ((cursor - rangeStartMin) / totalMin) * 100;
      const widthPct = ((clampedEnd - cursor) / totalMin) * 100;
      segments.push({
        color: currentColor,
        leftPct, widthPct,
        fromLabel: this.minToHHMM(cursor),
        toLabel: this.minToHHMM(clampedEnd),
        label: currentLabel
      });
    }

    return segments;
  }

  private minToHHMM(min: number): string {
    const h = Math.floor(min / 60);
    const m = Math.floor(min % 60);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
  }

  private isTimelineDateToday(): boolean {
    return this.timelineDate === new Date().toISOString().slice(0, 10);
  }

  private nowMinutesOfDay(): number {
    const n = new Date();
    return n.getHours() * 60 + n.getMinutes() + n.getSeconds() / 60;
  }

  /* Cap the visible range at "now" when looking at today, so future hours
     don't get filled in by the last event's color. */
  private cappedEnd(endMin: number): number {
    if (!this.isTimelineDateToday()) return endMin;
    return Math.min(endMin, this.nowMinutesOfDay());
  }

  timelineSegments(): any[] {
    const startMin = this.TIMELINE_START_H * 60;
    const endMin = this.TIMELINE_END_H * 60;
    const dataEnd = this.cappedEnd(endMin);
    return this.buildSegments(startMin, endMin, dataEnd, this.timelineEvents);
  }

  hourSegments(): any[] {
    if (this.selectedHour === null) return [];
    const startMin = this.selectedHour * 60;
    const endMin = (this.selectedHour + 1) * 60;
    const dataEnd = this.cappedEnd(endMin);
    return this.buildSegments(startMin, endMin, dataEnd, this.eventsInHour(this.selectedHour));
  }

  /* Only show labels for ticks whose state-color differs from the previous one,
     to keep the band readable when many micro-events fire in the same second. */
  visibleTicks(): any[] {
    const sorted = [...this.timelineEvents].sort((a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    const out: any[] = [];
    let lastColor: string | null = null;
    for (const ev of sorted) {
      if (ev.color !== lastColor) { out.push(ev); lastColor = ev.color; }
    }
    return out;
  }

  visibleTicksHour(): any[] {
    if (this.selectedHour === null) return [];
    const sorted = this.eventsInHour(this.selectedHour).sort((a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    const out: any[] = [];
    let lastColor: string | null = null;
    for (const ev of sorted) {
      if (ev.color !== lastColor) { out.push(ev); lastColor = ev.color; }
    }
    return out;
  }

  /* % position of "now" inside the full-day timeline (for the live cursor). */
  nowPositionDay(): number | null {
    if (!this.isTimelineDateToday()) return null;
    const total = (this.TIMELINE_END_H - this.TIMELINE_START_H) * 60;
    const m = this.nowMinutesOfDay() - this.TIMELINE_START_H * 60;
    if (m < 0 || m > total) return null;
    return (m / total) * 100;
  }

  /* % position of "now" inside the selected hour zoom view. */
  nowPositionHour(): number | null {
    if (this.selectedHour === null || !this.isTimelineDateToday()) return null;
    const now = this.nowMinutesOfDay();
    const startMin = this.selectedHour * 60;
    const endMin = (this.selectedHour + 1) * 60;
    if (now < startMin || now > endMin) return null;
    return ((now - startMin) / 60) * 100;
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

  /** Composite `barcode-expiry_date` id, falling back to short Mongo _id. */
  displayInspectionId(item: any): string {
    return formatInspectionId(item);
  }
}
