import { ChangeDetectorRef, Component, NgZone, OnDestroy, OnInit } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { interval, Subscription } from 'rxjs';
import { AuthService } from '../../../services/auth.service';
import { ToastService } from '../../../shared/toast/toast.service';
import { AlertsHistoryDialogComponent } from '../../../shared/alerts-history/alerts-history-dialog.component';
import { ApiService, Inspection, StreamHealth } from '../../../services/api.service';
import {
  InferenceStatusSocketPayload,
  InspectionSocketPayload,
  SocketEventEnvelope,
  SocketService,
  SystemHealthSocketPayload,
  ErrorLogPayload,
  DangerAlertPayload,
  PendingBarcodePayload,
  PendingBarcodeClearedPayload
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
  sidebarCollapsed = false;
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
  currentTime = '';
  fps = 0;
  lastProcessingTime = 0;
  confidenceScore = 0;
  detectionStatus: 'WAITING' | 'NORMAL' | 'DEFECTIVE' = 'WAITING';
  lastDetectionTime = '--:--:--';
  lastDetectedDate = 'missing';
  lastDefectType: string | null = null;
  lastBarcode: string | null = null;
  pendingBarcode: string | null = null;
  pendingBarcodeType: string | null = null;
  pendingBarcodeAt: string | null = null;
  inferenceStatus = 'IDLE';
  liveDate = '—';
  liveConf = 0;
  liveYoloCount = 0;
  inferenceFps = 0;
  inferenceMs = 0;
  cameraStreamUrl = '';
  streamActive = false;
  barcodeStreamUrl = '';
  barcodeStreamActive = false;
  streamHealth: StreamHealth = this.defaultStreamHealth();
  systemLinks = { aiModel: false, camera: false };
  isRobotConnected = false;
  plcConnected = false;
  jointPositions: number[] = [];
  freemotionActive = false;
  robotLastAction = '—';
  robotQueueSize = 0;
  jointMoving: boolean[] = [false, false, false, false, false, false];
  private prevJointPositions: number[] = [];
  private jMovingTimers: (ReturnType<typeof setTimeout> | null)[] = Array(6).fill(null);
  alarms: RobotAlarm[] = [];
  errorLogs: ErrorLog[] = [];
  errorLogsLoading = false;
  showResolvedLogs = false;
  errorLogsExpanded = true;
  readonly ERR_VISIBLE_LIMIT = 5;

  get visibleErrorLogs(): ErrorLog[] {
    return this.errorLogs.slice(0, this.ERR_VISIBLE_LIMIT);
  }
  dangerAlertActive = false;
  dangerAlertMessage = '';
  dangerAlertType: 'urgent' | 'info' = 'info';
  cmdLoading: Record<string, boolean> = {};
  actionLoading = false;
  actionMessage = '';
  actionSuccess = true;
  private readonly STREAM_BASE_PORT = 5003;
  private readonly BARCODE_STREAM_PORT = 5003;
  private barcodeRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly STREAM_RETRY_MS = 4000;
  private readonly POLL_MS = 3000;
  private readonly ROBOT_OFFLINE_FAILURE_THRESHOLD = 2;
  private readonly ROBOT_DISCONNECT_GRACE_MS = 10000;
  private streamHost = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
  private streamRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionStartIso = new Date().toISOString();
  private seenInspectionIds = new Set<string>();
  private seenRobotAlertKeys = new Set<string>();
  private robotStatusFailureCount = 0;
  private lastRobotSeenConnectedAt = 0;
  private subscriptions = new Subscription();
  private clockTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private socketService: SocketService,
    private authService: AuthService,
    private apiService: ApiService,
    public themeService: ThemeService,
    private toast: ToastService,
    private dialog: MatDialog,
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
    this.loadErrorLogs();
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
                this.toast.error(alarm.message);
              } else if (alarm.level === 'warning') {
                this.toast.warning(alarm.message);
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
              this.dangerAlertMessage = dp.message || '';
              this.dangerAlertType = dp.alert_type === 'urgent' ? 'urgent' : 'info';
              if (this.dangerAlertType === 'urgent') {
                this.toast.error(` ${dp.message}`, 12000);
              } else {
                this.toast.info(` ${dp.message}`, 8000);
              }
              this.cdr.detectChanges();
            });
          }

          if (type === 'pending_barcode') {
            this.ngZone.run(() => {
              const pb = payload as PendingBarcodePayload;
              this.pendingBarcode = pb.barcode || null;
              this.pendingBarcodeType = pb.barcode_type || null;
              this.pendingBarcodeAt = pb.timestamp || new Date().toISOString();
              if (this.pendingBarcode) {
                this.toast.info(`Barcode #${this.pendingBarcode} detected — waiting for AI inspection`, 4000);
              }
              this.cdr.detectChanges();
            });
          }

          if (type === 'pending_barcode_cleared') {
            this.ngZone.run(() => {
              const pl = payload as PendingBarcodeClearedPayload;
              const had = this.pendingBarcode;
              this.pendingBarcode = null;
              this.pendingBarcodeType = null;
              this.pendingBarcodeAt = null;
              if (had && pl.reason === 'absent') {
                this.toast.warning(`Pre-scan slot cleared — product left phone view`, 3000);
              }
              this.cdr.detectChanges();
            });
          }

          if (type === 'daily_reset') {
            this.ngZone.run(() => {
              this.inspections = [];
              this.totalInspections = 0;
              this.normalCount = 0;
              this.defectCount = 0;
              this.rejectionRate = 0;
              this.seenInspectionIds.clear();
              this.sessionStartIso = new Date().toISOString();
              this.toast.info('Daily counters reset at 19:00 — starting fresh', 5000);
              this.cdr.detectChanges();
            });
          }
        }
      })
    );
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

  private pollRobotStatus(): void {
    this.apiService.getRobotStatus().subscribe({
      next: (status) => {
        this.robotStatusFailureCount = 0;
        const robotConnected = Boolean(status.robot_connected);
        this.applyRobotConnectivity(robotConnected);
        this.freemotionActive = status.freemotion_active ?? false;
        this.robotLastAction = status.last_action ?? '—';
        this.robotQueueSize = status.queue_size ?? 0;

        const newJoints: number[] = status.joints || [];
        this.updateJointMovement(newJoints);
        this.jointPositions = newJoints;
        this.ingestRobotStatusAlerts(status.alerts);
      },
      error: () => {
        this.robotStatusFailureCount += 1;
        if (this.robotStatusFailureCount >= this.ROBOT_OFFLINE_FAILURE_THRESHOLD) {
          this.applyRobotConnectivity(false);
          if (!this.isRobotConnected) {
            this.jointPositions = [];
            this.robotQueueSize = 0;
          }
        }
      }
    });
  }
  private readonly suppressedAlertCodes = new Set<string>(['robot_not_ready']);

  private ingestRobotStatusAlerts(alerts?: Array<{ level?: string; code?: string; message?: string }>): void {
    if (!Array.isArray(alerts) || alerts.length === 0) return;
    const nowIso = new Date().toISOString();
    for (const a of alerts) {
      const code = String(a?.code || 'robot_status');
      if (this.suppressedAlertCodes.has(code)) continue;
      const level = ((a?.level || 'warning') as string).toLowerCase();
      const message = String(a?.message || 'Robot diagnostic alert');
      const key = `${code}:${message}`;
      if (this.seenRobotAlertKeys.has(key)) continue;
      this.seenRobotAlertKeys.add(key);
      const alarm: RobotAlarm = { level, message, timestamp: nowIso };
      this.alarms = [alarm, ...this.alarms].slice(0, 30);
      if (level === 'critical' || level === 'error') {
        this.toast.error(`ROBOT: ${message}`);
      } else if (level === 'warning') {
        this.toast.warning(`ROBOT: ${message}`);
      }
    }
    this.cdr.markForCheck();
  }

  private applyRobotConnectivity(robotConnectedNow: boolean): void {
    const now = Date.now();
    if (robotConnectedNow) {
      this.lastRobotSeenConnectedAt = now;
      this.isRobotConnected = true;
      return;
    }

    const recentlyConnected = (now - this.lastRobotSeenConnectedAt) < this.ROBOT_DISCONNECT_GRACE_MS;
    if (!recentlyConnected) {
      this.isRobotConnected = false;
    }
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
          this.toast.error(res.message);
        } else if (res.message) {
          this.toast.success(res.message);
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
          this.toast.success('Free motion enabled', 2500);
        }
        this.cdr.detectChanges();
      },
      error: () => this.toast.error('Failed to enable free motion')
    });
  }

  disableFreemotion(): void {
    if (!this.isRobotConnected) return;
    this.apiService.disableFreemotion().subscribe({
      next: (res) => {
        if (res.success) {
          this.freemotionActive = false;
          this.toast.success('Free motion disabled', 2500);
        }
        this.cdr.detectChanges();
      },
      error: () => this.toast.error('Failed to disable free motion')
    });
  }

  clearAlarms(): void {
    this.alarms = [];
  }

  radToDeg(rad: number): string {
    return ((rad || 0) * 180 / Math.PI).toFixed(1);
  }

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

  private handleNewInspection(alert: InspectionSocketPayload): void {
    if (!alert) return;
    const inspection = this.normalizeAlert(alert);
    if (inspection) this.appendInspection(inspection);
    this.pendingBarcode = null;
    this.pendingBarcodeType = null;
    this.pendingBarcodeAt = null;
    this.pollStreamHealth();
  }

  private appendInspection(inspection: Inspection): void {
    if (this.seenInspectionIds.has(inspection.id)) return;
    this.seenInspectionIds.add(inspection.id);

    this.inspections = [inspection, ...this.inspections.filter(i => i.id !== inspection.id)];
    this.histPage = 1;

    if (inspection.label === 'ok') {
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
      defect_type: (alert as any)?.defect_type ?? null,
      flavor: (alert as any)?.flavor || 'missing',
      timestamp: alert?.timestamp || new Date().toISOString(),
      confidence: alert?.confidence,
      processing_time: alert?.processing_time,
      expiry_date: (alert as any)?.expiry_date || (alert as any)?.detected_date || 'missing'
    };
  }

  private normalizeLabel(raw: any): 'ok' | 'defective' | null {
    const label = String(raw || '').toLowerCase();
    if (['ok', 'normal', 'pass', 'conforming'].includes(label)) return 'ok';
    if (['defective', 'fail', 'nok', 'defect'].includes(label)) return 'defective';
    return null;
  }

  private updateLatestDetection(inspection: Inspection): void {
    this.lastDetectionTime = new Date(inspection.timestamp).toLocaleTimeString('en-GB', { hour12: false });
    this.detectionStatus = inspection.label === 'ok' ? 'NORMAL' : 'DEFECTIVE';
    if (inspection.confidence != null) {
      this.confidenceScore = inspection.confidence <= 1
        ? Math.round(inspection.confidence * 100) : Math.round(inspection.confidence);
    }
    if (inspection.processing_time != null) this.lastProcessingTime = inspection.processing_time;
    if (inspection.expiry_date != null) this.lastDetectedDate = inspection.expiry_date;
    this.lastDefectType = (inspection as any).defect_type || null;
    this.lastBarcode = (inspection as any).barcode || null;
  }

  defectTypeLabel(): string {
    if (!this.lastDefectType) return '';
    const map: Record<string, string> = {
      absent: 'Absent / no date',
      blurry: 'Blurry / unreadable',
      expired: 'Expired',
    };
    return map[this.lastDefectType] || this.lastDefectType;
  }

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
    this.systemLinks.camera = health?.stream !== 'offline';
    this.plcConnected = health?.plc_status === 'online';
    this.streamHealth = {
      ...this.streamHealth,
      status: health?.stream || 'offline',
      robot_connected: this.isRobotConnected,
      avg_fps: Number(health?.fps) || 0,
      camera_status: health?.camera || 'Stream offline'
    };
  }

  private pollStreamHealth(): void {
    this.apiService.getStreamHealth().subscribe({
      next: (health) => {
        this.streamHealth = health;
        this.systemLinks.camera = health.status !== 'offline' && !health.stream_stale;
        this.applyRobotConnectivity(Boolean(health.robot_connected));
        this.plcConnected = Boolean(health.plc_connected);
      },
      error: () => {
        this.systemLinks.camera = false;
        this.applyRobotConnectivity(false);
      }
    });
  }

  private refreshStreamUrl(): void {
    this.cameraStreamUrl = `http://${this.streamHost}:${this.STREAM_BASE_PORT}/ai_stream?t=${Date.now()}`;
    this.refreshBarcodeStreamUrl();
  }

  private refreshBarcodeStreamUrl(): void {
    this.barcodeStreamUrl = `http://${this.streamHost}:${this.BARCODE_STREAM_PORT}/barcode_stream?t=${Date.now()}`;
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

  onBarcodeStreamLoad(): void {
    this.barcodeStreamActive = true;
  }

  onBarcodeStreamError(): void {
    this.barcodeStreamActive = false;
    if (this.barcodeRetryTimer) clearTimeout(this.barcodeRetryTimer);
    this.barcodeRetryTimer = setTimeout(() => {
      this.ngZone.run(() => this.refreshBarcodeStreamUrl());
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

  loadErrorLogs(): void {
    this.errorLogsLoading = true;
    this.apiService.getErrorLogs({ resolved: this.showResolvedLogs ? undefined : false }).subscribe({
      next: (res) => {
        this.ngZone.run(() => {
          this.errorLogs = (res.logs || []).map((l: any) => ({ ...l, id: l._id || l.id }));
          this.errorLogsLoading = false;
          this.cdr.detectChanges();
        });
      },
      error: () => {
        this.ngZone.run(() => {
          this.errorLogsLoading = false;
          this.cdr.detectChanges();
        });
      }
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
        this.toast.success('Alert acknowledged', 2000);
        this.cdr.markForCheck();
      },
      error: () => {
        log.acknowledging = false;
        this.toast.error('Failed to acknowledge', 2500);
        this.cdr.markForCheck();
      }
    });
  }

  toggleShowResolved(): void {
    this.showResolvedLogs = !this.showResolvedLogs;
    this.loadErrorLogs();
  }

  openAlertsHistory(): void {
    this.dialog.open(AlertsHistoryDialogComponent, {
      data: { logs: this.errorLogs },
      panelClass: 'alerts-history-dialog',
      autoFocus: false,
      maxWidth: '95vw'
    });
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
    if (this.barcodeRetryTimer) clearTimeout(this.barcodeRetryTimer);
    if (this.clockTimer) clearInterval(this.clockTimer);
    this.jMovingTimers.forEach(t => { if (t) clearTimeout(t); });
    this.subscriptions.unsubscribe();
  }
}
