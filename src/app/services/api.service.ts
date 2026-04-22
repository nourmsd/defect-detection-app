import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

// Define the Inspection type
export interface Inspection {
  id: string;
  label: 'OK' | 'defective';
  timestamp: string;
  confidence?: number;       // 0–1 or 0–100 from AI model
  processing_time?: number;  // seconds
}

// Robot health interfaces
export interface RobotAlert {
  id: string;
  severity: 'warning' | 'critical';
  message: string;
  source: string;
  timestamp: string;
}

export interface RobotHealth {
  hardware_status: {
    temperatures: number[];
    voltages: number[];
    hardware_errors: number[];
    hardware_errors_message: string[];
    calibration_needed: boolean;
    calibration_in_progress: boolean;
    motor_names: string[];
    motor_types: string[];
    rpi_temperature: number;
    connection_up: boolean;
    hardware_version: string;
  };
  robot_status: {
    robot_status_str: string;
    robot_message: string;
    rpi_overheating: boolean;
    out_of_bounds: boolean;
    logs_status_str: string;
  };
  joint_states: {
    position: number[];
    velocity: number[];
    effort: number[];
    name: string[];
  };
  collision_detected: boolean;
  alerts: RobotAlert[];
  robot_connected: boolean;
  last_updated: string;
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

  // Fetch worker dashboard data: { gauges: { totalInspected, defective, conforming }, history: Inspection[] }
  getInspections(): Observable<{ gauges: { totalInspected: number; defective: number; conforming: number }; history: Inspection[] }> {
    return this.http.get<{ gauges: { totalInspected: number; defective: number; conforming: number }; history: Inspection[] }>(`${this.baseUrl}/worker/dashboard-data`, {
      headers: this.authHeaders
    });
  }

  // Fetch robot health snapshot (initial load)
  getRobotHealth(): Observable<RobotHealth> {
    return this.http.get<RobotHealth>(`${this.baseUrl}/robot/health`, {
      headers: this.authHeaders
    });
  }

  // Trigger a robot action (admin only)
  triggerRobotAction(action: string): Observable<any> {
    return this.http.post(`${this.baseUrl}/robot/action`, { action }, {
      headers: this.authHeaders
    });
  }

  // Delete fake/test inspection data from MongoDB
  cleanTestData(): Observable<any> {
    return this.http.delete(`${this.baseUrl}/admin/clean-test-data`, {
      headers: this.authHeaders
    });
  }

  // Fetch paginated inspection history with filters
  getInspectionHistory(params: {
    page?: number; limit?: number; result?: string;
    minConfidence?: number; maxConfidence?: number;
    dateFrom?: string; dateTo?: string; search?: string;
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
    });
  }

  // Fetch analytics data with time range
  getAnalytics(range: string = '30d'): Observable<any> {
    return this.http.get(`${this.baseUrl}/admin/analytics?range=${range}`, {
      headers: this.authHeaders
    });
  }
}
