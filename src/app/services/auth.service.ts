import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { BehaviorSubject, Observable, tap } from 'rxjs';
import { jwtDecode } from 'jwt-decode';
import { environment } from '../../environments/environment';

export interface User {
  id: string;
  firstName: string;
  lastName: string;
  fullName: string;
  username: string;
  email: string;
  role: 'worker' | 'admin' | 'supervisor';
}

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private apiUrl = environment.apiUrl;
  private currentUserSubject = new BehaviorSubject<User | null>(null);
  public currentUser$ = this.currentUserSubject.asObservable();

  constructor(private http: HttpClient, private router: Router) {
    this.restoreSession();
  }

  // Separate method so it runs after constructor injection is complete.
  // We must NOT call this.logout() here — that triggers router.navigate()
  // before the Angular router is bootstrapped, which silently hangs navigation
  // and leaves the spinner stuck on the login page.
  private restoreSession(): void {
    const token = localStorage.getItem('token');
    if (!token) return;

    try {
      const decoded: any = jwtDecode(token);
      if (decoded.exp * 1000 > Date.now()) {
        const stored = localStorage.getItem('user');
        if (stored) {
          const userData = JSON.parse(stored) as User;
          this.currentUserSubject.next(userData);
          console.log('[auth] Session restored for', userData.email, '(', userData.role, ')');
        } else {
          // Token valid but user object missing — clear and force re-login via guard
          localStorage.removeItem('token');
        }
      } else {
        // Token expired — clear storage silently; route guards redirect to /login
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        console.log('[auth] Stored token expired — cleared. Guard will redirect to /login.');
      }
    } catch {
      // Malformed token — clear silently
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      console.warn('[auth] Invalid token in storage — cleared.');
    }
  }

  register(userData: any): Observable<any> {
    return this.http.post(`${this.apiUrl}/register`, userData);
  }

  login(credentials: any): Observable<any> {
    return this.http.post(`${this.apiUrl}/login`, credentials).pipe(
      tap((res: any) => this.handleAuth(res))
    );
  }

  resetPassword(data: any): Observable<any> {
    return this.http.post(`${this.apiUrl}/reset-password`, data);
  }

  logout() {
    const token = localStorage.getItem('token');
    // Clear state synchronously first so nothing re-reads stale credentials.
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    this.currentUserSubject.next(null);
    // Fire background logout so backend closes the attendance session.
    if (token) {
      this.http.post(`${this.apiUrl}/logout`, {}, {
        headers: { Authorization: `Bearer ${token}` }
      }).subscribe({ error: () => {} });
    }
    this.router.navigate(['/login']);
  }

  private handleAuth(res: any) {
    if (res.token) {
      localStorage.setItem('token', res.token);

      const fullName = res.fullName || res.username ||
        `${res.firstName || ''} ${res.lastName || ''}`.trim();

      const userObj: User = {
        id: res.id,
        firstName: res.firstName || '',
        lastName: res.lastName || '',
        fullName,
        username: fullName,
        email: res.email,
        role: res.role
      };

      localStorage.setItem('user', JSON.stringify(userObj));
      this.currentUserSubject.next(userObj);
    }
  }

  getToken(): string | null {
    return localStorage.getItem('token');
  }

  get userValue(): User | null {
    return this.currentUserSubject.value;
  }

  isLoggedIn(): boolean {
    return !!this.userValue;
  }
}
