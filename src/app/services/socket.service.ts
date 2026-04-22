import { Injectable } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { Observable, Subject } from 'rxjs';
import { environment } from '../../environments/environment';

@Injectable({
  providedIn: 'root'
})
export class SocketService {
  private socket: Socket;
  private alertSubject = new Subject<any>();
  public alerts$ = this.alertSubject.asObservable();

  private robotHealthSubject = new Subject<any>();
  public robotHealth$ = this.robotHealthSubject.asObservable();

  private robotAlertSubject = new Subject<any>();
  public robotAlert$ = this.robotAlertSubject.asObservable();

  constructor() {
    this.socket = io(environment.socketUrl);

    this.socket.on('alert', (data: any) => {
      this.alertSubject.next(data);
    });

    // Backend emits 'inspectionAlert' when a new inspection is logged via /api/robot-log
    this.socket.on('inspectionAlert', (data: any) => {
      this.alertSubject.next(data);
    });

    this.socket.on('robotHealth', (data: any) => {
      this.robotHealthSubject.next(data);
    });

    this.socket.on('robotAlert', (data: any) => {
      this.robotAlertSubject.next(data);
    });

    this.socket.on('connect', () => {
      console.log('Connected to WebSocket server');
    });

    this.socket.on('disconnect', () => {
      console.log('Disconnected from WebSocket server');
    });
  }

  onNewInspection(callback: (inspection: any) => void) {
    this.socket.on('newInspection', callback);
  }

  sendEvent(event: string, data: any) {
    this.socket.emit(event, data);
  }

  onEvent(event: string): Observable<any> {
    return new Observable(observer => {
      this.socket.on(event, (data: any) => observer.next(data));
    });
  }
}
