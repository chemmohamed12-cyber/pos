import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Department } from '../infrastructure/department.entity';
import { Employee } from '../infrastructure/employee.entity';
import { EmployeeStatus, canTransitionEmployeeStatus } from '../domain/employee-status';
import { LimitService } from '../../../foundation/limit-engine/limit.service';
import { EventBusService } from '../../../foundation/events/event-bus.service';

export interface CreateDepartmentInput {
  code: string;
  name: string;
}

export interface CreateEmployeeInput {
  code: string;
  fullName: string;
  departmentId?: string | null;
  position?: string | null;
  hireDate?: string | null;
}

/**
 * ERP Foundation — P9 (ADR-029). `hr`'s only application service.
 * Imports NOTHING from any other domain (`hr.depends_on: []`) — the
 * `hr.max_employees` limit-gate + `employee.created` event-publish below
 * follow the exact same established pattern as every other domain
 * (`CustomersService.createCustomer`), proving no new Core mechanism was
 * needed for a brand-new module.
 */
@Injectable()
export class HrService {
  constructor(
    @InjectRepository(Department) private readonly departments: Repository<Department>,
    @InjectRepository(Employee) private readonly employees: Repository<Employee>,
    private readonly dataSource: DataSource,
    private readonly limits: LimitService,
    private readonly events: EventBusService,
  ) {}

  async createDepartment(input: CreateDepartmentInput): Promise<Department> {
    return this.departments.save(this.departments.create({ code: input.code, name: input.name }));
  }

  async listDepartments(): Promise<Department[]> {
    return this.departments.find({ order: { name: 'ASC' } });
  }

  async createEmployee(input: CreateEmployeeInput): Promise<Employee> {
    const gate = await this.limits.check('hr.max_employees');
    if (!gate.allowed) {
      throw new ConflictException(`Employee limit reached (${gate.max}) — cannot create another employee.`);
    }

    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(Employee);
      const saved = await repo.save(
        repo.create({
          code: input.code,
          fullName: input.fullName,
          departmentId: input.departmentId ?? null,
          position: input.position ?? null,
          hireDate: input.hireDate ?? null,
          status: 'active',
        }),
      );

      const consumed = await this.limits.consume('hr.max_employees', 1, manager);
      if (!consumed.allowed) {
        throw new ConflictException(`Employee limit reached (${consumed.max}) — cannot create another employee.`);
      }

      await this.events.publish(manager, 'employee.created', { employeeId: saved.id, code: saved.code });
      return saved;
    });
  }

  async listEmployees(): Promise<Employee[]> {
    return this.employees.find({ order: { fullName: 'ASC' } });
  }

  async getEmployee(id: string): Promise<Employee> {
    const employee = await this.employees.findOne({ where: { id } });
    if (!employee) throw new NotFoundException('Employee not found');
    return employee;
  }

  async setStatus(id: string, status: EmployeeStatus): Promise<Employee> {
    const employee = await this.getEmployee(id);
    if (!canTransitionEmployeeStatus(employee.status, status)) {
      throw new ConflictException(`Cannot transition employee status from "${employee.status}" to "${status}".`);
    }
    employee.status = status;
    return this.employees.save(employee);
  }
}
