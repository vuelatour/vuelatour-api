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
  StreamableFile,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Rol } from '../../common/types/auth.types';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import {
  AbonosPendientesQuery,
  AutoMatchDto,
  AutoReversosDto,
  CandidatosCobroQuery,
  CargosGastosCandidatosDto,
  ClasificarMovimientoDto,
  CobrosSinBancoQuery,
  ConciliacionParseDto,
  CrearClasificacionDto,
  EmparejarReversoDto,
  GastosCandidatosQuery,
  ImportarMovimientosDto,
  LigarCargosAGastoDto,
  LinkMovimientoCobroDto,
  LinkMovimientoDto,
  LinkMovimientoIngresoDto,
  ListConciliacionQuery,
  loteInvalido,
  OmitirMovimientosDto,
  PaywiseAuditoriaQuery,
  QuitarOmisionDto,
  ReporteConciliacionQuery,
  RevisarOmisionDto,
  SugerirAbonosDto,
  SugerirLoteDto,
} from './dto/conciliacion.dto';
import { ConciliacionService } from './conciliacion.service';
import { MENSAJE_LOTE_AMBOS } from './conciliacion-parcial.util';
import { ROLES_CONCILIACION } from './roles-conciliacion';

@ApiTags('Conciliación')
@ApiBearerAuth()
// ROLES_CONCILIACION = [ADMIN, FACTURACION] (fuente única de «quién ve el
// banco», 13-oct-2026, invariante 71): la metadata queda idéntica.
@Roles(...ROLES_CONCILIACION)
@Controller({ path: 'conciliacion', version: '1' })
export class ConciliacionController {
  constructor(private readonly conciliacion: ConciliacionService) {}

  @Post('parse')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Parsea un estado de cuenta (CSV/Excel/PDF) sin persistir',
  })
  parse(
    @Body() dto: ConciliacionParseDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.conciliacion.parse(dto, c.userId);
  }

  @Post('importar')
  @ApiOperation({
    summary: 'Importa movimientos y auto-concilia los CARGO contra gastos',
  })
  importar(
    @Body() dto: ImportarMovimientosDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.conciliacion.importar(dto, c.userId);
  }

  // CONCEPTO DEL SPEI (13-oct-2026, API 0.0.75, invariante 69): la vista
  // previa de la importación NO escribe nada (ni archiva el archivo). Roles
  // de la clase (ADMIN, FACTURACION); mismo DTO que `importar` (ignora
  // `solo_enriquecer`, `filename` y `file_base64`).
  @Post('importar/vista-previa')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Simula la importación SIN escribir: cuántas líneas ya estaban, a cuántas se les completaría el concepto del banco, gemelos y vínculos que no se completan y las líneas nuevas',
  })
  vistaPrevia(@Body() dto: ImportarMovimientosDto) {
    return this.conciliacion.vistaPreviaImport(dto);
  }

  @Post('importar-async')
  @ApiOperation({
    summary:
      'Importa como JOB del servidor: responde job_id de inmediato y el proceso (dedupe, archivo, insert, auto-conciliación) sigue en backend con progreso consultable — cerrar el navegador no lo corta.',
  })
  importarAsync(
    @Body() dto: ImportarMovimientosDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.conciliacion.importarAsync(dto, c.userId);
  }

  @Get('importar-status/:id')
  @ApiOperation({
    summary:
      'Avance de un job de importación: estado, porcentaje, paso y resultado.',
  })
  importarStatus(@Param('id', ParseUUIDPipe) id: string) {
    return this.conciliacion.importStatus(id);
  }

  // ---- RE-CRUCE e IA en lote (15-sep-2026): rutas LITERALES arriba ----

  @Post('auto-match')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Vuelve a correr el AUTO-CRUCE sobre los movimientos PENDIENTES de la ventana (cargos y abonos): reglas de traspaso, gasto por monto ±1 centavo con desempate por terminación de tarjeta y por descripción, faltante de pagos parciales, TC implícito USD↔MXN y cobros/sobres para los abonos. Nunca liga lo ambiguo. Body opcional {cuenta_bancaria_id?, desde?, hasta?, limite?} (default: últimos 90 días, hora Cancún, 500 movimientos). Después (30-sep-2026) empareja las DEVOLUCIONES del banco con su cargo (criterio REVERSO, misma regla que reversos/auto). Devuelve {revisados, conciliados, traspasos, reversos, reversos_emparejados, ambiguos, sin_candidato, rechazados, errores, por_criterio, detalle[]}.',
  })
  autoMatch(@Body() dto: AutoMatchDto, @CurrentUser() c: AuthenticatedUser) {
    return this.conciliacion.autoMatchPendientes(dto ?? {}, c.userId);
  }

  // ---- REVERSOS (30-sep-2026): cargo devuelto por el banco ↔ su
  // devolución. Roles de la CLASE (ADMIN, FACTURACION: quienes concilian).
  // Sin la migración 20260930000001 ⇒ 503 REVERSOS_NO_DISPONIBLE. ----

  @Post('reversos/auto')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'EMPAREJA SOLAS las devoluciones del banco con su cargo: abonos pendientes cuya leyenda dice CARGO INDEBIDO / DEVOLUCION / REVERSO / CONTRACARGO / ABONO POR ACLARACION / RECLAMACION («REV …» también) contra cargos PENDIENTES y libres (nunca uno ligado a un gasto) de la misma cuenta y el mismo monto en los 60 días previos. Si la leyenda trae la fecha del cargo («21 SEP») manda esa fecha; cargos idénticos del mismo día ⇒ el más antiguo; fechas distintas sin pista ⇒ ambiguo (queda pendiente). Body opcional {cuenta_bancaria_id?, desde?, hasta?} sobre la fecha del ABONO (default: últimos 90 días, hora Cancún). Devuelve {revisados, emparejados, sin_candidato, ambiguos, errores, detalle[{abono_id, cargo_id, resultado, motivo, …}]}.',
  })
  autoReversos(
    @Body() dto: AutoReversosDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.conciliacion.autoReversos(dto ?? {}, c.userId);
  }

  @Post('sugerir-lote')
  @Roles(Rol.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Sugerencias de IA EN LOTE para los CARGOS pendientes de la ventana (ADMIN). La IA PROPONE y jamás liga: devuelve propuestas {movimiento_id, gasto_id_sugerido, confianza, razon, evidencias[], alternativas[]} para confirmar en el panel. Cada movimiento consume créditos: tope 40 (default 15).',
  })
  sugerirLote(
    @Body() dto: SugerirLoteDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.conciliacion.sugerirLote(dto ?? {}, c.userId);
  }

  @Get('reporte.xlsx')
  @ApiOperation({
    summary:
      'Reporte de conciliación en Excel: el estado de cuenta con matrícula por línea, estatus (Conciliado/PENDIENTE), con qué se cruzó y los montos sin conciliar en naranja. Filtro de estado = las 4 pestañas de la página (sin_banco = gastos bancarios que no aparecen en el banco).',
  })
  async reporteXlsx(
    @Query() q: ReporteConciliacionQuery,
  ): Promise<StreamableFile> {
    const { buffer, etiqueta } = await this.conciliacion.reporteXlsx(
      q.cuenta_bancaria_id,
      q.desde,
      q.hasta,
      q.estado,
    );
    // El nombre dice qué filtro se exportó (sin_banco → "gastos-sin-banco").
    const sufijoEstado =
      q.estado !== 'todos' ? `-${q.estado.replace(/_/g, '-')}` : '';
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="conciliacion-${etiqueta}${sufijoEstado}-${q.desde}-a-${q.hasta}.xlsx"`,
    });
  }

  // ---- PAYWISE (9-sep-2026): rutas literales ANTES de movimientos/:id ----

  @Get('paywise/auditoria')
  @ApiOperation({
    summary:
      'Auditoría Paywise (solo lectura): cruza los ABONOS importados de las cuentas PASARELA en el periodo contra los cobros con método PAYWISE (fecha ±días, NETO exacto → BRUTO exacto → referencia). Devuelve coinciden (con diferencia de comisión), en Paywise sin cobro, cobros sin Paywise, referencia con monto distinto y ambiguos.',
  })
  paywiseAuditoria(@Query() q: PaywiseAuditoriaQuery) {
    return this.conciliacion.auditoriaPaywise(q);
  }

  @Post('paywise/auditoria/conciliar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Concilia automáticamente los cruces que CUADRAN (neto/bruto exacto): escribe la comisión real de Paywise en el cobro de vuelo y liga el abono (linkCobro). Devuelve la auditoría recalculada + conciliados_ahora y errores por liga.',
  })
  paywiseConciliar(
    @Query() q: PaywiseAuditoriaQuery,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.conciliacion.conciliarPaywise(q, c.userId);
  }

  @Get('paywise/auditoria.xlsx')
  @ApiOperation({
    summary:
      'Auditoría Paywise en Excel: 3 hojas — Cotejo (bruto/comisión/neto sistema vs Paywise, diferencias en naranja), Paywise sin cobro y Cobros sin Paywise.',
  })
  async paywiseAuditoriaXlsx(
    @Query() q: PaywiseAuditoriaQuery,
  ): Promise<StreamableFile> {
    const { buffer, etiqueta } =
      await this.conciliacion.auditoriaPaywiseXlsx(q);
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="auditoria-${etiqueta}-${q.desde}-a-${q.hasta}.xlsx"`,
    });
  }

  @Get('cobros-sin-banco')
  @ApiOperation({
    summary:
      'Cobros BANCARIOS (transferencia / HSBC link / cheque / Paywise; cobros de vuelo y sobres de grupo) sin liga con ningún abono importado. Espejo de gastos-sin-banco. Default: últimos 90 días por fecha_cobro.',
  })
  cobrosSinBanco(@Query() q: CobrosSinBancoQuery) {
    return this.conciliacion.cobrosSinBanco(q.desde, q.hasta);
  }

  // ---- CONCILIACIÓN DE INGRESOS (24-sep-2026): rutas LITERALES antes de
  // movimientos/:id. Roles de la CLASE (ADMIN, FACTURACION). Sin la
  // migración 20260924000004 ⇒ 503 INGRESOS_NO_DISPONIBLE. ----

  @Get('abonos-pendientes')
  @ApiOperation({
    summary:
      'Abonos del banco sin identificar (default: últimos 90 días, hora Cancún): patrón (traspaso/reverso), qué haría el auto-cruce (motivo_pendiente, candidatos_n), candidatos manuales con el monto exacto (exactos_manual), duplicado probable, cliente y categoría sugeridos. Si una lectura de candidatos falla o se trunca: motivos_calculados=false y los motivos van null.',
  })
  abonosPendientes(@Query() q: AbonosPendientesQuery) {
    return this.conciliacion.abonosPendientes(q);
  }

  @Post('sugerir-abonos')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Sugerencias de IA para los ABONOS pendientes (la IA PROPONE y jamás liga): traspasos, reversos, duplicados y lo que el auto ya cruza salen por REGLA sin gastar créditos; el resto va en lotes de ≤ 10 abonos (≤ 3 llamadas en paralelo). Body {cuenta_bancaria_id?, desde?, hasta?, limite? (1..30, default 20), movimiento_ids? (≤ 30)}.',
  })
  sugerirAbonos(
    @Body() dto: SugerirAbonosDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.conciliacion.sugerirAbonos(dto ?? {}, c.userId);
  }

  @Get('clasificaciones')
  @ApiOperation({
    summary:
      'Catálogo de clasificaciones "sin vuelo" (comisión del banco, impuestos, personal…)',
  })
  clasificaciones() {
    return this.conciliacion.listClasificaciones();
  }

  @Post('clasificaciones')
  @ApiOperation({
    summary:
      'Crea una clasificación (o devuelve la existente con el mismo nombre): el diálogo del panel crea en el mismo espacio.',
  })
  crearClasificacion(
    @Body() dto: CrearClasificacionDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.conciliacion.crearClasificacion(dto.nombre, c.userId);
  }

  @Patch('movimientos/:id/clasificar')
  @ApiOperation({
    summary:
      'Concilia el movimiento por CLASIFICACIÓN (no corresponde a ningún vuelo) con notas; null la quita y vuelve a Pendiente.',
  })
  clasificarMovimiento(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ClasificarMovimientoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.conciliacion.clasificarMovimiento(
      id,
      dto.clasificacion_id ?? null,
      dto.notas,
      c.userId,
      // ENDURECIDO (14-oct-2026, invariante 75): lo que el panel VIO
      // (`undefined` = un panel previo que no lo manda: conducta de siempre).
      { esperado: dto.esperado_clasificacion_id, usuarioNombre: c.nombre },
    );
  }

  // ---- OMITIR LA CONCILIACIÓN (14-oct-2026, API 0.0.77, invariante 75) ----
  // Rutas LITERALES bajo `movimientos/`: van ANTES de `movimientos/:id` y
  // sus sub-rutas (convención). Roles de la CLASE (ROLES_CONCILIACION).

  @Post('movimientos/omitir/revisar')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Revisa una selección antes de omitirla (SOLO LECTURA; funciona aun sin la migración 20261014000002): estado de cada movimiento (PENDIENTE o por qué no lo está) y, de los pendientes, si podría conciliarse de verdad (gasto o cobro que cuadra, traspaso, devolución o «sin verificar»).',
  })
  revisarOmision(@Body() dto: RevisarOmisionDto) {
    return this.conciliacion.revisarOmision(dto.movimiento_ids);
  }

  @Post('movimientos/omitir')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Omite de la conciliación de 1 a 200 movimientos PENDIENTES con un motivo firmado (todo o nada): quedan conciliados con la clasificación «Omitido de la conciliación» y la línea del motivo al inicio de sus notas. Los que tienen aviso se confirman en `aceptar_riesgo_ids`. Se deshace con quitar-omision.',
  })
  omitirMovimientos(
    @Body() dto: OmitirMovimientosDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.conciliacion.omitirMovimientos(dto, c.userId, c.nombre);
  }

  @Post('movimientos/quitar-omision')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Deshace la omisión de 1 a 200 movimientos (todo o nada): vuelven a Pendiente y su nota pierde SOLO la línea de la omisión.',
  })
  quitarOmision(
    @Body() dto: QuitarOmisionDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.conciliacion.quitarOmision(dto.movimiento_ids, c.userId);
  }

  // ---- VARIOS CARGOS → UN GASTO (14-oct-2026, API 0.0.77, invariante 76) ----

  @Post('cargos/gastos-candidatos')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Gastos que podrían pagarse con la SUMA de 2 a 50 cargos pendientes de la misma moneda (SOLO LECTURA): bancarios sin conciliar en la ventana de las fechas de los cargos, ordenados por si la suma los cubre (CUBRE, PARCIAL, EXCEDE). La suma la calcula el API.',
  })
  gastosCandidatosDeCargos(@Body() dto: CargosGastosCandidatosDto) {
    return this.conciliacion.gastosCandidatosDeCargos(dto);
  }

  @Get('estados-cuenta')
  @ApiOperation({
    summary: 'Estados de cuenta importados (archivo original archivado)',
  })
  estadosCuenta(@Query('cuenta_bancaria_id') cuentaBancariaId?: string) {
    return this.conciliacion.listEstadosCuenta(cuentaBancariaId || undefined);
  }

  @Post('estados-cuenta/:id/url')
  @ApiOperation({
    summary: 'URL firmada (1 h) para descargar el archivo importado',
  })
  estadoCuentaUrl(@Param('id', ParseUUIDPipe) id: string) {
    return this.conciliacion.estadoCuentaUrl(id);
  }

  // CONCILIACIÓN AL REVÉS (13-oct-2026, API 0.0.75, invariante 71): roles
  // de la CLASE (ROLES_CONCILIACION). Otro segmento que `gastos-sin-banco`.
  @Get('gastos/:id')
  @ApiOperation({
    summary:
      'Conciliación AL REVÉS de un gasto (13-oct-2026, API 0.0.75, invariante 71): sus cargos del banco (cuenta sin número ni CLABE, leyenda, referencia y lo que cada cargo aporta = monto_parte); el estado de cuenta del que salió o por qué no hay archivo; el lote que paga el cargo con su diferencia; la justificación de un gasto no bancario; quién registró la liga (desde el 2-oct-2026); alertas y, si sigue pendiente, el último día importado por cuenta. Solo lectura. 404 GASTO_NO_EXISTE.',
  })
  conciliacionDeGasto(@Param('id', ParseUUIDPipe) id: string) {
    return this.conciliacion.conciliacionDeGasto(id);
  }

  // VARIOS CARGOS → UN GASTO (14-oct-2026, API 0.0.77, invariante 76): otro
  // MÉTODO que `GET gastos/:id` (no chocan). Todo o nada, por la RPC.
  @Post('gastos/:id/cargos')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Vincula de 2 a 50 cargos pendientes a UN gasto bancario (todo o nada, por la RPC de la migración 20261014000002): la suma no puede pasar del gasto + $1.00; reenviar los mismos cargos es idempotente. `gasto.conciliado` lo recalcula la BD.',
  })
  ligarCargosAGasto(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LigarCargosAGastoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.conciliacion.ligarCargosAGasto(
      id,
      dto.movimiento_ids,
      c.userId,
    );
  }

  @Get('movimientos')
  @ApiOperation({
    summary:
      'Lista movimientos bancarios con su gasto conciliado (gasto.medio_pago y gastos[].medio_pago aditivos, 0.0.63: un gasto en efectivo ligado con justificación se marca en el panel).',
  })
  list(@Query() q: ListConciliacionQuery) {
    return this.conciliacion.list(q);
  }

  @Get('gastos-sin-banco')
  @ApiOperation({
    summary:
      'Gastos BANCARIOS (tarjeta/transferencia/PayWise) que NO aparecen en ningún estado de cuenta: sin conciliar tras los cruces. Incluye los de pago PARCIAL (aditivos monto_vinculado, faltante, parcial). Default: últimos 90 días.',
  })
  gastosSinBanco(
    @Query('desde') desde?: string,
    @Query('hasta') hasta?: string,
  ) {
    return this.conciliacion.gastosSinBanco(desde, hasta);
  }

  @Get('resumen')
  @ApiOperation({
    summary:
      'KPIs de conciliación por cuenta: movimientos, conciliados, pendientes y monto pendiente.',
  })
  resumen(@Query('desde') desde?: string, @Query('hasta') hasta?: string) {
    return this.conciliacion.resumen(desde, hasta);
  }

  @Patch('movimientos/:id')
  @ApiOperation({
    summary:
      'Vincula o desvincula un movimiento con uno o VARIOS gastos. PAGOS PARCIALES (14-sep-2026): un gasto admite VARIOS cargos de su MISMA moneda mientras la suma no rebase su monto (+1.00 de tolerancia); moneda distinta (gasto USD ↔ cuenta MXN) sigue siendo 1 ↔ 1. LOTE (2-oct-2026): `gasto_ids` (2..50) = un cargo que paga varios gastos; cada gasto entra por lo que le falta y la suma debe cuadrar con el cargo (tolerancia 0.01 × N, mínimo 0.02 y máximo 1.00). `gasto_id: null` desliga TODO (también un lote). `gasto_ids` y `gasto_id` juntos ⇒ 400 LOTE_INVALIDO. `gasto.conciliado` lo recalcula la BD: parcial ⇒ sigue en gastos-sin-banco. Respuesta ADITIVA: gastos_estado[] y, con UNA parte, gasto_conciliado, monto_vinculado, faltante (null al desvincular o con varias). 409: GASTO_YA_CUBIERTO (details {motivo, monto_gasto, suma_ligada, faltante, gasto_id, movimientos[]}), CARGO_NO_CUADRA, LOTE_MONEDA_DISTINTA, MOVIMIENTO_CON_LOTE, MOVIMIENTO_YA_LIGADO, REVERSO_INVALIDO, CARGO_EXCEDIDO, LOTE_SOLO_API_NUEVO; 503 CONCILIACION_PARTES_NO_DISPONIBLE con varios gastos sin la migración. GASTO NO BANCARIO (6-oct-2026, 0.0.63): un gasto en EFECTIVO o PERSONAL_* que ENTRA a la liga exige `justificacion` (10–300) ⇒ si falta, 400 JUSTIFICACION_REQUERIDA {details.gastos_no_bancarios[{id, medio_pago, fecha_gasto, monto}]}; BODEGA ⇒ 409 GASTO_BODEGA {details.gastos_bodega[]}. Con ella la liga procede igual (no cambia medio_pago ni verificado) y se anota en las notas del cargo y del gasto; desvincular retira esas líneas. Respuesta ADITIVA: gastos_estado[].medio_pago y, si entró un gasto no bancario, vinculo_no_bancario {gasto_ids, notas_anotadas}.',
  })
  link(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LinkMovimientoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    if (loteInvalido(dto)) {
      throw new BadRequestException({
        message: MENSAJE_LOTE_AMBOS,
        error: 'LOTE_INVALIDO',
      });
    }
    // Gasto no bancario (6-oct-2026): la razón y quién la escribió van a
    // las notas del cargo y del gasto.
    const vinculo = {
      justificacion: dto.justificacion ?? null,
      usuarioNombre: c.nombre,
    };
    if (Array.isArray(dto.gasto_ids)) {
      return this.conciliacion.linkGastos(id, dto.gasto_ids, c.userId, vinculo);
    }
    return this.conciliacion.link(id, dto.gasto_id ?? null, c.userId, vinculo);
  }

  @Get('movimientos/:id/gastos-candidatos')
  @ApiOperation({
    summary:
      'Gastos que podrían pagar este CARGO (uno o varios): bancarios, sin conciliar (los de pago parcial con su faltante), en la moneda de la cuenta y a ±dias (default 30, 1..180) de la fecha del cargo; en cuenta MXN y sin búsqueda también los USD con T.C. implícito 15–25 (cruzado: true, solo 1 a 1). q: monto entero ⇒ [q, q+1), con decimales ⇒ ±0.01; texto ⇒ proveedor, nota, lugar o folio del ticket. Orden: los que cuadran con el cargo, cercanía de monto, cercanía de fecha, fecha desc. Respuesta {movimiento {id, fecha, monto, moneda}, ventana {desde, hasta}, candidatos[], truncado}; con candidatos[] VACÍO también excluidos[{motivo EFECTIVO_U_OTRO_MEDIO | YA_CONCILIADO | OTRA_MONEDA | FUERA_DE_VENTANA, n, gastos[≤5]}] y excluidos_monto (gastos del mismo monto ±0.01 —el de q si es numérico— a ±max(120, dias) que no entraron y por qué; aditivos, 0.0.63). incluir_no_bancarios=true|1 (0.0.63): el universo suma los gastos en EFECTIVO / PERSONAL_* (nunca BODEGA) con las mismas reglas, DESPUÉS de los bancarios; cada candidato lleva no_bancario (boolean) y, con la bandera, excluidos ya no los cuenta como EFECTIVO_U_OTRO_MEDIO. CRUCE USD (0.0.75, invariante 70): en cuentas MXN los gastos USD bancarios sin conciliar en banda del cargo salen con CUALQUIER búsqueda (vacía, texto o monto: por su monto en dólares o por su equivalente en pesos ÷ T.C. oficial del día del cargo ±3 %), cada uno con cruzado: true y tc_cruce {tc_implicito, en_banda, tc_oficial, tc_oficial_fecha, tc_oficial_fuente, desvio_pct, nivel CERCA | LEJOS | SIN_OFICIAL, tolerancia_pct, fuera_de_lugar, texto, titulo}; orden de 7 niveles (bancarios que cuadran · cruzados CERCA · no bancarios que cuadran · resto de bancarios · cruzados SIN_OFICIAL · cruzados LEJOS · resto de no bancarios); la raíz tc_oficial {tc, fecha_dato, fuente} | null viaja SIEMPRE. CONCEPTO DEL SPEI (0.0.75, invariante 69): si el concepto del cargo cita una factura, cada candidato lleva coincide_factura y la respuesta factura_concepto {tipo, numeros, texto, pista, otros_gastos}. 400 SOLO_CARGOS en un abono; 503 CONCILIACION_PARTES_NO_DISPONIBLE sin la migración.',
  })
  gastosCandidatos(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: GastosCandidatosQuery,
  ) {
    return this.conciliacion.gastosCandidatosDeMovimiento(id, q);
  }

  @Patch('movimientos/:id/cobro')
  @ApiOperation({
    summary:
      'Vincula o desvincula un ABONO con un cobro de vuelo (cobro_id) O con el SOBRE de un grupo (cobro_grupo_id), excluyentes; ambos null = desvincular (también un lote). Una parte de sobre responde 409 COBRO_DE_GRUPO. 1 ABONO ↔ N COBROS (12-oct-2026, 0.0.71): `cobro_ids` (1..50) = los cobros de vuelo que paga este abono; con 2+ todos en la moneda de la cuenta y Σ de lo que le FALTA a cada uno (0.0.78) = abono ± tolerancia (1 ¢ por cobro, 0.02–1.00). UN COBRO, VARIOS ABONOS (0.0.78, invariante 77): un abono MENOR que lo que le falta al cobro lo deja PARCIAL (sin bandera); `corregir_comision: true` (UN cobro de vuelo sin abonos) escribe antes la comisión real (monto − depósito). Respuesta ADITIVA (con la puente, SIEMPRE): la fila releída + cobros_n y cobros_estado[{cobro_id, monto_parte, vuelo_id, folio, cliente, monto, neto, cobro_estado, cobro_neto, cobro_monto_vinculado, cobro_faltante, cobro_abonos_n}]; al desvincular cobros_liberados[{cobro_id, folio, estado, faltante, abonos_n}]; con la corrección comision_corregida {cobro_id, antes, despues}. 409: ABONO_EXCEDE_COBRO {…, excedente, un_solo, sugeridos[≤ 3]}, COMISION_NO_CUADRA {…, comision_real, comision_real_pct, por, corregible}, COBRO_MONEDA_DISTINTA {motivo TC_FUERA_DE_BANDA | TC_LEJOS, tc_implicito, tc_referencia, desvio_pct}, COBRO_YA_CONCILIADO {motivo CUBIERTO | UN_SOLO_ABONO, por}, SOBRE_NO_CUADRA {monto_abono, neto_sobre, diferencia}, ABONO_NO_CUADRA {monto_abono, suma_cobros, diferencia, tolerancia, cobros[]}, LOTE_MONEDA_DISTINTA, COBRO_DE_GRUPO, COBRO_DE_ANTICIPO, COBRO_INVALIDO, MOVIMIENTO_YA_LIGADO, MOVIMIENTO_CON_LOTE (cobro_id suelto sobre un lote), MOVIMIENTO_OMITIDO, REVERSO_INVALIDO; 400 LOTE_INVALIDO, SOLO_ABONOS, CORREGIR_COMISION_NO_APLICA {motivo VARIOS_COBROS | SOBRE | CON_ABONOS | DEPOSITO_MAYOR | SIN_COBRO | MONEDA_DISTINTA | DEPOSITO_INVALIDO}; 503 CONCILIACION_COBROS_NO_DISPONIBLE con 2+ sin la migración de 0.0.71, CONCILIACION_COBROS_PARCIALES_NO_DISPONIBLE (el 2.º abono de un cobro parcial sin 20261014000003) y CUENTA_SIN_MONEDA.',
  })
  linkCobro(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LinkMovimientoCobroDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.conciliacion.linkCobro(
      id,
      {
        cobro_id: dto.cobro_id ?? null,
        cobro_grupo_id: dto.cobro_grupo_id ?? null,
        ...(Array.isArray(dto.cobro_ids) ? { cobro_ids: dto.cobro_ids } : {}),
        // 0.0.78 (invariante 77): solo viaja cuando es true.
        ...(dto.corregir_comision === true ? { corregir_comision: true } : {}),
      },
      c.userId,
    );
  }

  @Patch('movimientos/:id/ingreso')
  @ApiOperation({
    summary:
      'Vincula o desvincula (ingreso_id null) un ABONO con un INGRESO registrado (1 ↔ 1, excluyente con gasto/cobro/sobre/clasificación). 409 MOVIMIENTO_YA_LIGADO / INGRESO_YA_CONCILIADO / INGRESO_OTRA_CUENTA / INGRESO_MONEDA_DISTINTA / INGRESO_MONTO_DISTINTO (±1.00) / INGRESO_SIN_CUENTA / INGRESO_DADO_DE_BAJA; 400 SOLO_ABONOS. Respuesta: movimiento + ingreso.',
  })
  linkIngreso(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LinkMovimientoIngresoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.conciliacion.linkIngreso(id, dto.ingreso_id ?? null, c.userId);
  }

  @Get('movimientos/:id/reverso-candidatos')
  @ApiOperation({
    summary:
      'Candidatos para emparejar un movimiento PENDIENTE como cargo devuelto ↔ devolución. `:id` ABONO ⇒ cargos pendientes y libres de la misma cuenta y monto de los 60 días previos (fecha desc). `:id` CARGO ⇒ abonos pendientes de la misma cuenta y monto de los 60 días siguientes (leyenda de devolución primero). Cada uno {id, fecha, descripcion, referencia, monto, tipo, es_devolucion, sugerido}; lista vacía = no hay. 409 MOVIMIENTO_YA_LIGADO si el movimiento ya está conciliado.',
  })
  reversoCandidatos(@Param('id', ParseUUIDPipe) id: string) {
    return this.conciliacion.candidatosReverso(id);
  }

  @Post('movimientos/:id/reverso')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Empareja el ABONO `:id` con el CARGO `cargo_id` que devuelve (también acepta `:id` = cargo con `abono_id`). Los dos quedan CONCILIADOS con la clasificación «Reverso de un cargo» y una nota que nombra al otro («Devuelve el cargo del 21-09 · …» / «Devuelto el 23-09 · …»). Respuesta {abono, cargo, idempotente}. 409 REVERSO_INVALIDO (details.motivo) si no es un par válido: tipos, cuenta, monto, alguno ya conciliado o el cargo ya devuelto; 404 si alguno no existe.',
  })
  emparejarReverso(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EmparejarReversoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    // Los dos a la vez es ambiguo: antes se usaba `cargo_id` en silencio.
    if (dto.cargo_id && dto.abono_id) {
      throw new BadRequestException({
        message:
          'Indica el cargo (cargo_id) O el abono (abono_id), no los dos.',
        error: 'REVERSO_SIN_PAR',
      });
    }
    return this.conciliacion.emparejarReverso(
      id,
      dto.cargo_id ?? dto.abono_id ?? null,
      c.userId,
    );
  }

  @Delete('movimientos/:id/reverso')
  @ApiOperation({
    summary:
      'Quita el emparejamiento cargo devuelto ↔ devolución (`:id` = el abono O el cargo): los DOS vuelven a PENDIENTE (sin clasificación) y se quitan de sus notas los renglones del emparejado. 404 SIN_REVERSO si no está emparejado. Respuesta {abono, cargo}.',
  })
  desemparejarReverso(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.conciliacion.desemparejarReverso(id, c.userId);
  }

  @Get('movimientos/:id/candidatos-cobro')
  @ApiOperation({
    summary:
      'Candidatos para conciliar un ABONO a mano: cobros de vuelo (COBRO_VUELO) y sobres de grupo (SOBRE_GRUPO) de la moneda de la cuenta, métodos bancarios, sin conciliar con otro movimiento, ordenados por cercanía del NETO al monto. Las partes de un sobre nunca se ofrecen. UN COBRO, VARIOS ABONOS (0.0.78, invariante 77): con la migración 20261014000003 un cobro PARCIAL sigue siendo candidato (parcial, monto_vinculado, faltante, abonos_n, abonos[] y dif_monto contra lo que le falta; un abono de la PASARELA no recibe parciales); cada candidato trae al_vincular (cobro: {estado CONCILIADO | PARCIAL | EXCEDE | COMISION_NO_CUADRA | YA_CUBIERTO | UN_SOLO_ABONO | MONEDA_DISTINTA, faltante_antes, faltante_despues, sobrante, comision_real, tc_implicito, tc_referencia, desvio_pct, motivo, un_solo, sugeridos[≤ 3] en EXCEDE}; sobre: {estado CONCILIADO | SOBRE_NO_CUADRA, diferencia}); un sugerido que no entró en los 60 va al final. movimiento + cobros_parciales, tipo_cuenta y corregir_comision (capacidades).',
  })
  candidatosCobro(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: CandidatosCobroQuery,
  ) {
    return this.conciliacion.candidatosCobro(id, q.dias);
  }

  @Post('movimientos/:id/sugerir')
  @Roles(Rol.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Sugiere por IA el gasto más probable para un movimiento sin conciliar y ambiguo (ADMIN). Contexto rico (referencia, moneda de la cuenta, terminación de tarjeta detectada; por candidato: lugar, primera línea de notas, categoría, tarjeta, matrícula, vuelo y faltante). Respuesta ADITIVA: evidencias[], alternativas[], terminacion_detectada. Best-effort: disponible=false si la IA no está disponible. NUNCA liga.',
  })
  sugerir(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.conciliacion.sugerir(id, c.userId);
  }
}
