import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import { FirmarStorageDto } from './dto/firmar-storage.dto';
import { ROLES_FIRMA } from './storage-firma.util';
import { StorageService } from './storage.service';

@ApiTags('Storage')
@ApiBearerAuth()
@Controller({ path: 'storage', version: '1' })
export class StorageController {
  constructor(private readonly storage: StorageService) {}

  @Post('firmar')
  @Roles(...ROLES_FIRMA)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Vuelve a firmar (8 h) archivos de un bucket privado de la lista blanca — refresco de miniaturas del panel cuando la URL venció. Máximo 100 paths. Roles POR BUCKET, nunca más que el endpoint específico del bucket (PILOTO/MECANICO solo gasto-fotos y taco-fotos; estados-cuenta solo ADMIN/FACTURACION…); fuera ⇒ 403 BUCKET_FUERA_DE_ROL. Responde {urls: {path: url}, expira_en_s}; un path inexistente no aparece.',
  })
  firmar(@Body() dto: FirmarStorageDto, @CurrentUser() c: AuthenticatedUser) {
    return this.storage.firmar(c.rol, dto.bucket, dto.paths);
  }
}
