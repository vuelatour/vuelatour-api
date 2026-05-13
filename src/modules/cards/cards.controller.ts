import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
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
  CreateCardDto,
  LinkCardUserDto,
  ListCardsQuery,
  UpdateCardDto,
} from './dto/cards.dto';
import { CardsService } from './cards.service';

@ApiTags('Cards')
@ApiBearerAuth()
@Controller({ path: 'cards', version: '1' })
export class CardsController {
  constructor(private readonly cards: CardsService) {}

  @Get()
  @ApiOperation({ summary: 'List corporate cards' })
  list(@Query() q: ListCardsQuery) {
    return this.cards.list(q);
  }

  @Post()
  @Roles(Rol.ADMIN)
  @ApiOperation({ summary: 'Create card (ADMIN)' })
  create(@Body() dto: CreateCardDto, @CurrentUser() c: AuthenticatedUser) {
    return this.cards.create(dto, c.userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get card' })
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.cards.findById(id);
  }

  @Patch(':id')
  @Roles(Rol.ADMIN)
  @ApiOperation({ summary: 'Update card (ADMIN)' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCardDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.cards.update(id, dto, c.userId);
  }

  @Patch(':id/link-user')
  @Roles(Rol.ADMIN)
  @ApiOperation({ summary: 'Link/unlink card to a usuario (ADMIN)' })
  link(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LinkCardUserDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.cards.linkUser(id, dto.usuario_id ?? null, c.userId);
  }

  @Delete(':id')
  @Roles(Rol.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Soft delete (activa=false)' })
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() c: AuthenticatedUser) {
    return this.cards.softDelete(id, c.userId);
  }
}
