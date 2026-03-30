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

  constructor() {
    this.socket = io(environment.socketUrl);

    this.socket.on('alert', (data: any) => {
      this.alertSubject.next(data);
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
