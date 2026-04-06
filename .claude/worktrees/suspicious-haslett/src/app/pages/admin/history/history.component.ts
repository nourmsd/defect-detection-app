import { Component, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { AuthService } from '../../../services/auth.service';
import { environment } from '../../../../environments/environment';

@Component({
  selector: 'app-history',
  templateUrl: './history.component.html',
  styleUrls: ['./history.component.css'],
  standalone: false
})
export class HistoryComponent implements OnInit {
  history: any[] = [];
  displayedColumns: string[] = ['id', 'result', 'timestamp'];

  constructor(private http: HttpClient, private authService: AuthService) { }

  ngOnInit() {
    this.fetchHistory();
  }

  fetchHistory() {
    const token = this.authService.getToken();
    this.http.get<any[]>(`${environment.apiUrl}/admin/history`, {
      headers: { Authorization: `Bearer ${token}` }
    }).subscribe(data => {
      this.history = data;
    });
  }

  logout() {
    this.authService.logout();
  }
}
