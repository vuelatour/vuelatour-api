import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import { UpdateSelfDto } from '../users/dto/update-self.dto';
import { UsersService } from '../users/users.service';

@ApiTags('Me')
@ApiBearerAuth()
@Controller({ path: 'me', version: '1' })
export class MeController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiOperation({ summary: 'Current authenticated user profile' })
  me(@CurrentUser() current: AuthenticatedUser) {
    return this.users.findByAuthId(current.authId);
  }

  @Patch()
  @ApiOperation({ summary: 'Update non-privileged fields of the current user' })
  update(
    @Body() body: UpdateSelfDto,
    @CurrentUser() current: AuthenticatedUser,
  ) {
    return this.users.updateSelf(current.authId, body, current.userId);
  }
}
