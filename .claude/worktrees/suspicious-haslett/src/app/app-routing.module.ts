import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { LoginComponent } from './pages/auth/login/login.component';
import { RegisterComponent } from './pages/auth/register/register.component';
import { ResetPasswordComponent } from './pages/auth/reset-password/reset-password.component';
import { AuthGuard } from './guards/auth.guard';

// We will create these shortly
import { WorkerDashboardComponent } from './pages/worker/dashboard/dashboard.component';
import { AdminDashboardComponent } from './pages/admin/dashboard/dashboard.component';
import { HistoryComponent } from './pages/admin/history/history.component';
import { AnalyticsComponent } from './pages/admin/analytics/analytics.component';

const routes: Routes = [
  { path: 'login', component: LoginComponent },
  { path: 'register', component: RegisterComponent },
  { path: 'reset-password', component: ResetPasswordComponent },
  { 
    path: 'worker-dashboard', 
    component: WorkerDashboardComponent, 
    canActivate: [AuthGuard], 
    data: { roles: ['worker', 'admin'] } 
  },
  { 
    path: 'admin-dashboard', 
    component: AdminDashboardComponent, 
    canActivate: [AuthGuard], 
    data: { roles: ['admin'] } 
  },
  { 
    path: 'admin/history', 
    component: HistoryComponent, 
    canActivate: [AuthGuard], 
    data: { roles: ['admin'] } 
  },
  { 
    path: 'admin/analytics', 
    component: AnalyticsComponent, 
    canActivate: [AuthGuard], 
    data: { roles: ['admin'] } 
  },
  { path: '', redirectTo: '/login', pathMatch: 'full' },
  { path: '**', redirectTo: '/login' }
];

@NgModule({
  imports: [RouterModule.forRoot(routes)],
  exports: [RouterModule]
})
export class AppRoutingModule { }
