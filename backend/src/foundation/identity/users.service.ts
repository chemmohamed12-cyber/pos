import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { User, UserStatus } from './user.entity';

export interface CreateUserInput {
  fullName: string;
  email: string;
  mobile?: string;
}

/**
 * Identity — main success/failure paths only (CTO Execution Policy §5):
 * create, find by id, find by email, and the one invariant that matters
 * here (email uniqueness). Role/scope/permission checks are Milestones
 * 6-8's job, not Identity's.
 */
@Injectable()
export class UsersService {
  constructor(@InjectRepository(User) private readonly users: Repository<User>) {}

  async create(input: CreateUserInput): Promise<User> {
    const existing = await this.users.findOne({ where: { email: input.email } });
    if (existing) {
      throw new ConflictException(`A user with email "${input.email}" already exists.`);
    }
    const user = this.users.create({
      fullName: input.fullName,
      email: input.email,
      mobile: input.mobile ?? null,
      status: 'pending',
    });
    return this.users.save(user);
  }

  async findById(id: string): Promise<User> {
    const user = await this.users.findOne({ where: { id } });
    if (!user) {
      throw new NotFoundException(`User "${id}" not found.`);
    }
    return user;
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.users.findOne({ where: { email } });
  }

  /** F2 — invitation e-mails are normalised to lower case; identities may have been stored with any casing. */
  async findByEmailInsensitive(email: string): Promise<User | null> {
    const rows = await this.users.createQueryBuilder('u').where('LOWER(u."email") = LOWER(:email)', { email }).getMany();
    return rows.length === 1 ? rows[0] : null;
  }

  /**
   * Case-insensitive exact-name lookup — CRM Customer import (Gap G-5)
   * resolves a Sales Rep by name because that is the only identifier the
   * real source spreadsheet carries (no email column). Returns null for
   * BOTH "not found" and "ambiguous" (more than one user shares the
   * name) — a caller must never guess between two people; the row's own
   * error message distinguishes the two cases for the operator.
   */
  async findByFullName(fullName: string): Promise<User | null> {
    const matches = await this.users
      .createQueryBuilder('u')
      .where('LOWER(u."fullName") = LOWER(:fullName)', { fullName })
      .getMany();
    return matches.length === 1 ? matches[0] : null;
  }

  async setStatus(id: string, status: UserStatus): Promise<User> {
    const user = await this.findById(id);
    user.status = status;
    return this.users.save(user);
  }

  /** Admin-driven profile edit (name/email) from the Admin/role-assignment screen. Same email-uniqueness invariant as `create`, checked only when the email is actually changing so saving a user's own unchanged email never false-positives against itself. */
  async updateProfile(id: string, input: { fullName: string; email: string }): Promise<User> {
    const user = await this.findById(id);
    if (input.email !== user.email) {
      const existing = await this.users.findOne({ where: { email: input.email } });
      if (existing) {
        throw new ConflictException(`A user with email "${input.email}" already exists.`);
      }
    }
    user.fullName = input.fullName;
    user.email = input.email;
    return this.users.save(user);
  }

  async count(): Promise<number> {
    return this.users.count();
  }

  async listAll(): Promise<User[]> {
    return this.users.find();
  }

  /** Bulk lookup by id — e.g. resolving a set of role-holder ids (`AuthorizationService.getUserIdsForRole`) to their display records in one query instead of N. */
  async findByIds(ids: string[]): Promise<User[]> {
    if (ids.length === 0) return [];
    return this.users.findBy({ id: In(ids) });
  }
}
