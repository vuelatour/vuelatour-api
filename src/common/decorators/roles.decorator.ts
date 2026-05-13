import { SetMetadata } from '@nestjs/common';
import { Rol } from '../types/auth.types';

export const ROLES_KEY = 'requiredRoles';

export const Roles = (...roles: Rol[]) => SetMetadata(ROLES_KEY, roles);
