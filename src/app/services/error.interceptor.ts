import { Injectable } from '@angular/core';
import { HttpRequest, HttpHandler, HttpEvent, HttpInterceptor, HttpErrorResponse } from '@angular/common/http';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { MatSnackBar } from '@angular/material/snack-bar';

@Injectable()
export class ErrorInterceptor implements HttpInterceptor {
  constructor(private snackBar: MatSnackBar) {}

  intercept(request: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<any>> {
    return next.handle(request).pipe(
      catchError((error: HttpErrorResponse) => {
        let errorMsg = 'An unknown error occurred!';
        if (error.error instanceof ErrorEvent) {
          // Client side error
          errorMsg = `Error: ${error.error.message}`;
        } else {
          // Server side error
          errorMsg = error.error?.message || `Server returned code: ${error.status}, error message is: ${error.message}`;
        }
        
        // Always display it
        this.snackBar.open(errorMsg, 'Close', { 
          duration: 5000,
          panelClass: ['error-snackbar']
        });
        
        return throwError(() => new Error(errorMsg));
      })
    );
  }
}
