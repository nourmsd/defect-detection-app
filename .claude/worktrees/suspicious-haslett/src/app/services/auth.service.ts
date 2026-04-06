import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { BehaviorSubject, Observable, tap } from 'rxjs';
import { jwtDecode } from 'jwt-decode';
import { environment } from '../../environments/environment';

interface User {
  id: string;
  username: string;
  email: string;
  role: 'worker' | 'admin';
}

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private apiUrl = environment.apiUrl;
  private currentUserSubject = new BehaviorSubject<User | null>(null);
  public currentUser$ = this.currentUserSubject.asObservable();

  constructor(private http: HttpClient, private router: Router) {
    const token = localStorage.getItem('token');
    if (token) {
      try {
        const decoded: any = jwtDecode(token);
        if (decoded.exp * 1000 > Date.now()) {
          // Fetch user data from local storage or API
          const userData = JSON.parse(localStorage.getItem('user') || 'null');
          this.currentUserSubject.next(userData);
        } else {
          this.logout();
        }
      } catch (e) {
        this.logout();
      }
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
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    this.currentUserSubject.next(null);
    this.router.navigate(['/login']);
  }

  private handleAuth(res: any) {
    if (res.token) {
      localStorage.setItem('token', res.token);
      
      const userObj = {
        id: res.id,
        username: res.username,
        email: res.email,
        role: res.role
      };
      
      localStorage.setItem('user', JSON.stringify(userObj));
      this.currentUserSubject.next(userObj as User);
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
