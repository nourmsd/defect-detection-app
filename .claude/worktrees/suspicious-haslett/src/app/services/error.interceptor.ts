import { Injectable } from '@angular/core';
import { HttpRequest, HttpHandler, HttpEvent, HttpInterceptor, HttpErrorResponse } from '@angular/common/http';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { MatSnackBar } from '@angular/material/snack-bar';

@Injectable()
export class ErrorInterceptor implements HttpInterceptor {
  constructor(private snackBar: MatSnackBar) { }

  // Auth endpoints handle their own errors in the component — skip interceptor display
  private readonly silentUrls = ['/api/auth/login', '/api/auth/register', '/api/auth/reset-password'];

  intercept(request: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<any>> {
    return next.handle(request).pipe(
      catchError((error: HttpErrorResponse) => {
        const errorMsg = this.resolveMessage(error);
        const isSilent = this.silentUrls.some(url => request.url.includes(url));

        // Only show snackbar for non-auth routes — auth pages show their own messages
        if (!isSilent) {
          this.snackBar.open(errorMsg, 'Close', {
            duration: 5000,
            panelClass: ['error-snackbar']
          });
        }

        return throwError(() => ({ ...error, resolvedMessage: errorMsg }));
      })
    );
  }

  private resolveMessage(error: HttpErrorResponse): string {
    // No connection
    if (error.status === 0) return 'Cannot connect to server. Please check your connection.';

    // Use backend message if present
    const backendMsg = error.error?.message;
    if (backendMsg) return backendMsg;

    // Fallback by status code
    switch (error.status) {
      case 400: return 'Invalid request. Please check your input.';
      case 401: return 'Invalid email or password.';
      case 403: return 'Access denied.';
      case 404: return 'Email not registered.';
      case 500: return 'Server error. Please try again later.';
      default: return `Unexpected error (${error.status}).`;
    }
  }
}