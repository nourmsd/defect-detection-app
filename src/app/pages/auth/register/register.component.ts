import { Component } from '@angular/core';
import { FormBuilder, FormGroup, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../../services/auth.service';
import { MatSnackBar } from '@angular/material/snack-bar';

@Component({
  selector: 'app-register',
  templateUrl: './register.component.html',
  styleUrls: ['./register.component.css'],
  standalone: false
})
export class RegisterComponent {
  registerForm: FormGroup;
  loading = false;
  hidePassword = true;

  constructor(
    private formBuilder: FormBuilder,
    private router: Router,
    private authService: AuthService,
    private snackBar: MatSnackBar
  ) {
    this.registerForm = this.formBuilder.group({
      username: ['', Validators.required],
      email: ['', [Validators.required, Validators.email]],
      password: ['', [Validators.required, Validators.minLength(6)]],
      role: ['worker', Validators.required]
    });
  }
  onSubmit() {
    if (this.registerForm.invalid) return;

    this.loading = true;
    this.authService.register(this.registerForm.value).subscribe({
      next: (res: any) => {
        this.loading = false;
        const msg = res.message || 'Registration successful! Your account is pending admin approval.';
        this.snackBar.open(msg, 'Close', { duration: 10000, panelClass: ['success-snackbar'] });
        this.router.navigate(['/login']);
      },
      error: (err) => {
        this.loading = false;
        const errMsg = err.error?.message || 'Registration failed. Please try again.';
        this.snackBar.open(errMsg, 'Close', { duration: 6000, panelClass: ['error-snackbar'] });
      }
    });
  }
}
