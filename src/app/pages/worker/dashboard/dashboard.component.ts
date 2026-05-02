import { ChangeDetectorRef, Component, NgZone, OnDestroy, OnInit } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { interval, Subscription } from 'rxjs';
import { AuthService } from '../../../services/auth.service';
import { ApiService, Inspection, SavedJointPosition, StreamHealth } from '../../../services/api.service';
import {
  InferenceStatusSocketPayload,
  InspectionSocketPayload,
  SocketEventEnvelope,
  SocketService,
  SystemHealthSocketPayload,
  ErrorLogPayload,
  DangerAlertPayload
} from '../../../services/socket.service';
import { ThemeService } from '../../../services/theme.service';

export interface RobotAlarm {
  level: string;
  message: string;
  timestamp: string;
}

export interface ErrorLog {
  id?: string;
  _id?: string;
  errorType: string;
  severity: 'critical' | 'error' | 'warning';
  message: string;
  suggestedAction: string;
  timestamp: string;
  resolved: boolean;
  acknowledging?: boolean;
}

@Component({
  selector: 'app-worker-dashboard',
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.css'],
  standalone: false
})
export class WorkerDashboardComponent implements OnInit, OnDestroy {

  /* ── Production counters ───────────────────────────────── */
  inspections: Inspection[] = [];
  normalCount = 0;
  defectCount = 0;
  totalInspections = 0;
  rejectionRate = 0;

  readonly HIST_PAGE_SIZE = 40;
  histPage = 1;

  get histTotalPages(): number {
    return Math.max(1, Math.ceil(this.inspections.length / this.HIST_PAGE_SIZE));
  }
  get visibleInspections(): Inspection[] {
    const start = (this.histPage - 1) * this.HIST_PAGE_SIZE;
    return this.inspections.slice(start, start + this.HIST_PAGE_SIZE);
  }
  get histPageEnd(): number {
    return Math.min(this.histPage * this.HIST_PAGE_SIZE, this.inspections.length);
  }

  /* ── Detection state ───────────────────────────────────── */
  currentTime = '';
  fps = 0;
  lastProcessingTime = 0;
  confidenceScore = 0;
  detectionStatus: 'WAITING' | 'NORMAL' | 'DEFECTIVE' = 'WAITING';
  lastDetectionTime = '--:--:--';
  lastDetectedDate = 'missing';

  /* ── Live inference (per-cycle AI state) ───────────────── */
  inferenceStatus = 'IDLE';
  liveDate = '—';
  liveConf = 0;
  liveYoloCount = 0;
  inferenceFps = 0;
  inferenceMs = 0;

  /* ── Camera / stream ───────────────────────────────────── */
  cameraStreamUrl = '';
  streamActive = false;
  streamHealth: StreamHealth = this.defaultStreamHealth();

  /* ── System status ─────────────────────────────────────── */
  systemLinks = { aiModel: false, camera: false };

  /* ── Robot status (basic) ──────────────────────────────── */
  isRobotConnected = false;
  jointPositions: number[] = [];

  /* ── Robot status (extended) ───────────────────────────── */
  robotBusy = false;
  freemotionActive = false;
  robotLastAction = '—';
  robotQueueSize = 0;

  /* ── Joint animation ───────────────────────────────────── */
  jointMoving: boolean[] = [false, false, false, false, false, false];
  private prevJointPositions: number[] = [];
  private jMovingTimers: (ReturnType<typeof setTimeout> | null)[] = Array(6).fill(null);

  /* ── Alarms log ─────────────────────────────────────────── */
  alarms: RobotAlarm[] = [];

  /* ── Error logs / alerts section ──────────────────────────── */
  errorLogs: ErrorLog[] = [];
  errorLogsLoading = false;
  showResolvedLogs = false;
  errorLogsExpanded = true;

  /* ── Danger alert banner ───────────────────────────────────── */
  dangerAlertActive = false;
  dangerAlertMessage = '';

  /* ── Command loading states ─────────────────────────────── */
  cmdLoading: Record<string, boolean> = {};

  /* ── Freemotion / save position ─────────────────────────── */
  actionLoading = false;
  actionMessage = '';
  actionSuccess = true;
  savePosName = '';
  savingPosition = false;
  savedPositions: SavedJointPosition[] = [];
  positionsLoading = false;
  expandedPositionId: string | null = null;

  /* ── Internal ───────────────────────────────────────────── */
  private readonly STREAM_BASE_PORT = 5001;
  private readonly STREAM_RETRY_MS = 4000;
  private readonly POLL_MS = 3000;
  private streamHost = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
  private streamRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionStartIso = new Date().toISOString();
  private seenInspectionIds = new Set<string>();
  private subscriptions = new Subscription();
  private clockTimer: ReturnType<typeof setInterval> | null = null;

  /* ── Arc gauge constant (π × 34 ≈ 106.8) ───────────────── */
  readonly JOINT_ARC_TOTAL = 106.8;

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

  ngOnInit(): void {
    this.startClock();
    this.syncLiveSnapshot();
    this.pollRobotStatus();
    this.pollStreamHealth();
    this.loadSavedPositions();
    this.loadErrorLogs();

    /* Real-time socket events */
    this.subscriptions.add(
      this.socketService.onEvent().subscribe({
        next: (event: SocketEventEnvelope) => {
          if (!event) return;
          const { type, payload } = event;

          if (type === 'inspection') {
            this.handleNewInspection(payload);
          }

          if (type === 'robot_alert') {
            this.ngZone.run(() => {
              const alarm: RobotAlarm = {
                level: (payload as any).level || 'info',
                message: (payload as any).message || 'Robot event',
                timestamp: (payload as any).timestamp || new Date().toISOString()
              };
              this.alarms = [alarm, ...this.alarms].slice(0, 30);
              if (alarm.level === 'critical' || alarm.level === 'error') {
                this.snackBar.open(`⚠ ${alarm.message}`, 'Close', { duration: 6000 });
              }
              this.cdr.detectChanges();
            });
          }

          if (type === 'system_health') {
            this.applySystemHealth(payload as SystemHealthSocketPayload);
          }

          if (type === 'error_log') {
            this.ngZone.run(() => {
              const el = payload as ErrorLogPayload;
              const log: ErrorLog = {
                id: el.id,
                errorType: el.errorType,
                severity: el.severity,
                message: el.message,
                suggestedAction: el.suggestedAction,
                timestamp: el.timestamp,
                resolved: el.resolved
              };
              this.errorLogs = [log, ...this.errorLogs].slice(0, 100);
              this.cdr.detectChanges();
            });
          }

          if (type === 'danger_alert') {
            this.ngZone.run(() => {
              const dp = payload as DangerAlertPayload;
              this.dangerAlertActive = true;
              this.dangerAlertMessage = dp.message || 'System in danger!';
              this.snackBar.open(`DANGER: ${dp.message}`, 'Dismiss', { duration: 12000 });
              this.cdr.detectChanges();
            });
          }

          if (type === 'daily_reset') {
            this.ngZone.run(() => {
              // 7PM daily reset — clear inspection counters and restart from fresh
              this.inspections = [];
              this.totalInspections = 0;
              this.normalCount = 0;
              this.defectCount = 0;
              this.rejectionRate = 0;
              this.seenInspectionIds.clear();
              this.sessionStartIso = new Date().toISOString();
              this.snackBar.open('Daily counters reset at 19:00 — starting fresh', 'OK', { duration: 5000 });
              this.cdr.detectChanges();
            });
          }
        }
      })
    );

    /* Per-cycle inference status */
    this.subscriptions.add(
      this.socketService.onInferenceStatus().subscribe({
        next: (s: InferenceStatusSocketPayload) => {
          this.ngZone.run(() => {
            this.inferenceStatus = s.status;
            this.liveConf = s.confidence != null ? Math.round(s.confidence * 100) : 0;
            this.liveYoloCount = s.yolo_detections ?? 0;
            this.inferenceFps = s.fps ?? 0;
            this.inferenceMs = s.inference_ms ?? 0;
            this.liveDate = (s.detected_date && s.detected_date !== 'missing') ? s.detected_date : '—';
            this.cdr.detectChanges();
          });
        }
      })
    );

    /* Polling fallback */
    this.subscriptions.add(
      interval(this.POLL_MS).subscribe(() => {
        this.ngZone.run(() => {
          this.syncLiveSnapshot();
          this.pollRobotStatus();
          this.pollStreamHealth();
        });
      })
    );
  }

  /* ════════════════════════════════════════════════════════
     ROBOT STATUS
  ════════════════════════════════════════════════════════ */

  private pollRobotStatus(): void {
    this.apiService.getRobotStatus().subscribe({
      next: (status) => {
        this.isRobotConnected = status.robot_connected;
        this.robotBusy = status.robot_busy ?? false;
        this.freemotionActive = status.freemotion_active ?? false;
        this.robotLastAction = status.last_action ?? '—';
        this.robotQueueSize = status.queue_size ?? 0;

        const newJoints: number[] = status.joints || [];
        this.updateJointMovement(newJoints);
        this.jointPositions = newJoints;
      },
      error: () => {
        this.isRobotConnected = false;
        this.jointPositions = [];
      }
    });
  }

  private updateJointMovement(newJoints: number[]): void {
    const threshold = 0.005;
    for (let i = 0; i < 6; i++) {
      const prev = this.prevJointPositions[i] ?? newJoints[i] ?? 0;
      const curr = newJoints[i] ?? 0;
      if (Math.abs(curr - prev) > threshold) {
        this.jointMoving[i] = true;
        if (this.jMovingTimers[i]) clearTimeout(this.jMovingTimers[i]!);
        this.jMovingTimers[i] = setTimeout(() => {
          this.jointMoving[i] = false;
          this.cdr.detectChanges();
        }, 2000);
      }
    }
    this.prevJointPositions = [...newJoints];
  }

  /* ════════════════════════════════════════════════════════
     ROBOT CONTROL COMMANDS
  ════════════════════════════════════════════════════════ */

  robotCommand(cmd: string, confirmMsg?: string): void {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    if (this.cmdLoading[cmd]) return;

    this.cmdLoading[cmd] = true;
    this.actionMessage = '';

    this.apiService.robotCommand(cmd).subscribe({
      next: (res) => {
        this.actionSuccess = res.success;
        this.actionMessage = res.message;
        this.cmdLoading[cmd] = false;
        if (!res.success) {
          this.snackBar.open(res.message, 'Close', { duration: 4000 });
        }
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.actionSuccess = false;
        this.actionMessage = err?.error?.message || `Command "${cmd}" failed`;
        this.cmdLoading[cmd] = false;
        this.cdr.detectChanges();
      }
    });
  }

  enableFreemotion(): void {
    if (!this.isRobotConnected) return;
    this.apiService.enableFreemotion().subscribe({
      next: (res) => {
        if (res.success) {
          this.freemotionActive = true;
          this.snackBar.open('Free motion enabled', 'OK', { duration: 2500 });
        }
        this.cdr.detectChanges();
      },
      error: () => this.snackBar.open('Failed to enable free motion', 'OK', { duration: 2500 })
    });
  }

  disableFreemotion(): void {
    if (!this.isRobotConnected) return;
    this.apiService.disableFreemotion().subscribe({
      next: (res) => {
        if (res.success) {
          this.freemotionActive = false;
          this.snackBar.open('Free motion disabled', 'OK', { duration: 2500 });
        }
        this.cdr.detectChanges();
      },
      error: () => this.snackBar.open('Failed to disable free motion', 'OK', { duration: 2500 })
    });
  }

  clearAlarms(): void {
    this.alarms = [];
  }

  /* ════════════════════════════════════════════════════════
     JOINT GAUGE HELPER
  ════════════════════════════════════════════════════════ */

  getJointFill(rad: number): string {
    const normalized = Math.max(0, Math.min(1, ((rad || 0) + Math.PI) / (2 * Math.PI)));
    return `${(normalized * this.JOINT_ARC_TOTAL).toFixed(1)} ${this.JOINT_ARC_TOTAL}`;
  }

  /* ════════════════════════════════════════════════════════
     SAVE POSITION & SAVED POSITIONS
  ════════════════════════════════════════════════════════ */

  saveCurrentPosition(): void {
    const name = (this.savePosName || '').trim();
    if (!name || this.savingPosition) return;

    this.savingPosition = true;
    this.apiService.saveJointPosition(name).subscribe({
      next: (res) => {
        if (res.success && res.position) {
          this.savedPositions = [res.position, ...this.savedPositions];
          this.savePosName = '';
          this.snackBar.open(`Position "${res.position.name}" saved`, 'OK', { duration: 2500 });
        }
        this.savingPosition = false;
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.savingPosition = false;
        this.snackBar.open(err?.error?.message || 'Failed to save position', 'OK', { duration: 3000 });
        this.cdr.markForCheck();
      }
    });
  }

  loadSavedPositions(): void {
    this.positionsLoading = true;
    this.apiService.getSavedPositions().subscribe({
      next: (res) => {
        this.savedPositions = res.positions || [];
        this.positionsLoading = false;
        this.cdr.markForCheck();
      },
      error: () => { this.positionsLoading = false; }
    });
  }

  deleteSavedPosition(id: string, event: Event): void {
    event.stopPropagation();
    this.apiService.deleteJointPosition(id).subscribe({
      next: () => {
        this.savedPositions = this.savedPositions.filter(p => p._id !== id);
        if (this.expandedPositionId === id) this.expandedPositionId = null;
        this.cdr.markForCheck();
      },
      error: () => this.snackBar.open('Failed to delete position', 'OK', { duration: 2500 })
    });
  }

  togglePositionExpand(id: string): void {
    this.expandedPositionId = this.expandedPositionId === id ? null : id;
  }

  radToDeg(rad: number): string {
    return ((rad || 0) * 180 / Math.PI).toFixed(1);
  }

  /* ════════════════════════════════════════════════════════
     SESSION RESET
  ════════════════════════════════════════════════════════ */

  resetSession(): void {
    this.inspections = [];
    this.normalCount = 0;
    this.defectCount = 0;
    this.totalInspections = 0;
    this.rejectionRate = 0;
    this.confidenceScore = 0;
    this.lastProcessingTime = 0;
    this.detectionStatus = 'WAITING';
    this.lastDetectionTime = '--:--:--';
    this.lastDetectedDate = 'missing';
    this.actionMessage = '';
    this.seenInspectionIds.clear();
    this.sessionStartIso = new Date().toISOString();
    this.histPage = 1;
  }

  /* ════════════════════════════════════════════════════════
     INSPECTION SOCKET HANDLER
  ════════════════════════════════════════════════════════ */

  private handleNewInspection(alert: InspectionSocketPayload): void {
    if (!alert) return;
    const inspection = this.normalizeAlert(alert);
    if (inspection) this.appendInspection(inspection);
    this.pollStreamHealth();
  }

  private appendInspection(inspection: Inspection): void {
    if (this.seenInspectionIds.has(inspection.id)) return;
    this.seenInspectionIds.add(inspection.id);

    this.inspections = [inspection, ...this.inspections.filter(i => i.id !== inspection.id)];
    this.histPage = 1;

    if (inspection.label === 'OK') {
      this.normalCount += 1;
    } else {
      this.defectCount += 1;
    }
    this.totalInspections = this.normalCount + this.defectCount;
    this.rejectionRate = this.totalInspections > 0
      ? Math.round((this.defectCount / this.totalInspections) * 100) : 0;

    this.systemLinks.aiModel = true;
    this.updateLatestDetection(inspection);
  }

  private normalizeAlert(alert: InspectionSocketPayload): Inspection | null {
    const id = String(alert?.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const label = this.normalizeLabel(alert?.label);
    if (!label) return null;
    return {
      id,
      label,
      timestamp: alert?.timestamp || new Date().toISOString(),
      confidence: alert?.confidence,
      processing_time: alert?.processing_time,
      detected_date: alert?.detected_date || 'missing'
    };
  }

  private normalizeLabel(raw: any): 'OK' | 'defective' | null {
    const label = String(raw || '').toLowerCase();
    if (['ok', 'normal', 'pass', 'conforming'].includes(label)) return 'OK';
    if (['defective', 'fail', 'nok', 'defect'].includes(label)) return 'defective';
    return null;
  }

  private updateLatestDetection(inspection: Inspection): void {
    this.lastDetectionTime = new Date(inspection.timestamp).toLocaleTimeString('en-GB', { hour12: false });
    this.detectionStatus = inspection.label === 'OK' ? 'NORMAL' : 'DEFECTIVE';
    if (inspection.confidence != null) {
      this.confidenceScore = inspection.confidence <= 1
        ? Math.round(inspection.confidence * 100) : Math.round(inspection.confidence);
    }
    if (inspection.processing_time != null) this.lastProcessingTime = inspection.processing_time;
    if (inspection.detected_date != null) this.lastDetectedDate = inspection.detected_date;
  }

  /* ════════════════════════════════════════════════════════
     STREAM & HEALTH
  ════════════════════════════════════════════════════════ */

  private syncLiveSnapshot(): void {
    this.apiService.getInspections().subscribe({
      next: (res) => {
        const history: Inspection[] = res.history || [];
        let newAdded = false;
        for (const item of history) {
          const id = String((item as any)._id || item.id || item.timestamp);
          if (!this.seenInspectionIds.has(id)) {
            this.seenInspectionIds.add(id);
            this.inspections.push({ ...item, id });
            newAdded = true;
          }
        }
        if (newAdded) {
          this.inspections.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        }
        if (res.gauges) {
          this.totalInspections = res.gauges.totalInspected;
          this.defectCount = res.gauges.defective;
          this.normalCount = res.gauges.conforming;
          this.rejectionRate = this.totalInspections > 0
            ? Math.round((this.defectCount / this.totalInspections) * 100) : 0;
        }
        this.systemLinks.aiModel = true;
      },
      error: () => { this.systemLinks.aiModel = false; }
    });
  }

  private applySystemHealth(health: SystemHealthSocketPayload): void {
    this.fps = Number(health?.fps) || 0;
    this.isRobotConnected = Boolean(health?.robot_connected);
    this.systemLinks.camera = health?.stream !== 'offline';
    this.streamHealth = {
      ...this.streamHealth,
      status: health?.stream || 'offline',
      robot_connected: Boolean(health?.robot_connected),
      avg_fps: Number(health?.fps) || 0,
      camera_status: health?.camera || 'Stream offline'
    };
  }

  private pollStreamHealth(): void {
    this.apiService.getStreamHealth().subscribe({
      next: (health) => {
        this.streamHealth = health;
        this.systemLinks.camera = health.status !== 'offline' && !health.stream_stale;
      },
      error: () => { this.systemLinks.camera = false; }
    });
  }

  private refreshStreamUrl(): void {
    this.cameraStreamUrl = `http://${this.streamHost}:${this.STREAM_BASE_PORT}/stream?t=${Date.now()}`;
  }

  onStreamLoad(): void {
    this.streamActive = true;
    this.systemLinks.camera = true;
  }

  onStreamError(): void {
    this.streamActive = false;
    this.systemLinks.camera = false;
    if (this.streamRetryTimer) clearTimeout(this.streamRetryTimer);
    this.streamRetryTimer = setTimeout(() => {
      this.ngZone.run(() => this.refreshStreamUrl());
    }, this.STREAM_RETRY_MS);
  }

  private startClock(): void {
    const tick = () => {
      this.currentTime = new Date().toLocaleTimeString('en-GB', { hour12: false });
      this.cdr.detectChanges();
    };
    tick();
    this.clockTimer = setInterval(tick, 1000);
  }

  private defaultStreamHealth(): StreamHealth {
    return {
      status: 'offline', robot_connected: false, pyniryo_available: false,
      robot_ip: '10.10.10.10', uptime_sec: 0, frames_captured: 0,
      avg_fps: 0, stream_stale: true, last_frame_age_sec: 0, camera_status: 'Stream offline'
    };
  }

  /* ════════════════════════════════════════════════════════
     ERROR LOGS
  ════════════════════════════════════════════════════════ */

  loadErrorLogs(): void {
    this.errorLogsLoading = true;
    this.apiService.getErrorLogs({ resolved: this.showResolvedLogs ? undefined : false }).subscribe({
      next: (res) => {
        this.errorLogs = (res.logs || []).map((l: any) => ({ ...l, id: l._id || l.id }));
        this.errorLogsLoading = false;
        this.cdr.markForCheck();
      },
      error: () => { this.errorLogsLoading = false; }
    });
  }

  acknowledgeLog(log: ErrorLog): void {
    const id = log._id || log.id;
    if (!id || log.acknowledging) return;
    log.acknowledging = true;
    this.apiService.acknowledgeErrorLog(id).subscribe({
      next: () => {
        log.resolved = true;
        log.acknowledging = false;
        if (!this.showResolvedLogs) {
          this.errorLogs = this.errorLogs.filter(l => !(l._id === id || l.id === id));
        }
        this.snackBar.open('Alert acknowledged', 'OK', { duration: 2000 });
        this.cdr.markForCheck();
      },
      error: () => {
        log.acknowledging = false;
        this.snackBar.open('Failed to acknowledge', 'OK', { duration: 2000 });
        this.cdr.markForCheck();
      }
    });
  }

  toggleShowResolved(): void {
    this.showResolvedLogs = !this.showResolvedLogs;
    this.loadErrorLogs();
  }

  dismissDangerBanner(): void {
    this.dangerAlertActive = false;
    this.cdr.markForCheck();
  }

  severityColor(sev: string): string {
    return sev === 'critical' ? 'err-critical' : sev === 'error' ? 'err-error' : 'err-warning';
  }

  logout(): void {
    this.authService.logout();
  }

  ngOnDestroy(): void {
    if (this.streamRetryTimer) clearTimeout(this.streamRetryTimer);
    if (this.clockTimer) clearInterval(this.clockTimer);
    this.jMovingTimers.forEach(t => { if (t) clearTimeout(t); });
    this.subscriptions.unsubscribe();
  }
}
