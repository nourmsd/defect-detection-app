import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { timeout } from 'rxjs/operators';
import { environment } from '../../environments/environment';

const API_TIMEOUT_MS = 8000;
const ANALYTICS_TIMEOUT_MS = 20000;
const ANALYTICS_ALL_TIMEOUT_MS = 60000; // All-Time scan can be slow on large collections

export interface Inspection {
  id: string;
  label: 'OK' | 'defective';
  timestamp: string;
  confidence?: number;
  processing_time?: number;
  detected_date?: string;
  device?: string;
}

export interface SavedJointPosition {
  _id: string;
  name: string;
  joints: number[];   // 6 values in radians
  createdAt: string;
}

export interface StreamHealth {
  status: string;
  robot_connected: boolean;
  pyniryo_available: boolean;
  robot_ip?: string;
  uptime_sec: number;
  frames_captured: number;
  avg_fps: number;
  stream_stale: boolean;
  last_frame_age_sec: number;
  camera_status: string;
}

@Injectable({
  providedIn: 'root'
})
export class ApiService {
  private baseUrl = environment.apiUrl;

  constructor(private http: HttpClient) {}

  private get authHeaders() {
    return { Authorization: `Bearer ${localStorage.getItem('token')}` };
  }

  getInspections(since?: string): Observable<{ gauges: { totalInspected: number; defective: number; conforming: number }; history: Inspection[] }> {
    const query = since ? `?since=${encodeURIComponent(since)}` : '';
    return this.http.get<{ gauges: { totalInspected: number; defective: number; conforming: number }; history: Inspection[] }>(
      `${this.baseUrl}/worker/dashboard-data${query}`,
      { headers: this.authHeaders }
    ).pipe(timeout(API_TIMEOUT_MS));
  }

  getStreamHealth(): Observable<StreamHealth> {
    return this.http.get<StreamHealth>(`${this.baseUrl}/stream/health`, {
      headers: this.authHeaders
    }).pipe(timeout(API_TIMEOUT_MS));
  }

  cleanTestData(): Observable<any> {
    return this.http.delete(`${this.baseUrl}/admin/clean-test-data`, {
      headers: this.authHeaders
    }).pipe(timeout(API_TIMEOUT_MS));
  }

  getInspectionHistory(params: {
    page?: number;
    limit?: number;
    result?: string;
    minConfidence?: number;
    maxConfidence?: number;
    dateFrom?: string;
    dateTo?: string;
    search?: string;
  } = {}): Observable<any> {
    const query = new URLSearchParams();

    if (params.page) query.set('page', params.page.toString());
    if (params.limit) query.set('limit', params.limit.toString());
    if (params.result) query.set('result', params.result);
    if (params.minConfidence != null) query.set('minConfidence', params.minConfidence.toString());
    if (params.maxConfidence != null) query.set('maxConfidence', params.maxConfidence.toString());
    if (params.dateFrom) query.set('dateFrom', params.dateFrom);
    if (params.dateTo) query.set('dateTo', params.dateTo);
    if (params.search) query.set('search', params.search);

    return this.http.get(`${this.baseUrl}/admin/history?${query.toString()}`, {
      headers: this.authHeaders
    }).pipe(timeout(API_TIMEOUT_MS));
  }

  getAnalytics(range: string = '30d'): Observable<any> {
    const t = range === 'all' ? ANALYTICS_ALL_TIMEOUT_MS : ANALYTICS_TIMEOUT_MS;
    return this.http.get(`${this.baseUrl}/admin/analytics?range=${range}`, {
      headers: this.authHeaders
    }).pipe(timeout(t));
  }

  getRobotStatus(): Observable<{
    robot_connected: boolean;
    robot_busy: boolean;
    freemotion_active: boolean;
    last_action: string;
    queue_size: number;
    joints: number[];
  }> {
    return this.http.get<any>(
      `${this.baseUrl}/robot/status`,
      { headers: this.authHeaders }
    ).pipe(timeout(API_TIMEOUT_MS));
  }

  robotCommand(cmd: string): Observable<{ success: boolean; message: string }> {
    return this.http.post<{ success: boolean; message: string }>(
      `${this.baseUrl}/robot/${cmd}`, {},
      { headers: this.authHeaders }
    ).pipe(timeout(30000));
  }

  triggerRobotAction(action: string): Observable<{ success: boolean; message: string }> {
    return this.http.post<{ success: boolean; message: string }>(
      `${this.baseUrl}/robot/action`,
      { action },
      { headers: this.authHeaders }
    ).pipe(timeout(API_TIMEOUT_MS));
  }

  enableFreemotion(): Observable<{ success: boolean; freemotion: boolean; message?: string }> {
    return this.http.post<{ success: boolean; freemotion: boolean; message?: string }>(
      `${this.baseUrl}/robot/freemotion/enable`, {},
      { headers: this.authHeaders }
    ).pipe(timeout(API_TIMEOUT_MS));
  }

  disableFreemotion(): Observable<{ success: boolean; freemotion: boolean; message?: string }> {
    return this.http.post<{ success: boolean; freemotion: boolean; message?: string }>(
      `${this.baseUrl}/robot/freemotion/disable`, {},
      { headers: this.authHeaders }
    ).pipe(timeout(API_TIMEOUT_MS));
  }

  getCurrentJoints(): Observable<{ success: boolean; joints: number[]; message?: string }> {
    return this.http.get<{ success: boolean; joints: number[]; message?: string }>(
      `${this.baseUrl}/robot/current-joints`,
      { headers: this.authHeaders }
    ).pipe(timeout(API_TIMEOUT_MS));
  }

  getSavedPositions(): Observable<{ success: boolean; positions: SavedJointPosition[] }> {
    return this.http.get<{ success: boolean; positions: SavedJointPosition[] }>(
      `${this.baseUrl}/robot/positions`,
      { headers: this.authHeaders }
    ).pipe(timeout(API_TIMEOUT_MS));
  }

  saveJointPosition(name: string): Observable<{ success: boolean; position: SavedJointPosition; message?: string }> {
    return this.http.post<{ success: boolean; position: SavedJointPosition; message?: string }>(
      `${this.baseUrl}/robot/positions`,
      { name },
      { headers: this.authHeaders }
    ).pipe(timeout(API_TIMEOUT_MS));
  }

  deleteJointPosition(id: string): Observable<{ success: boolean }> {
    return this.http.delete<{ success: boolean }>(
      `${this.baseUrl}/robot/positions/${id}`,
      { headers: this.authHeaders }
    ).pipe(timeout(API_TIMEOUT_MS));
  }

  /* ── Logout ───────────────────────────────────────────────── */
  logout(): Observable<any> {
    return this.http.post(`${this.baseUrl}/logout`, {}, {
      headers: this.authHeaders
    }).pipe(timeout(API_TIMEOUT_MS));
  }

  /* ── Attendance ───────────────────────────────────────────── */
  getConnectedWorkers(): Observable<{ connected: any[]; count: number }> {
    return this.http.get<{ connected: any[]; count: number }>(
      `${this.baseUrl}/admin/attendance/connected`,
      { headers: this.authHeaders }
    ).pipe(timeout(API_TIMEOUT_MS));
  }

  getAttendanceHistory(params: { date?: string; userId?: string; range?: string } = {}): Observable<any> {
    const q = new URLSearchParams();
    if (params.date) q.set('date', params.date);
    if (params.userId) q.set('userId', params.userId);
    if (params.range) q.set('range', params.range);
    return this.http.get(`${this.baseUrl}/admin/attendance/history?${q}`, {
      headers: this.authHeaders
    }).pipe(timeout(API_TIMEOUT_MS));
  }

  /* ── System Settings ─────────────────────────────────────── */
  getSystemSettings(): Observable<{ daily_target: number; expiry_threshold: string | null }> {
    return this.http.get<any>(`${this.baseUrl}/admin/settings`, {
      headers: this.authHeaders
    }).pipe(timeout(API_TIMEOUT_MS));
  }

  updateSystemSettings(settings: { daily_target?: number; expiry_threshold?: string | null }): Observable<any> {
    return this.http.put(`${this.baseUrl}/admin/settings`, settings, {
      headers: this.authHeaders
    }).pipe(timeout(API_TIMEOUT_MS));
  }

  /* ── System Timeline ─────────────────────────────────────── */
  getTimeline(date?: string): Observable<{ date: string; events: any[] }> {
    const q = date ? `?date=${date}` : '';
    return this.http.get<any>(`${this.baseUrl}/admin/timeline${q}`, {
      headers: this.authHeaders
    }).pipe(timeout(API_TIMEOUT_MS));
  }

  postTimelineEvent(eventType: string, label: string): Observable<any> {
    return this.http.post(`${this.baseUrl}/admin/timeline/event`, { eventType, label }, {
      headers: this.authHeaders
    }).pipe(timeout(API_TIMEOUT_MS));
  }

  /* ── Error Logs ──────────────────────────────────────────── */
  getErrorLogs(params: { resolved?: boolean; severity?: string } = {}): Observable<{ logs: any[] }> {
    const q = new URLSearchParams();
    if (params.resolved !== undefined) q.set('resolved', String(params.resolved));
    if (params.severity) q.set('severity', params.severity);
    return this.http.get<{ logs: any[] }>(`${this.baseUrl}/error-logs?${q}`, {
      headers: this.authHeaders
    }).pipe(timeout(API_TIMEOUT_MS));
  }

  acknowledgeErrorLog(id: string): Observable<any> {
    return this.http.put(`${this.baseUrl}/error-logs/${id}/acknowledge`, {}, {
      headers: this.authHeaders
    }).pipe(timeout(API_TIMEOUT_MS));
  }

  /* ── Danger Alert (manual trigger) ──────────────────────── */
  triggerDangerAlert(message?: string): Observable<any> {
    return this.http.post(`${this.baseUrl}/admin/danger-alert`, { message }, {
      headers: this.authHeaders
    }).pipe(timeout(API_TIMEOUT_MS));
  }
}
