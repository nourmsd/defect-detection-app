import { Injectable } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { BehaviorSubject, Observable, Subject } from 'rxjs';
import { environment } from '../../environments/environment';

@Injectable({
  providedIn: 'root'
})
export class SocketService {
  private socket: Socket;
  private alertSubject = new Subject<any>();
  private inspectionSubject = new Subject<any>();
  private connectedSubject = new BehaviorSubject<boolean>(false);
  private clientCountSubject = new BehaviorSubject<number>(0);

  public alerts$ = this.alertSubject.asObservable();
  public newInspection$ = this.inspectionSubject.asObservable();
  public connected$ = this.connectedSubject.asObservable();
  public clientCount$ = this.clientCountSubject.asObservable();

  constructor() {
    this.socket = io(environment.socketUrl, {
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 10000,
      timeout: 10000
    });

    this.socket.on('connect', () => {
      console.log('Connected to WebSocket server');
      this.connectedSubject.next(true);
    });

    this.socket.on('disconnect', () => {
      console.log('Disconnected from WebSocket server');
      this.connectedSubject.next(false);
    });

    this.socket.on('connect_error', () => {
      this.connectedSubject.next(false);
    });

    this.socket.on('alert', (data: any) => {
      this.alertSubject.next(data);
    });

    this.socket.on('newInspection', (data: any) => {
      this.inspectionSubject.next(data);
    });

    this.socket.on('clientCount', (count: number) => {
      this.clientCountSubject.next(count);
    });
  }

  get isConnected(): boolean {
    return this.connectedSubject.value;
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
