import { Component, OnInit, OnDestroy } from '@angular/core';
import { FormBuilder, FormGroup, Validators } from '@angular/forms';
import { Router, ActivatedRoute } from '@angular/router';
import { AuthService } from '../../../services/auth.service';
import { ThemeService } from '../../../services/theme.service';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Subscription } from 'rxjs';
import { finalize, timeout } from 'rxjs/operators';

@Component({
  selector: 'app-login',
  templateUrl: './login.component.html',
  styleUrls: ['./login.component.css'],
  standalone: false
})
export class LoginComponent implements OnInit, OnDestroy {
  loginForm: FormGroup;
  loading = false;
  hidePassword = true;
  returnUrl: string;
  // Stored primitive bound to [disabled] in the template.
  // Updated only out-of-band (via statusChanges + setLoading), so dev-mode
  // checkNoChanges always reads the same value twice. Without this, the
  // expression `loginForm.invalid || loading` re-evaluates synchronously
  // when Chrome autofill fires input events between the two CD passes,
  // throwing NG0100 in a loop and pinning the main thread (Page Unresponsive).
  submitDisabled = true;
  private statusSub?: Subscription;

  constructor(
    private formBuilder: FormBuilder,
    private route: ActivatedRoute,
    private router: Router,
    private authService: AuthService,
    public themeService: ThemeService,
    private snackBar: MatSnackBar
  ) {
    (window as any).__bootMark__?.('LoginComponent constructor: enter');
    this.loginForm = this.formBuilder.group({
      email: ['', [Validators.required, Validators.email]],
      password: ['', Validators.required]
    });

    // get return url from route parameters or default to '/'
    this.returnUrl = this.route.snapshot.queryParams['returnUrl'] || '/';

    // if already logged in, redirect
    if (this.authService.isLoggedIn()) {
      this.redirectUser();
    }
    (window as any).__bootMark__?.('LoginComponent constructor: exit');
  }

  ngOnInit(): void {
    (window as any).__bootMark__?.('LoginComponent ngOnInit');
    // Re-evaluate the disabled state outside the synchronous render pass.
    // Promise.resolve() runs after the first CD finishes, so the dev-mode
    // checkNoChanges pass sees the same value as the initial render even
    // if browser autofill mutates the form during render.
    this.statusSub = this.loginForm.statusChanges.subscribe(() => {
      Promise.resolve().then(() => {
        this.submitDisabled = this.loginForm.invalid || this.loading;
      });
    });
    Promise.resolve().then(() => {
      this.submitDisabled = this.loginForm.invalid || this.loading;
    });
  }

  ngOnDestroy(): void {
    this.statusSub?.unsubscribe();
  }

  private setLoading(v: boolean): void {
    this.loading = v;
    this.submitDisabled = this.loginForm.invalid || v;
  }

  onSubmit() {
    if (this.loginForm.invalid || this.loading) return;

    this.setLoading(true);
    // Hard guard: even if the observable behaves unexpectedly, never let
    // the spinner stay stuck — finalize() always fires on
    // complete / error / unsubscribe. A 10s timeout fails fast so the
    // user isn't watching a 30s spinner when the backend is unreachable.
    this.authService.login(this.loginForm.value)
      .pipe(
        timeout(10000),
        finalize(() => { this.setLoading(false); })
      )
      .subscribe({
        next: () => {
          this.snackBar.open('Login successful!', 'Close', { duration: 3000 });
          this.redirectUser();
        },
        error: (err) => {
          const msg =
            err?.name === 'TimeoutError'
              ? 'Server is not responding. Check that the backend is running on :5000.'
              : err?.resolvedMessage || err?.error?.message || 'Login failed';
          this.snackBar.open(msg, 'Close', {
            duration: 5000,
            panelClass: ['error-snackbar']
          });
        }
      });
  }

  private redirectUser() {
    const userRole = this.authService.userValue?.role;
    if (userRole === 'admin' || userRole === 'supervisor') {
      this.router.navigate(['/admin-dashboard']);
    } else {
      this.router.navigate(['/worker-dashboard']);
    }
  }
}
