import { Component, Input } from '@angular/core';

@Component({
  selector: 'app-stat-card',
  standalone: false,
  templateUrl: './stat-card.component.html',
  styleUrls: ['./stat-card.component.css']
})
export class StatCardComponent {

  @Input() title!: string;
  @Input() value!: number | string;

  @Input() color: string = 'blue';   // default
  @Input() type: string = 'normal';  // 'normal' or 'circle'

}
