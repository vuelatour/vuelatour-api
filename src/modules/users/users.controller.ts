import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/auth.types';

@ApiTags('Users')
@ApiBearerAuth()
@Controller({ path: 'me', version: '1' })
export class UsersController {
  @Get()
  @ApiOperation({ summary: 'Current authenticated user profile' })
  me(@CurrentUser() user: AuthenticatedUser) {
    return {
      id: user.userId,
      authId: user.authId,
      email: user.email,
      nombre: user.nombre,
      rol: user.rol,
      estado: user.estado,
    };
  }
}
