import { ComponentFixture, TestBed } from '@angular/core/testing';

import { DeviceCardComponent} from './device-card.component';

describe('DeviceCard', () => {
  let component: DeviceCardComponent;
  let fixture: ComponentFixture<DeviceCardComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [DeviceCardComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(DeviceCardComponent);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
