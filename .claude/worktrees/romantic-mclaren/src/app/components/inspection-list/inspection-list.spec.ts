import { ComponentFixture, TestBed } from '@angular/core/testing';

import { InspectionListComponent} from './inspection-list.component';

describe('InspectionList', () => {
  let component: InspectionListComponent;
  let fixture: ComponentFixture<InspectionListComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [InspectionListComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(InspectionListComponent);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
