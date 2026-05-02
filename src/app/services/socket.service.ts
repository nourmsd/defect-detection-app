import { Injectable, NgZone } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

export interface InspectionSocketPayload {
  id: string;
  label: string;
  confidence: number;
  processing_time: number;
  detected_date: string;
  timestamp: string;
}

export interface RobotAlertSocketPayload {
  level: 'warning' | 'error' | 'critical';
  message: string;
  timestamp: string;
}

export interface SystemHealthSocketPayload {
  fps: number;
  camera: string;
  stream: string;
  robot_connected: boolean;
  robot_status?: string;
  ai_status?: string;
  plc_status?: string;
  db_status?: string;
}

export interface DailyResetPayload {
  timestamp: string;
}

export interface InferenceStatusSocketPayload {
  status: 'IDLE' | 'NO_DETECTION' | 'PROCESSING' | 'READING' | 'FINAL_NORMAL' | 'FINAL_DEFECTIVE';
  detected_date: string;
  confidence: number;
  yolo_detections: number;
  inference_ms: number;
  fps: number;
  timestamp: string;
}

export interface AttendanceUpdatePayload {
  action: 'login' | 'logout';
  userId: string;
  username: string;
  email: string;
  role: string;
  loginTime?: string;
  logoutTime?: string;
  sessionDuration?: number;
  date?: string;
}

export interface SystemTimelinePayload {
  date: string;
  event: {
    eventType: string;
    color: string;
    label: string;
    timestamp: string;
  };
}

export interface ErrorLogPayload {
  id: string;
  errorType: string;
  severity: 'critical' | 'error' | 'warning';
  message: string;
  suggestedAction: string;
  timestamp: string;
  resolved: boolean;
}

export interface DangerAlertPayload {
  message: string;
  timestamp: string;
  level: 'critical';
}

export interface SocketEnvelopeMap {
  inspection: InspectionSocketPayload;
  robot_alert: RobotAlertSocketPayload;
  system_health: SystemHealthSocketPayload;
  inference_status: InferenceStatusSocketPayload;
  attendance_update: AttendanceUpdatePayload;
  system_timeline: SystemTimelinePayload;
  error_log: ErrorLogPayload;
  danger_alert: DangerAlertPayload;
  daily_reset: DailyResetPayload;
}

export type SocketEventType = keyof SocketEnvelopeMap;

export type SocketEventEnvelope = {
  [K in SocketEventType]: {
    type: K;
    payload: SocketEnvelopeMap[K];
  }
}[SocketEventType];

@Injectable({
  providedIn: 'root'
})
export class SocketService {
  private socket: Socket;

  constructor(private ngZone: NgZone) {
    this.socket = io(environment.socketUrl, {
      transports: ['websocket', 'polling'],
      autoConnect: true,
    });

    this.socket.on('connect', () => console.log('[socket] connected'));
    this.socket.on('disconnect', () => console.log('[socket] disconnected'));
  }

  /** RAW STREAM — every event type */
  onEvent(): Observable<SocketEventEnvelope> {
    return new Observable(observer => {
      const handler = (data: SocketEventEnvelope) => {
        this.ngZone.run(() => observer.next(data));
      };
      this.socket.on('event', handler);
      return () => this.socket.off('event', handler);
    });
  }

  onInspection(): Observable<InspectionSocketPayload> {
    return new Observable(observer => {
      const handler = (data: SocketEventEnvelope) => {
        if (data?.type === 'inspection') {
          this.ngZone.run(() => observer.next(data.payload as InspectionSocketPayload));
        }
      };
      this.socket.on('event', handler);
      return () => this.socket.off('event', handler);
    });
  }

  onRobotAlert(): Observable<RobotAlertSocketPayload> {
    return new Observable(observer => {
      const handler = (data: SocketEventEnvelope) => {
        if (data?.type === 'robot_alert') {
          this.ngZone.run(() => observer.next(data.payload as RobotAlertSocketPayload));
        }
      };
      this.socket.on('event', handler);
      return () => this.socket.off('event', handler);
    });
  }

  onSystemHealth(): Observable<SystemHealthSocketPayload> {
    return new Observable(observer => {
      const handler = (data: SocketEventEnvelope) => {
        if (data?.type === 'system_health') {
          this.ngZone.run(() => observer.next(data.payload as SystemHealthSocketPayload));
        }
      };
      this.socket.on('event', handler);
      return () => this.socket.off('event', handler);
    });
  }

  onInferenceStatus(): Observable<InferenceStatusSocketPayload> {
    return new Observable(observer => {
      const handler = (data: SocketEventEnvelope) => {
        if (data?.type === 'inference_status') {
          this.ngZone.run(() => observer.next(data.payload as InferenceStatusSocketPayload));
        }
      };
      this.socket.on('event', handler);
      return () => this.socket.off('event', handler);
    });
  }

  onAttendanceUpdate(): Observable<AttendanceUpdatePayload> {
    return new Observable(observer => {
      const handler = (data: SocketEventEnvelope) => {
        if (data?.type === 'attendance_update') {
          this.ngZone.run(() => observer.next(data.payload as AttendanceUpdatePayload));
        }
      };
      this.socket.on('event', handler);
      return () => this.socket.off('event', handler);
    });
  }

  onSystemTimeline(): Observable<SystemTimelinePayload> {
    return new Observable(observer => {
      const handler = (data: SocketEventEnvelope) => {
        if (data?.type === 'system_timeline') {
          this.ngZone.run(() => observer.next(data.payload as SystemTimelinePayload));
        }
      };
      this.socket.on('event', handler);
      return () => this.socket.off('event', handler);
    });
  }

  onErrorLog(): Observable<ErrorLogPayload> {
    return new Observable(observer => {
      const handler = (data: SocketEventEnvelope) => {
        if (data?.type === 'error_log') {
          this.ngZone.run(() => observer.next(data.payload as ErrorLogPayload));
        }
      };
      this.socket.on('event', handler);
      return () => this.socket.off('event', handler);
    });
  }

  onDangerAlert(): Observable<DangerAlertPayload> {
    return new Observable(observer => {
      const handler = (data: SocketEventEnvelope) => {
        if (data?.type === 'danger_alert') {
          this.ngZone.run(() => observer.next(data.payload as DangerAlertPayload));
        }
      };
      this.socket.on('event', handler);
      return () => this.socket.off('event', handler);
    });
  }

  emit(type: SocketEventType, payload: SocketEnvelopeMap[SocketEventType]) {
    this.socket.emit('event', { type, payload });
  }
}
