import { Component, OnInit, OnDestroy } from '@angular/core';
import { AuthService } from '../../../services/auth.service';
import { SocketService } from '../../../services/socket.service';
import { ThemeService } from '../../../services/theme.service';
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
  validationLoading = false;
  systemStatus: string | null = null;

  private alertSubscription?: Subscription;
  private clockSubscription?: Subscription;

  constructor(
    private authService: AuthService,
    private http: HttpClient,
    private socketService: SocketService,
    public themeService: ThemeService,
    private snackBar: MatSnackBar
  ) { }

  ngOnInit() {
    this.fetchPendingWorkers();
    this.fetchStats();

    // Live clock
    this.clockSubscription = interval(1000).subscribe(() => {
      this.currentTime = new Date();
    });

    // Socket — only for real robot events
    this.alertSubscription = this.socketService.alerts$.subscribe(alert => {
      if (alert && alert.type) {
        this.systemStatus = alert.type === 'danger' ? 'Alert — Defect Detected' : 'Running';
      }
    });
  }

  ngOnDestroy() {
    this.alertSubscription?.unsubscribe();
    this.clockSubscription?.unsubscribe();
  }

  fetchPendingWorkers() {
    const token = this.authService.getToken();
    if (!token) {
      this.snackBar.open('Session expired. Please log in again.', 'Close', { duration: 5000 });
      return;
    }
    this.http.get<any[]>(`${environment.apiUrl}/pending-workers`, {
      headers: { Authorization: `Bearer ${token}` }
    }).subscribe({
      next: (data) => { this.pendingWorkers = data; },
      error: (err) => {
        const msg = err.status === 403
          ? 'Access denied. Admins only.'
          : 'Could not load pending workers. Is the backend running?';
        this.snackBar.open(msg, 'Close', { duration: 6000, panelClass: ['error-snackbar'] });
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
        this.snackBar.open(
          `Worker ${status === 'approved' ? 'approved ✓' : 'rejected ✗'} successfully`,
          'Close',
          { duration: 4000 }
        );
      },
      error: (err) => {
        this.snackBar.open('Action failed: ' + (err.error?.message || 'Unknown error'), 'Close', {
          duration: 5000, panelClass: ['error-snackbar']
        });
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
      error: () => { /* Stats not available — robot not connected yet */ }
    });
  }

  logout() {
    this.authService.logout();
  }
}
