import { Component, Input } from '@angular/core';
import { Inspection } from '../../services/api.service';

@Component({
  selector: 'app-inspection-list',
  standalone: false,
  templateUrl: './inspection-list.component.html',
  styleUrls: ['./inspection-list.component.css']
})
export class InspectionListComponent {
  @Input() inspections: Inspection[] = [];
}
