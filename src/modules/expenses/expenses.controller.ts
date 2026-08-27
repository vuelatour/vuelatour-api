import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  StreamableFile,
  Put,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Rol } from '../../common/types/auth.types';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import {
  CategoriaGasto,
  CreateGastoDto,
  CreateTarifaAerodromoDto,
  GenerarPistasDto,
  ListGastosQuery,
  PhotoUrlsDto,
  PistasPendientesQuery,
  SugerirVueloQuery,
  UpdateGastoDto,
  UpdateTarifaAerodromoDto,
  ListOtrosGastosQuery,
  PutRepartoDto,
} from './dto/expenses.dto';
import {
  CargaMasivaCombustibleDto,
  PreviewCargaCombustibleDto,
} from './dto/combustible-masivo.dto';
import { CombustibleMasivoService } from './combustible-masivo.service';
import { ExpensesService } from './expenses.service';

@ApiTags('Expenses')
@ApiBearerAuth()
@Controller({ path: 'expenses', version: '1' })
export class ExpensesController {
  constructor(
    private readonly expenses: ExpensesService,
    private readonly combustibleMasivo: CombustibleMasivoService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List gastos (with filters). Pilotos see only own captures.',
  })
  list(@Query() q: ListGastosQuery, @CurrentUser() c: AuthenticatedUser) {
    const filters = { ...q };
    // Pilotos y mecánicos solo ven sus propias capturas: se fuerza SIEMPRE su
    // propio id (con ?usuario_captura_id=<otro> listaban gastos ajenos). El
    // mecánico, además, solo combustible (GAS) — no ve el resto de gastos.
    if (
      c.rol === Rol.PILOTO ||
      c.rol === Rol.MECANICO ||
      c.rol === Rol.VISITANTE
    ) {
      filters.usuario_captura_id = c.userId;
    }
    if (c.rol === Rol.MECANICO) {
      filters.categoria = CategoriaGasto.GAS;
    }
    return this.expenses.list(filters);
  }

  @Get('sugerir-vuelo')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION, Rol.PILOTO, Rol.MECANICO)
  @ApiOperation({
    summary:
      'Sugiere el vuelo al que corresponde una carga de combustible (aeronave + momento de la carga). En ruta → ese vuelo; si no → siguiente salida.',
  })
  sugerirVuelo(@Query() q: SugerirVueloQuery) {
    return this.expenses.sugerirVuelo(q.aeronave_id, q.fecha_hora);
  }

  @Post('sugerir-asignaciones')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION, Rol.ANALISTA)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Barrido de la bandeja: sugiere vuelo/avión para TODOS los gastos pendientes (máx 15). Devuelve gasto→sugerencia; la oficina aplica en lote.',
  })
  sugerirAsignaciones() {
    return this.expenses.sugerirAsignaciones();
  }

  @Get(':id/sugerir-asignacion')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION, Rol.ANALISTA)
  @ApiOperation({
    summary:
      'Sugiere a qué vuelo/avión pertenece un gasto de la bandeja: vuelos del capturista a ±3 días (regla si hay uno el mismo día; IA si hay varios). Sin candidatos → sin match (asignación manual).',
  })
  sugerirAsignacion(@Param('id', ParseUUIDPipe) id: string) {
    return this.expenses.sugerirAsignacion(id);
  }

  @Get('export')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION, Rol.ANALISTA)
  @ApiOperation({
    summary: 'Gastos por avión/categoría en Excel (respeta filtros)',
  })
  async export(@Query() q: ListGastosQuery): Promise<StreamableFile> {
    const buffer = await this.expenses.listXlsx(q);
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: 'attachment; filename="gastos.xlsx"',
    });
  }

  @Post()
  @Roles(
    Rol.ADMIN,
    Rol.COORDINADOR,
    Rol.FACTURACION,
    Rol.PILOTO,
    Rol.MECANICO,
    Rol.VISITANTE,
  )
  @ApiOperation({
    summary:
      'Capture a gasto. Pilotos/mecánicos lo usan desde la app móvil. El mecánico solo carga combustible.',
  })
  create(@Body() dto: CreateGastoDto, @CurrentUser() c: AuthenticatedUser) {
    // El semáforo de facturación es seguimiento de OFICINA: piloto/mecánico
    // no pueden fijarlo (si pudieran, un gasto se afirmaría "facturado" sin
    // que oficina viera factura alguna — candado multicapa).
    if (
      c.rol === Rol.PILOTO ||
      c.rol === Rol.MECANICO ||
      c.rol === Rol.VISITANTE
    ) {
      delete dto.estatus_facturacion;
      this.assertFotoPropia(dto.foto_url, c.authId);
    }
    return this.expenses.create(dto, c.userId, c.rol);
  }

  /**
   * La foto del gasto de un piloto/mecánico debe ser una SUBIDA PROPIA: la
   * app sube a gasto-fotos con path `<AUTH uid>/<yyyy-MM>/<uuid>.ext`. Sin
   * este candado, un PATCH podía apuntar el gasto a la foto de OTRO usuario
   * (la política de lectura del bucket no filtra por dueño) o a un string
   * basura que el panel intentaría firmar sin éxito.
   *
   * OJO (bug 18-ago): el prefijo del path es el `supabase_auth_id`
   * (c.authId, el sub del JWT con el que la app sube al Storage) — NUNCA
   * `usuario.id` (c.userId): son ids distintos y comparar contra userId
   * bloqueó TODAS las capturas con foto de pilotos.
   */
  private assertFotoPropia(fotoUrl: string | undefined, authId: string) {
    if (fotoUrl && !fotoUrl.startsWith(`${authId}/`)) {
      throw new BadRequestException(
        'La foto del comprobante debe ser una subida tuya.',
      );
    }
  }

  @Post('photo-urls')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Firma URLs de fotos de recibos (bucket privado) para el panel admin.',
  })
  photoUrls(@Body() dto: PhotoUrlsDto) {
    return this.expenses.signPhotos(dto.paths);
  }

  // ===== Gastos de pista (cuotas de aeródromo) — rutas literales antes de :id =====

  @Get('otros-gastos')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION, Rol.ANALISTA)
  @ApiOperation({
    summary:
      'Gastos GENERALES del periodo (sin vuelo: OTRO/FIJO/INDIRECTO/GASOLINA/VISITA) con su reparto entre aviones y el resumen del mes (asignado vs gasto de la empresa VuelaTour).',
  })
  otrosGastos(@Query() q: ListOtrosGastosQuery) {
    return this.expenses.listOtrosGastos(q.desde, q.hasta);
  }

  @Get('pistas/pendientes')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION, Rol.ANALISTA)
  @ApiOperation({
    summary:
      'Aterrizajes del periodo (destino ≠ CUN) sin gasto de pista, con monto sugerido del tarifario. La oficina revisa y confirma.',
  })
  pistasPendientes(@Query() q: PistasPendientesQuery) {
    return this.expenses.pistasPendientes(q.desde, q.hasta);
  }

  @Post('pistas/generar')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Crea los gastos de pista confirmados (origen SISTEMA, un gasto por aterrizaje, SIN_COMPROBANTE hasta amarrar la factura).',
  })
  generarPistas(
    @Body() dto: GenerarPistasDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.expenses.generarPistas(dto, c.userId);
  }

  @Get('tarifas-aerodromo')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION, Rol.ANALISTA)
  @ApiOperation({
    summary: 'Tarifario de cuotas de aterrizaje por aeródromo/modelo.',
  })
  listTarifas() {
    return this.expenses.listTarifasAerodromo();
  }

  @Post('tarifas-aerodromo')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION)
  @ApiOperation({ summary: 'Agrega una tarifa de aeródromo.' })
  createTarifa(
    @Body() dto: CreateTarifaAerodromoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.expenses.createTarifaAerodromo(dto, c.userId);
  }

  @Patch('tarifas-aerodromo/:id')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION)
  @ApiOperation({ summary: 'Actualiza una tarifa de aeródromo.' })
  updateTarifa(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTarifaAerodromoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.expenses.updateTarifaAerodromo(id, dto, c.userId);
  }

  @Delete('tarifas-aerodromo/:id')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Elimina una tarifa de aeródromo.' })
  removeTarifa(@Param('id', ParseUUIDPipe) id: string) {
    return this.expenses.removeTarifaAerodromo(id);
  }

  // ===== Carga masiva de combustibles (Excel) — rutas literales antes de :id =====
  // Roles = los de oficina que capturan gastos (el @Roles del create SIN
  // piloto/mecánico: ellos cargan desde la app, no por Excel).

  @Get('combustibles/plantilla.xlsx')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION)
  @ApiOperation({
    summary:
      'Plantilla Excel para la carga masiva de combustibles, con los catálogos reales (matrículas, proveedores, medios de pago) como listas.',
  })
  async plantillaCombustibles(): Promise<StreamableFile> {
    const buffer = await this.combustibleMasivo.plantillaXlsx();
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: 'attachment; filename="plantilla-combustibles.xlsx"',
    });
  }

  @Post('combustibles/carga-masiva/preview')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Valida el Excel llenado SIN crear nada: errores y advertencias por fila + datos normalizados (aeronave, vuelo, proveedor resueltos).',
  })
  previewCargaCombustibles(@Body() dto: PreviewCargaCombustibleDto) {
    return this.combustibleMasivo.preview(dto);
  }

  @Post('combustibles/carga-masiva')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Crea los gastos GAS de las filas validadas. Re-valida TODO en servidor; procesa todas las filas y reporta creados vs errores por fila.',
  })
  cargaMasivaCombustibles(
    @Body() dto: CargaMasivaCombustibleDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.combustibleMasivo.cargaMasiva(dto, c.userId, c.rol);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get gasto by id. Piloto/mecánico solo ven sus propias capturas.',
  })
  async getOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    const gasto = await this.expenses.findById(id);
    if (
      (c.rol === Rol.PILOTO ||
        c.rol === Rol.MECANICO ||
        c.rol === Rol.VISITANTE) &&
      (gasto as { usuario_captura_id: string | null }).usuario_captura_id !==
        c.userId
    ) {
      throw new ForbiddenException('No tienes acceso a este gasto');
    }
    return gasto;
  }

  @Post(':id/reanalizar-ia')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Reanaliza el comprobante guardado con la IA de visión. SOLO-LECTURA: devuelve la lectura para prellenar el formulario; valor_ia_extraido se guarda junto con el PATCH cuando el humano confirma.',
  })
  async reanalizarIA(@Param('id', ParseUUIDPipe) id: string) {
    return this.expenses.reanalizarConIA(id);
  }

  @Get(':id/reparto')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION, Rol.ANALISTA)
  @ApiOperation({
    summary: 'Reparto del gasto entre aviones (items + remanente de empresa).',
  })
  getReparto(@Param('id', ParseUUIDPipe) id: string) {
    return this.expenses.getReparto(id);
  }

  @Put(':id/reparto')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION)
  @ApiOperation({
    summary:
      'Reemplaza el reparto del gasto entre aviones ([] lo limpia). Solo gastos generales sin vuelo; Σ <= monto; el remanente es gasto de la empresa VuelaTour.',
  })
  putReparto(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PutRepartoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.expenses.putReparto(id, dto.items, c.userId);
  }

  @Post(':id/visto-bueno')
  @Roles(Rol.ADMIN, Rol.FACTURACION, Rol.ANALISTA)
  @ApiOperation({
    summary:
      'Da el visto bueno de administración a un gasto prellenado con IA desde la app (marca quién y cuándo; quita la bandera de pendiente).',
  })
  async vistoBueno(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.expenses.darVistoBueno(id, c.userId);
  }

  @Patch(':id')
  @Roles(
    Rol.ADMIN,
    Rol.COORDINADOR,
    Rol.FACTURACION,
    Rol.PILOTO,
    Rol.MECANICO,
    Rol.VISITANTE,
  )
  @ApiOperation({
    summary:
      'Update gasto. Oficina siempre; piloto/mecánico solo su propio gasto y solo el mismo día (doc 5.2/5.3).',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateGastoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    if (
      c.rol === Rol.PILOTO ||
      c.rol === Rol.MECANICO ||
      c.rol === Rol.VISITANTE
    ) {
      await this.expenses.assertOwnSameDay(id, c.userId);
      // Seguimiento de OFICINA: el capturador de campo no marca facturado.
      delete dto.estatus_facturacion;
      // Ni concilia ni desmarca duplicados (27-ago): un gasto "conciliado"
      // sin movimiento bancario sobreestima la conciliación en silencio.
      delete dto.conciliado;
      delete dto.duplicado_sospechado;
      // Reemplazo de foto (pedido 17-ago): solo con una subida PROPIA.
      this.assertFotoPropia(dto.foto_url, c.authId);
    }
    if (c.rol === Rol.VISITANTE) {
      // El gasto del visitante ES de visita: no se reclasifica ni se liga a
      // vuelo/avión/escala desde su sesión (candado espejo del create).
      dto.categoria = CategoriaGasto.VISITA;
      delete dto.vuelo_id;
      delete dto.aeronave_id;
      delete dto.escala_id;
    }
    return this.expenses.update(id, dto, c.userId);
  }

  @Delete(':id')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.PILOTO, Rol.MECANICO, Rol.VISITANTE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Delete gasto. Oficina siempre; piloto/mecánico solo el suyo del mismo día.',
  })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    if (
      c.rol === Rol.PILOTO ||
      c.rol === Rol.MECANICO ||
      c.rol === Rol.VISITANTE
    ) {
      await this.expenses.assertOwnSameDay(id, c.userId);
    }
    return this.expenses.remove(id, c.rol);
  }
}
