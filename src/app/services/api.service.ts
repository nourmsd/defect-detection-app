import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

// Define the Inspection type
export interface Inspection {
  id: string;
  label: 'OK' | 'defective';
  timestamp: string;
}

@Injectable({
  providedIn: 'root'
})
export class ApiService {

  private baseUrl = environment.apiUrl;

  constructor(private http: HttpClient) {}

  // Fetch recent inspections (for workers)
  getInspections(): Observable<Inspection[]> {
    const token = localStorage.getItem('token');
    return this.http.get<Inspection[]>(`${this.baseUrl}/worker/dashboard`, {
      headers: { Authorization: `Bearer ${token}` }
    });
  }
}
