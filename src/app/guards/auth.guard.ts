import { Injectable } from '@angular/core';
import { Router, CanActivate, ActivatedRouteSnapshot, RouterStateSnapshot } from '@angular/router';
import { AuthService } from '../services/auth.service';

@Injectable({ providedIn: 'root' })
export class AuthGuard implements CanActivate {
  constructor(
    private router: Router,
    private authService: AuthService
  ) { }

  canActivate(route: ActivatedRouteSnapshot, state: RouterStateSnapshot) {
    const user = this.authService.userValue;
    if (!user) {
      this.router.navigate(['/login'], { queryParams: { returnUrl: state.url } });
      return false;
    }

    // Treat legacy 'admin' role (from before the rename) as 'supervisor'.
    const rawRole = String(user.role || '').toLowerCase();
    const role = rawRole === 'admin' ? 'supervisor' : rawRole;
    const allowed = (route.data['roles'] as string[] | undefined)
      ?.map(r => r.toLowerCase())
      .map(r => r === 'admin' ? 'supervisor' : r);

    if (allowed && !allowed.includes(role)) {
      // Role not allowed on this route. Redirect to a dashboard the user CAN
      // reach — and only if it differs from the current URL — otherwise we'd
      // bounce between two routes the role can't enter and create an
      // infinite loop (which is exactly the bug we just fixed).
      const target = role === 'supervisor' ? '/admin-dashboard'
                   : role === 'worker' ? '/worker-dashboard'
                   : null;

      if (target && target !== state.url.split('?')[0]) {
        this.router.navigate([target]);
      } else {
        // No safe destination (unknown role, or already at the target). Force re-login.
        this.authService.logout();
      }
      return false;
    }

    return true;
  }
}
