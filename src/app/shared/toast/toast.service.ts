import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';

export type ToastType = 'success' | 'warning' | 'error' | 'info';

export interface Toast {
  id: number;
  type: ToastType;
  message: string;
  duration: number;
}

@Injectable({ providedIn: 'root' })
export class ToastService {
  private toasts$ = new BehaviorSubject<Toast[]>([]);
  private nextId = 1;
  private timers = new Map<number, ReturnType<typeof setTimeout>>();

  get stream(): Observable<Toast[]> {
    return this.toasts$.asObservable();
  }

  show(message: string, type: ToastType = 'info', duration = 4000): number {
    const id = this.nextId++;
    const toast: Toast = { id, type, message, duration };
    this.toasts$.next([toast, ...this.toasts$.value]);
    if (duration > 0) {
      this.timers.set(id, setTimeout(() => this.dismiss(id), duration));
    }
    return id;
  }

  success(message: string, duration = 3500) { return this.show(message, 'success', duration); }
  warning(message: string, duration = 5000) { return this.show(message, 'warning', duration); }
  error(message: string, duration = 6000)   { return this.show(message, 'error', duration); }
  info(message: string, duration = 4000)    { return this.show(message, 'info', duration); }

  dismiss(id: number): void {
    const timer = this.timers.get(id);
    if (timer) { clearTimeout(timer); this.timers.delete(id); }
    this.toasts$.next(this.toasts$.value.filter(t => t.id !== id));
  }

  clear(): void {
    this.timers.forEach(t => clearTimeout(t));
    this.timers.clear();
    this.toasts$.next([]);
  }
}
