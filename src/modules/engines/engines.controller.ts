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
  CreateEngineDto,
  ListEnginesQuery,
  TransplantEngineDto,
  UpdateEngineDto,
} from './dto/engines.dto';
import { EnginesService } from './engines.service';

@ApiTags('Engines')
@ApiBearerAuth()
@Controller({ path: 'engines', version: '1' })
export class EnginesController {
  constructor(private readonly engines: EnginesService) {}

  @Get()
  @ApiOperation({ summary: 'List engines (filter by aeronave_id, tipo, posicion)' })
  list(@Query() q: ListEnginesQuery) {
    return this.engines.list(q);
  }

  @Post()
  @Roles(Rol.ADMIN)
  @ApiOperation({ summary: 'Create engine (ADMIN)' })
  create(@Body() dto: CreateEngineDto, @CurrentUser() c: AuthenticatedUser) {
    return this.engines.create(dto, c.userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get engine' })
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.engines.findById(id);
  }

  @Patch(':id')
  @Roles(Rol.ADMIN)
  @ApiOperation({ summary: 'Update engine (ADMIN)' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEngineDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.engines.update(id, dto, c.userId);
  }

  @Post(':id/transplant')
  @Roles(Rol.ADMIN)
  @ApiOperation({
    summary: 'Move engine to another aircraft (ADMIN). Audit row is created.',
  })
  transplant(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransplantEngineDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.engines.transplant(id, dto, c.userId);
  }

  @Get(':id/transplants')
  @ApiOperation({ summary: 'Transplant history for this engine' })
  history(@Param('id', ParseUUIDPipe) id: string) {
    return this.engines.listTransplants(id);
  }
}
