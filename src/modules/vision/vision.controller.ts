import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { Rol } from '../../common/types/auth.types';
import { GastoTicketDto } from './dto/vision.dto';
import { VisionService } from './vision.service';

@ApiTags('Vision')
@ApiBearerAuth()
@Controller({ path: 'vision', version: '1' })
export class VisionController {
  constructor(private readonly vision: VisionService) {}

  @Post('gasto-ticket')
  @Roles(Rol.PILOTO, Rol.MECANICO, Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Extrae datos de un ticket de gasto por IA para pre-llenar la captura. Best-effort: si la IA no está disponible regresa disponible=false.',
  })
  async gastoTicket(@Body() dto: GastoTicketDto) {
    const result = await this.vision.readGastoTicket({
      imageBase64: dto.imageBase64,
      mediaType: dto.mediaType,
      imageUrl: dto.imageUrl,
    });
    if (!result) return { disponible: false };
    return { disponible: true, ...result };
  }
}
