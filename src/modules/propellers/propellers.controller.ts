import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Rol } from '../../common/types/auth.types';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import {
  CreatePropellerDto,
  ListPropellersQuery,
  UpdatePropellerDto,
} from './dto/propellers.dto';
import { PropellersService } from './propellers.service';

@ApiTags('Propellers')
@ApiBearerAuth()
@Controller({ path: 'propellers', version: '1' })
export class PropellersController {
  constructor(private readonly propellers: PropellersService) {}

  @Get()
  @ApiOperation({ summary: 'List propellers' })
  list(@Query() q: ListPropellersQuery) {
    return this.propellers.list(q);
  }

  @Post()
  @Roles(Rol.ADMIN)
  @ApiOperation({ summary: 'Create propeller (ADMIN)' })
  create(@Body() dto: CreatePropellerDto, @CurrentUser() c: AuthenticatedUser) {
    return this.propellers.create(dto, c.userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get propeller' })
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.propellers.findById(id);
  }

  @Patch(':id')
  @Roles(Rol.ADMIN)
  @ApiOperation({ summary: 'Update propeller (ADMIN)' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePropellerDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.propellers.update(id, dto, c.userId);
  }
}
