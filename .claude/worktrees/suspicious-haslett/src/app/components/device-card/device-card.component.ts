import { Component, Input } from '@angular/core';

@Component({
  selector: 'app-device-card',
  standalone: false,
  templateUrl: './device-card.component.html',
  styleUrls: ['./device-card.component.css']
})
export class DeviceCardComponent {

  @Input() name!: string;
  @Input() status!: string;

  get statusClass(): string {
    if (this.status === 'Online' || this.status === 'Connected') return 'online';
    if (this.status === 'Disconnected') return 'offline';
    return 'warning';
  }

}
