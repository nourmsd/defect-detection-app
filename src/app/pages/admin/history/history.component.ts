import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { ApiService } from '../../../services/api.service';
import { AuthService } from '../../../services/auth.service';
import { ThemeService } from '../../../services/theme.service';

@Component({
  selector: 'app-history',
  templateUrl: './history.component.html',
  styleUrls: ['./history.component.css'],
  standalone: false
})
export class HistoryComponent implements OnInit {

  // Data
  inspections: any[] = [];
  // Start in loading state so the spinner shows immediately on route entry,
  // preventing a flash of the "no data" empty state before ngOnInit fires.
  loading = true;
  errorMessage: string | null = null;

  // Pagination
  currentPage = 1;
  pageSize = 20;
  totalRecords = 0;
  totalPages = 0;

  // Filters
  filterResult = 'all';
  filterDateFrom = '';
  filterDateTo = '';
  filterMinConfidence: number | null = null;
  searchTerm = '';

  // Detail drawer
  selectedInspection: any = null;
  drawerOpen = false;

  constructor(
    private apiService: ApiService,
    private authService: AuthService,
    public themeService: ThemeService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit() {
    this.fetchHistory();
  }

  fetchHistory() {
    this.loading = true;
    this.errorMessage = null;

    const params: any = {
      page: this.currentPage,
      limit: this.pageSize
    };

    if (this.filterResult !== 'all') params.result = this.filterResult;
    if (this.filterDateFrom) params.dateFrom = this.filterDateFrom;
    if (this.filterDateTo) params.dateTo = this.filterDateTo;
    if (this.filterMinConfidence != null && this.filterMinConfidence > 0) {
      params.minConfidence = this.filterMinConfidence;
    }
    if (this.searchTerm.trim()) params.search = this.searchTerm.trim();

    this.apiService.getInspectionHistory(params).subscribe({
      next: (res: any) => {
        this.inspections = res.data || [];
        this.totalRecords = res.pagination?.total || 0;
        this.totalPages = res.pagination?.totalPages || 0;
        this.loading = false;
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.inspections = [];
        this.totalRecords = 0;
        this.totalPages = 0;
        this.loading = false;
        if (err?.name === 'TimeoutError') {
          this.errorMessage = 'Server timeout — retry';
        } else if (err?.status === 0) {
          this.errorMessage = 'Unable to load data — backend unreachable';
        } else if (err?.status === 403) {
          this.errorMessage = 'Access denied';
        } else {
          this.errorMessage = 'Unable to load inspection history';
        }
        this.cdr.markForCheck();
      }
    });
  }

  applyFilters() {
    this.currentPage = 1;
    this.fetchHistory();
  }

  resetFilters() {
    this.filterResult = 'all';
    this.filterDateFrom = '';
    this.filterDateTo = '';
    this.filterMinConfidence = null;
    this.searchTerm = '';
    this.currentPage = 1;
    this.fetchHistory();
  }

  goToPage(page: number) {
    if (page < 1 || page > this.totalPages) return;
    this.currentPage = page;
    this.fetchHistory();
  }

  get pageNumbers(): number[] {
    const pages: number[] = [];
    const start = Math.max(1, this.currentPage - 2);
    const end = Math.min(this.totalPages, this.currentPage + 2);
    for (let i = start; i <= end; i++) {
      pages.push(i);
    }
    return pages;
  }

  openDetail(inspection: any) {
    this.selectedInspection = inspection;
    this.drawerOpen = true;
  }

  closeDrawer() {
    this.drawerOpen = false;
    this.selectedInspection = null;
  }

  normaliseConfidence(raw: number | undefined): number {
    if (raw == null) return 0;
    return raw <= 1 ? Math.round(raw * 100) : Math.round(raw);
  }

  getShortId(id: string): string {
    if (!id) return '—';
    return id.slice(-6).toUpperCase();
  }

  logout() {
    this.authService.logout();
  }
}
