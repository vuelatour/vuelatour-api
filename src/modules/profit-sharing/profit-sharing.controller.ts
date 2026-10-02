import {
  BadRequestException,
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
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Rol, type AuthenticatedUser } from '../../common/types/auth.types';
import {
  LIMITE_MULTER_FACTURA_BYTES,
  type ArchivoMultipart,
} from '../flights/factura-cliente.util';
import { ProfitSharingQuery } from './dto/profit-sharing.dto';
import {
  ActualizarPagoSocioDto,
  CrearPagoSocioDto,
  EliminarPagoSocioDto,
  PagosMesQuery,
  SinCamposComprobantePagoDto,
} from './dto/reparto-pago.dto';
import { DineroReportService } from './dinero-report.service';
import { ProfitSharingService } from './profit-sharing.service';
import { RepartoPagoService } from './reparto-pago.service';
import {
  ROLES_PAGOS_SOCIOS_ESCRITURA,
  ROLES_PAGOS_SOCIOS_LECTURA,
} from './reparto-pago.util';

@ApiTags('Profit Sharing')
@ApiBearerAuth()
@Controller({ path: 'profit-sharing', version: '1' })
export class ProfitSharingController {
  constructor(
    private readonly profitSharing: ProfitSharingService,
    private readonly dinero: DineroReportService,
    private readonly pagosSocios: RepartoPagoService,
  ) {}

  @Get()
  // SOCIO: su rol declara "Lectura + PDFs de reparto" y el menú del panel le
  // ofrece esta página — sin él aquí, el destinatario del reparto veía 403.
  @Roles(Rol.ADMIN, Rol.ANALISTA, Rol.SOCIO)
  @ApiOperation({
    summary: 'Compute the profit-sharing breakdown per aircraft for a period',
  })
  compute(@Query() q: ProfitSharingQuery) {
    return this.profitSharing.compute(q);
  }

  @Get('pre-cierre')
  @Roles(Rol.ADMIN, Rol.ANALISTA, Rol.FACTURACION, Rol.COORDINADOR)
  @ApiOperation({
    summary:
      'Checklist de pre-cierre: vuelos sin completar, tacos en revisión, cobros con saldo, gastos sin TC/avión/comprobante y pendientes de conciliar.',
  })
  preCierre(
    @Query() q: ProfitSharingQuery,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    // El rol decide si salen los items de pagos a socios (nombres y montos
    // por socio): COORDINADOR no los lee en ningún otro endpoint.
    return this.profitSharing.preCierre(q, c.rol);
  }

  // ============ Pagos de utilidades a socios (1-oct-2026) ============
  // Reglas puras en reparto-pago.util.ts. Rutas LITERALES bajo `pagos/`
  // (convención: antes de cualquier `:id` del controller); `@Roles`
  // explícito en CADA una.

  @Get('pagos')
  @Roles(...ROLES_PAGOS_SOCIOS_LECTURA)
  @ApiOperation({
    summary:
      'Relación de pagos a socios de un MES (AAAA-MM): por avión × socio, la utilidad calculada HOY con el reparto del mes, lo pagado (pagos vivos), lo pendiente, el exceso, el estado (PENDIENTE | PARCIAL | PAGADO | SIN_UTILIDAD) y los pagos; consolidado por socio y totales. SOCIO: solo sus renglones. Sin la migración: disponible:false con listas vacías.',
  })
  listarPagosSocios(
    @Query() q: PagosMesQuery,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.pagosSocios.listar(q.mes, q.aeronave_id, c);
  }

  @Post('pagos')
  @Roles(...ROLES_PAGOS_SOCIOS_ESCRITURA)
  @ApiOperation({
    summary:
      'Registra un pago de utilidad a un socio (mes completo). 201 {pago, fila}; replay de client_request_id ⇒ 200 idempotente:true. 400 SOCIO_NO_ES_DE_LA_AERONAVE / TC_REQUERIDO / TC_NO_APLICA / FECHA_PAGO_FUTURA / ENTREGADO_POR_INVALIDO; 409 PAGO_EXCEDE_UTILIDAD (confirmar con aceptar_exceso) y SIN_UTILIDAD_QUE_PAGAR; 503 PAGOS_SOCIOS_NO_DISPONIBLE.',
  })
  async crearPagoSocio(
    @Body() dto: CrearPagoSocioDto,
    @CurrentUser() c: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.pagosSocios.crear(dto, c);
    if (r.idempotente === true) res.status(HttpStatus.OK);
    return r;
  }

  @Patch('pagos/:id')
  @Roles(...ROLES_PAGOS_SOCIOS_ESCRITURA)
  @ApiOperation({
    summary:
      'Corrige un pago (no cambia avión, socio ni mes). Re-valida el dinero sobre el estado fusionado; si el monto en USD sube, vuelve a revisar SIN_UTILIDAD y el exceso. {pago, fila}. 404 PAGO_NO_EXISTE, 409 PAGO_CAMBIO_CONCURRENTE.',
  })
  actualizarPagoSocio(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ActualizarPagoSocioDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.pagosSocios.actualizar(id, dto, c);
  }

  @Delete('pagos/:id')
  @Roles(...ROLES_PAGOS_SOCIOS_ESCRITURA)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Elimina un pago (soft delete con motivo de 5–300 caracteres; la confirmación la pide la UI). {deleted: true, fila}. 404 PAGO_NO_EXISTE (también si ya estaba eliminado).',
  })
  eliminarPagoSocio(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EliminarPagoSocioDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.pagosSocios.eliminar(id, dto.motivo, c);
  }

  @Post('pagos/:id/comprobante')
  @Roles(...ROLES_PAGOS_SOCIOS_ESCRITURA)
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    // 1 MB de margen sobre los 10 MB de negocio: el servicio dice el peso
    // EXACTO (413 ARCHIVO_MUY_GRANDE).
    FileInterceptor('file', {
      limits: { fileSize: LIMITE_MULTER_FACTURA_BYTES },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary:
      'Adjunta (o reemplaza) el comprobante del pago: foto (JPG, PNG, WEBP, HEIC) o PDF, ≤ 10 MB, campo `file`. El anterior se CONSERVA en el bucket privado reparto-comprobantes. {pago} con comprobante_url (8 h).',
  })
  subirComprobantePagoSocio(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: ArchivoMultipart | undefined,
    @Body() _dto: SinCamposComprobantePagoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    void _dto;
    if (!file?.buffer || file.buffer.length === 0) {
      throw new BadRequestException({
        message:
          'No llegó ningún archivo: manda la foto o el PDF del comprobante en el campo «file».',
        error: 'SIN_ARCHIVO',
      });
    }
    return this.pagosSocios.subirComprobante(
      id,
      {
        buffer: file.buffer,
        nombre: file.originalname ?? null,
        mime: file.mimetype ?? null,
      },
      c,
    );
  }

  @Get('pdf')
  @Roles(Rol.ADMIN, Rol.ANALISTA, Rol.SOCIO)
  @ApiOperation({
    summary: 'Profit-sharing report PDF (rendered by vuelatour-pyservices)',
  })
  async pdf(@Query() q: ProfitSharingQuery): Promise<StreamableFile> {
    const { buffer, desde, hasta } = await this.profitSharing.repartoPdf(q);
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: `inline; filename="reparto-${desde}-a-${hasta}.pdf"`,
    });
  }

  @Get('dinero.xlsx')
  @Roles(Rol.ADMIN, Rol.ANALISTA)
  @ApiOperation({
    summary:
      'Libro «Dinero» del periodo: réplica del control manual del equipo (dinero-vlos + otros ingresos + otros gastos + utilidades). Filas coloreadas por avión, clave vt+cliente con la matrícula como nota. Costo proveedor/comisiones/pagos van vacíos hasta definir sus reglas.',
  })
  async dineroXlsx(@Query() q: ProfitSharingQuery): Promise<StreamableFile> {
    const { buffer, desde, hasta } = await this.dinero.xlsx(q.desde, q.hasta);
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="dinero-${desde}-a-${hasta}.xlsx"`,
    });
  }

  @Get('xlsx')
  @Roles(Rol.ADMIN, Rol.ANALISTA)
  @ApiOperation({
    summary:
      'Reporte mensual por avión en Excel (rendered by vuelatour-pyservices)',
  })
  async xlsx(@Query() q: ProfitSharingQuery): Promise<StreamableFile> {
    const { buffer, desde, hasta } = await this.profitSharing.repartoXlsx(q);
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="reporte-mensual-${desde}-a-${hasta}.xlsx"`,
    });
  }
}
