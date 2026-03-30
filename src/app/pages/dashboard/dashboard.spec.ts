import { Component, OnInit } from '@angular/core';
import { ApiService, Inspection } from '../../services/api.service';
import { SocketService } from '../../services/socket.service';

@Component({
    selector: 'app-dashboard',
    standalone: false,
    templateUrl: './dashboard.component.html',
    styleUrls: ['./dashboard.component.css']
})
export class DashboardComponent implements OnInit {

    // Inspection data
    inspections: Inspection[] = [];

    // Dashboard stats
    totalInspections = 0;
    conforming = 0;
    defective = 0;
    defectRate = 0;

    constructor(
        private api: ApiService,
        private socketService: SocketService
    ) { }

    ngOnInit() {
        // 1️⃣ Load initial inspections from backend
        this.api.getInspections().subscribe(data => {
            this.inspections = data.slice(0, 50); // last 50
            this.updateStats(this.inspections);
        });

        // 2️⃣ Listen for real-time inspection updates via Socket.IO
        this.socketService.onNewInspection((inspection: Inspection) => {
            // Add new inspection at the top
            this.inspections.unshift(inspection);

            // Keep only last 50 inspections
            if (this.inspections.length > 50) {
                this.inspections.pop();
            }

            // Update stats
            this.updateStats(this.inspections);
        });
    }

    // Helper to calculate stats
    private updateStats(data: Inspection[]) {
        this.inspections = data;
        this.totalInspections = data.length;
        this.conforming = data.filter(i => i.label === 'OK').length;
        this.defective = data.filter(i => i.label === 'defective').length;
        this.defectRate = this.totalInspections
            ? Math.round((this.defective / this.totalInspections) * 100)
            : 0;
    }

    // Optional: get last 10 inspections for list display
    get recentInspections() {
        return this.inspections.slice(0, 10);
    }
}