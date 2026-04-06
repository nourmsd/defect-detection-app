import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

export interface Inspection {
  id: string;
  label: 'OK' | 'defective';
  confidence: number;
  timestamp: string;
  device?: string;
}

export interface WorkerStats {
  total: number;
  ok: number;
  defective: number;
  defectRate: number;
  today: { total: number; ok: number; defective: number };
  lastHourCount: number;
}

export interface HealthStatus {
  server: boolean;
  database: boolean;
  databaseStatus: string;
  uptime: number;
  timestamp: string;
}

@Injectable({
  providedIn: 'root'
})
export class ApiService {

  private baseUrl = environment.apiUrl;

  constructor(private http: HttpClient) {}

  private getHeaders(): HttpHeaders {
    const token = localStorage.getItem('token');
    return new HttpHeaders({ Authorization: `Bearer ${token}` });
  }

  // Fetch recent inspections (for workers)
  getInspections(): Observable<Inspection[]> {
    return this.http.get<Inspection[]>(`${this.baseUrl}/worker/dashboard`, {
      headers: this.getHeaders()
    });
  }

  // Fetch worker aggregate stats
  getWorkerStats(): Observable<WorkerStats> {
    return this.http.get<WorkerStats>(`${this.baseUrl}/worker/stats`, {
      headers: this.getHeaders()
    });
  }

  // Health check (no auth required)
  getHealth(): Observable<HealthStatus> {
    return this.http.get<HealthStatus>(`${this.baseUrl}/health`);
  }
}
