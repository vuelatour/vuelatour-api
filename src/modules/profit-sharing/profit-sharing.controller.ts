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
  Put,
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
  ConfigurarCuentaSocioDto,
  EstadoCuentaQuery,
} from './dto/reparto-cuenta.dto';
import {
  ActualizarPagoSocioDto,
  CrearPagoSocioDto,
  EliminarPagoSocioDto,
  PagosQuery,
  SinCamposComprobantePagoDto,
} from './dto/reparto-pago.dto';
import { DineroReportService } from './dinero-report.service';
import { ProfitSharingService } from './profit-sharing.service';
import { RepartoCuentaService } from './reparto-cuenta.service';
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
    private readonly cuentasSocios: RepartoCuentaService,
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
    // El rol decide si salen los items de las cuentas de los socios
    // (nombres y montos por socio): COORDINADOR no los lee en ningún otro
    // endpoint.
    return this.profitSharing.preCierre(q, c.rol);
  }

  // ===== Cuenta corriente del socio (v2, 2-oct-2026, invariante 38) =====
  // Reglas puras en reparto-cuenta.util.ts / reparto-pago.util.ts. Rutas
  // LITERALES bajo `socios/` y `pagos/` (convención: antes de cualquier
  // `:id` del controller); `@Roles` explícito en CADA una.

  @Get('socios')
  @Roles(...ROLES_PAGOS_SOCIOS_LECTURA)
  @ApiOperation({
    summary:
      'Cuentas corrientes de los socios: por socio, lo generado (compute mes a mes desde el arranque hasta el mes en curso), lo del mes en curso, lo entregado, lo POR ENTREGAR y el estado (AL_CORRIENTE | POR_ENTREGAR | ADELANTADO), último pago y aviones. SOCIO: solo la suya y sin totales. Sin la migración: disponible:false.',
  })
  resumenCuentasSocios(@CurrentUser() c: AuthenticatedUser) {
    return this.cuentasSocios.resumen(c);
  }

  @Get('socios/:socioId/estado-cuenta')
  @Roles(...ROLES_PAGOS_SOCIOS_LECTURA)
  @ApiOperation({
    summary:
      'Estado de cuenta del socio con saldo corrido: saldo inicial / saldo anterior, utilidades por mes y avión (el mes en curso marcado) y entregas (método, quién, comprobante), por mes y totales. ?desde=AAAA-MM&hasta=AAAA-MM (default: arranque … mes en curso). SOCIO: solo la suya (403 SOCIO_SOLO_SU_CUENTA). 404 SOCIO_NO_EXISTE.',
  })
  estadoCuentaSocio(
    @Param('socioId', ParseUUIDPipe) socioId: string,
    @Query() q: EstadoCuentaQuery,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.cuentasSocios.estadoDeCuenta(socioId, q, c);
  }

  @Put('socios/:socioId/cuenta')
  @Roles(...ROLES_PAGOS_SOCIOS_ESCRITURA)
  @ApiOperation({
    summary:
      'Configura la cuenta del socio: mes de arranque (AAAA-MM, no futuro, ≤ 36 meses atrás), saldo inicial en USD (negativo = ya se le había adelantado) y notas. Responde su renglón del resumen. 400 SOCIO_INVALIDO / CUENTA_DESDE_FUTURA / CUENTA_DESDE_FUERA_DE_RANGO / SALDO_INICIAL_INVALIDO; 503 CUENTA_SOCIO_NO_DISPONIBLE.',
  })
  configurarCuentaSocio(
    @Param('socioId', ParseUUIDPipe) socioId: string,
    @Body() dto: ConfigurarCuentaSocioDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.cuentasSocios.configurarCuenta(socioId, dto, c);
  }

  @Get('pagos')
  @Roles(...ROLES_PAGOS_SOCIOS_LECTURA)
  @ApiOperation({
    summary:
      'Entregas a socios (vivas) por fecha de entrega: ?desde=AAAA-MM-DD&hasta=AAAA-MM-DD[&socio_id]. Más reciente primero, con nombres, avión y comprobante firmado (8 h). SOCIO: solo las suyas. ?mes= (v1) ⇒ 410 PAGOS_POR_MES_RETIRADO. Sin la migración: disponible:false.',
  })
  listarPagosSocios(
    @Query() q: PagosQuery,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.pagosSocios.listar(q, c);
  }

  @Post('pagos')
  @Roles(...ROLES_PAGOS_SOCIOS_ESCRITURA)
  @ApiOperation({
    summary:
      'Registra una ENTREGA a la cuenta del socio («corresponde a» mes/avión opcional; sin mes = adelanto a cuenta). 201 {pago, cuenta}; replay de client_request_id ⇒ 200 idempotente:true. 400 SOCIO_INVALIDO / SOCIO_NO_ES_DE_LA_AERONAVE / TC_REQUERIDO / TC_NO_APLICA / TC_FUERA_DE_RANGO / FECHA_PAGO_FUTURA / MES_FUTURO / ENTREGADO_POR_INVALIDO; 409 PAGO_EXCEDE_SALDO si rebasa lo por entregar de MESES CERRADOS (el mes en curso no cuenta; details.mes_en_curso_usd) — adelanto: confirmar con aceptar_exceso y la MISMA llave; 503 CUENTA_SOCIO_NO_DISPONIBLE.',
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
      'Corrige una entrega (no cambia el socio; «corresponde a» avión/mes sí). Re-valida el dinero sobre el estado fusionado; si el monto en USD sube, vuelve a revisar el saldo de meses cerrados (409 PAGO_EXCEDE_SALDO salvo aceptar_exceso). {pago, cuenta}. 404 PAGO_NO_EXISTE, 409 PAGO_CAMBIO_CONCURRENTE.',
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
      'Elimina una entrega (soft delete con motivo de 5–300 caracteres; la confirmación la pide la UI). {deleted: true, cuenta}. 404 PAGO_NO_EXISTE (también si ya estaba eliminada).',
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
      'Adjunta (o reemplaza) el comprobante de la entrega: foto (JPG, PNG, WEBP, HEIC) o PDF, ≤ 10 MB, campo `file`. El anterior se CONSERVA en el bucket privado reparto-comprobantes. {pago} con comprobante_url (8 h).',
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
