import { Injectable } from '@angular/core';
import { HttpRequest, HttpHandler, HttpEvent, HttpInterceptor, HttpErrorResponse } from '@angular/common/http';
import { Observable, throwError, TimeoutError } from 'rxjs';
import { catchError, timeout } from 'rxjs/operators';
import { MatSnackBar } from '@angular/material/snack-bar';

@Injectable()
export class ErrorInterceptor implements HttpInterceptor {
  constructor(private snackBar: MatSnackBar) { }

  // Auth endpoints handle their own errors in the component — skip interceptor display
  private readonly silentUrls = [
    '/api/login',
    '/api/register',
    '/api/reset-password',
    '/api/robot/action',
    '/api/robot/health',
    '/api/worker/dashboard-data',
    '/api/stream/health',
    '/api/robot/status'
  ];

  intercept(request: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<any>> {
    return next.handle(request).pipe(
      timeout(30000),
      catchError((error: HttpErrorResponse | TimeoutError | any) => {
        const isSilent = this.silentUrls.some(url => request.url.includes(url));

        let errorMsg: string;
        if (error instanceof TimeoutError) {
          errorMsg = 'Request timed out. The server is taking too long to respond.';
        } else {
          errorMsg = this.resolveMessage(error);
        }

        if (!isSilent) {
          this.snackBar.open(errorMsg, 'Close', {
            duration: 5000,
            panelClass: ['error-snackbar']
          });
        } else {
          console.warn('[http]', request.method, request.url, errorMsg);
        }

        return throwError(() => ({ ...error, resolvedMessage: errorMsg }));
      })
    );
  }

  private resolveMessage(error: HttpErrorResponse): string {
    // No connection
    if (error.status === 0) return 'Cannot connect to server. Please check your connection.';

    // Use backend message if present (JSON body with "message" field)
    const backendMsg = error.error?.message;
    if (backendMsg && typeof backendMsg === 'string') return backendMsg;

    // If the backend sent a plain string body (e.g. Flask 500 traceback)
    if (typeof error.error === 'string' && error.error.length < 200) return error.error;

    // Fallback by status code — generic messages (not auth-specific)
    switch (error.status) {
      case 400: return 'Invalid request. Please check your input.';
      case 401: return 'Session expired. Please log in again.';
      case 403: return 'Access denied.';
      case 404: return 'Resource not found.';
      case 500: return 'Server error. Please try again later.';
      case 503: return 'Service unavailable. Robot may be disconnected.';
      case 504: return 'Request timed out.';
      default: return `Unexpected error (${error.status}).`;
    }
  }
}
