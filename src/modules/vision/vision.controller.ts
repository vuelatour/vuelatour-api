import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
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

  @Get('health')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @ApiOperation({
    summary:
      'Diagnóstico de la visión IA: si está habilitada y si pyservices/Claude responden (para saber por qué "la foto no lee").',
  })
  health() {
    return this.vision.health();
  }

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
      images: dto.images,
      pdfBase64: dto.pdfBase64,
      excelBase64: dto.excelBase64,
      excelFilename: dto.excelFilename,
    });
    if (!result) return { disponible: false };
    // Falla con motivo (modelo mal escrito, timeout…): la app lo muestra.
    if (result.motivo && result.monto === undefined) {
      return { disponible: false, motivo: result.motivo };
    }
    return { disponible: true, ...result };
  }

  @Post('combustible-ticket')
  @Roles(Rol.PILOTO, Rol.MECANICO, Rol.ADMIN, Rol.COORDINADOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Extrae datos de un ticket de combustible (litros, precio/litro, total, aeropuerto) por IA. Best-effort.',
  })
  async combustibleTicket(@Body() dto: GastoTicketDto) {
    const result = await this.vision.readCombustibleTicket({
      imageBase64: dto.imageBase64,
      mediaType: dto.mediaType,
      imageUrl: dto.imageUrl,
    });
    if (!result) return { disponible: false };
    return { disponible: true, ...result };
  }
}
